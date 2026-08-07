-- ============================================================================
-- Migration 9 : Rolling week lifecycle (F2) + manager-only archive (F4)
--
-- F2 -- the three seeded weeks were test scaffolding, one per code path
-- (locked / open / target-3), never a product model. The real shape is a
-- rolling pair: the week being worked now, and the week open for submissions.
-- ensure_roster_weeks() creates whatever is missing, so a week never has to be
-- hand-inserted again.
--
-- F4 -- past weeks stay stored but become manager-only. Enforced here in RLS
-- rather than by hiding a route, because a guard holding the publishable key
-- can query PostgREST directly. The cut is absolute: a guard sees nothing from
-- a past week, not even their own shifts.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The Sunday that starts the week containing p_day, in Asia/Jerusalem.
-- Timezone matters: at 23:00 on a Saturday in Israel it is still the previous
-- week in UTC, and rolling a week over a day early would hide the live roster.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_week_start()
RETURNS DATE
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (d - EXTRACT(DOW FROM d)::INT)::DATE
    FROM (SELECT (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE AS d) t;
$$;

GRANT EXECUTE ON FUNCTION public.current_week_start() TO authenticated;


-- ----------------------------------------------------------------------------
-- Deadline for a week: the Wednesday before it, at 19:00 Asia/Jerusalem.
-- Built from the local wall clock so it stays correct across the IDT/IST
-- changeover instead of assuming a fixed +03 offset.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deadline_for_week(p_week_start DATE)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT ((p_week_start - 4)::TEXT || ' 19:00:00')::TIMESTAMP
           AT TIME ZONE 'Asia/Jerusalem';
$$;

GRANT EXECUTE ON FUNCTION public.deadline_for_week(DATE) TO authenticated;


-- ----------------------------------------------------------------------------
-- ensure_roster_weeks()
--
-- Idempotent. Guarantees the current week and the next week both exist, and
-- closes any week whose deadline has passed. Safe to call on every dashboard
-- load; it only ever adds the missing rows.
--
-- New weeks inherit the morning target of the most recent week, so a manager
-- who runs at 3 does not silently drop back to 2 every Sunday.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_roster_weeks()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current DATE := public.current_week_start();
  v_next    DATE := v_current + 7;
  v_target  INT;
BEGIN
  SELECT morning_target_slots INTO v_target
    FROM roster_weeks ORDER BY week_start DESC LIMIT 1;
  v_target := COALESCE(v_target, 2);

  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (v_current, v_target, public.deadline_for_week(v_current), 'locked')
  ON CONFLICT (week_start) DO NOTHING;

  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (v_next, v_target, public.deadline_for_week(v_next), 'open')
  ON CONFLICT (week_start) DO NOTHING;

  -- A week whose deadline has passed is closed to guards. Published weeks are
  -- left alone so publication is not undone by a later sweep.
  UPDATE roster_weeks
     SET status = 'locked'
   WHERE status = 'open'
     AND submission_deadline <= NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;


-- Bring the existing rows onto the new deadline rule (Wednesday 19:00), which
-- the seed could not do because it uses ON CONFLICT DO NOTHING.
UPDATE roster_weeks
   SET submission_deadline = public.deadline_for_week(week_start)
 WHERE submission_deadline <> public.deadline_for_week(week_start);

-- Retire the target-3 scaffolding week. That path lives in the test suites now.
DELETE FROM roster_weeks WHERE week_start = '2026-08-23';

SELECT public.ensure_roster_weeks();


-- ============================================================================
-- F4 : manager-only archive
-- ============================================================================

-- Guards may only see a roster for the current week or later. Managers see all
-- history. Replaces the previous "any published run" policy.
DROP POLICY IF EXISTS runs_read ON schedule_runs;

CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated
  USING (
    is_manager()
    OR (is_published AND week_start >= public.current_week_start())
  );

-- schedule_assignments already inherits visibility through this EXISTS, so
-- recreating it against the new runs_read is enough -- but it is restated here
-- so the archive rule is readable in one place rather than implied.
DROP POLICY IF EXISTS assign_read ON schedule_assignments;

CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM schedule_runs r
      WHERE r.id = schedule_assignments.run_id
        AND (
          is_manager()
          OR (r.is_published AND r.week_start >= public.current_week_start())
        )
    )
  );

-- Past weeks themselves stay readable: a guard needs the row to render dates
-- for the current week, and roster_weeks holds no personal data. What is
-- restricted is the roster, which is where the assignments live.
