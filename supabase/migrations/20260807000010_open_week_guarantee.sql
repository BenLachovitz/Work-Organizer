-- ============================================================================
-- Migration 10 : Guarantee a week is always open for submissions
--
-- Migration 9 created "current + next". That is right for most of the week but
-- leaves a gap: the deadline for week N falls on the Wednesday of week N-1, so
-- from Wednesday 19:00 until the week rolls over, week N is locked and guards
-- have nothing they can submit for.
--
-- The rule that actually holds is "exactly one week is open": walk forward from
-- the current week until reaching one whose deadline is still in the future.
-- Most of the time that is next week and the live set is a pair; for the back
-- half of each week it is a trio, which is inherent to a mid-week deadline
-- rather than a defect.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_roster_weeks()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current DATE := public.current_week_start();
  v_target  INT;
  v_probe   DATE;
BEGIN
  -- Inherit the most recent morning target so a manager running at 3 does not
  -- silently drop back to 2 every Sunday.
  SELECT morning_target_slots INTO v_target
    FROM roster_weeks ORDER BY week_start DESC LIMIT 1;
  v_target := COALESCE(v_target, 2);

  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (v_current, v_target, public.deadline_for_week(v_current), 'locked')
  ON CONFLICT (week_start) DO NOTHING;

  -- Walk forward until a week whose submission window is still open exists.
  -- Bounded so a clock problem cannot spin this into creating weeks forever.
  v_probe := v_current + 7;
  FOR _i IN 1..4 LOOP
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
    VALUES (
      v_probe,
      v_target,
      public.deadline_for_week(v_probe),
      -- Explicit cast: a CASE yields `text`, and Postgres will not implicitly
      -- coerce that to the week_status enum.
      (CASE WHEN public.deadline_for_week(v_probe) > NOW() THEN 'open' ELSE 'locked' END)::week_status
    )
    ON CONFLICT (week_start) DO NOTHING;

    EXIT WHEN public.deadline_for_week(v_probe) > NOW();
    v_probe := v_probe + 7;
  END LOOP;

  -- Close any week whose window has passed. Published weeks are untouched so a
  -- later sweep cannot undo publication.
  UPDATE roster_weeks
     SET status = 'locked'
   WHERE status = 'open'
     AND submission_deadline <= NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;


-- ----------------------------------------------------------------------------
-- Retire the target-3 scaffolding week -- but only if it is genuinely empty.
-- A DELETE here cascades to submissions, preferences and rosters, so it refuses
-- rather than destroying anything somebody actually entered.
-- ----------------------------------------------------------------------------
DELETE FROM roster_weeks w
 WHERE w.week_start = '2026-08-23'
   AND NOT EXISTS (SELECT 1 FROM weekly_submissions      s WHERE s.week_start = w.week_start)
   AND NOT EXISTS (SELECT 1 FROM weekly_wish_preferences p WHERE p.week_start = w.week_start)
   AND NOT EXISTS (SELECT 1 FROM weekly_guard_targets    g WHERE g.week_start = w.week_start)
   AND NOT EXISTS (SELECT 1 FROM schedule_runs           r WHERE r.week_start = w.week_start);

SELECT public.ensure_roster_weeks();
