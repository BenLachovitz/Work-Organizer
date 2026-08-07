-- ============================================================================
-- Migration 11 : Saturday-evening opening, exactly two live weeks, and a
--                reopen button that actually reopens
--
-- Three problems, one root cause: the automatic sweep was allowed to overrule
-- the manager.
--
-- BUG -- "פתח הגשות מחדש" did nothing on an auto-locked week. It was broken
-- twice over:
--   1. ensure_roster_weeks() runs on every dashboard load and re-locks any week
--      whose deadline has passed, undoing the manager's change immediately.
--   2. Even had it stuck, is_week_open() also requires NOW() < deadline. With
--      the deadline already past, guards could not have submitted anyway.
-- Reopening therefore has to EXTEND THE DEADLINE, not just flip a flag -- and
-- a manager's decision has to survive the next sweep. Same lesson as migration
-- 6: an automatic rule must never silently overrule a human one.
--
-- WINDOW -- submissions for a week now open on the Saturday evening before the
-- preceding week begins, at 20:00, and close Wednesday 19:00:
--
--     week W starts Sunday
--     opens   Saturday (W-8) 20:00
--     closes  Wednesday (W-4) 19:00
--
--   For W = Sun 16 Aug: opens Sat 8 Aug 20:00, closes Wed 12 Aug 19:00.
--   So next week's window is already open when the current week begins and
--   shuts on the Wednesday -- which is what keeps exactly two weeks live.
-- ============================================================================

-- A manager's status change is stamped here, and the sweep leaves such weeks
-- alone from then on.
ALTER TABLE roster_weeks ADD COLUMN IF NOT EXISTS status_overridden_at TIMESTAMPTZ;

COMMENT ON COLUMN roster_weeks.status_overridden_at IS
  'Set when a manager changes status by hand. ensure_roster_weeks() skips these.';


-- ----------------------------------------------------------------------------
-- When submissions open for a week: the Saturday 8 days before it starts, 20:00.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.opens_for_week(p_week_start DATE)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT ((p_week_start - 8)::TEXT || ' 20:00:00')::TIMESTAMP
           AT TIME ZONE 'Asia/Jerusalem';
$$;

GRANT EXECUTE ON FUNCTION public.opens_for_week(DATE) TO authenticated;


-- ----------------------------------------------------------------------------
-- set_week_status -- the manager's explicit override.
--
-- Reopening a week whose deadline has passed extends that deadline, because the
-- deadline is what actually gates guard writes. Without this the button flips a
-- flag that changes nothing observable.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_week_status(
  p_week_start    DATE,
  p_status        week_status,
  p_extend_hours  INT DEFAULT 24
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deadline TIMESTAMPTZ;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT submission_deadline INTO v_deadline
    FROM roster_weeks WHERE week_start = p_week_start;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown week %', p_week_start USING ERRCODE = '22023';
  END IF;

  IF p_status = 'open' AND v_deadline <= NOW() THEN
    v_deadline := NOW() + make_interval(hours => GREATEST(p_extend_hours, 1));
  END IF;

  UPDATE roster_weeks
     SET status = p_status,
         submission_deadline = v_deadline,
         status_overridden_at = NOW()
   WHERE week_start = p_week_start;

  RETURN v_deadline;
END;
$$;

REVOKE ALL ON FUNCTION public.set_week_status(DATE, week_status, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_week_status(DATE, week_status, INT) TO authenticated;


-- ----------------------------------------------------------------------------
-- ensure_roster_weeks -- exactly two live weeks, and hands off anything a
-- manager has touched.
--
-- Only the current week and the next one are created or adjusted. Earlier
-- versions walked forward until they found an open window, which produced a
-- third live week for part of every cycle.
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

  -- The week in progress. Its own submission window closed long ago.
  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (v_current, v_target, public.deadline_for_week(v_current), 'locked')
  ON CONFLICT (week_start) DO NOTHING;

  -- The week being filled in. Open only once its Saturday 20:00 has arrived.
  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (
    v_next,
    v_target,
    public.deadline_for_week(v_next),
    (CASE
       WHEN NOW() >= public.opens_for_week(v_next)
        AND NOW() <  public.deadline_for_week(v_next) THEN 'open'
       ELSE 'locked'
     END)::week_status
  )
  ON CONFLICT (week_start) DO NOTHING;

  -- Keep the two live weeks in step with their windows -- but never touch a
  -- week a manager has decided about, and never a generated or published one.
  UPDATE roster_weeks w
     SET status = 'open'
   WHERE w.week_start IN (v_current, v_next)
     AND w.status = 'locked'
     AND w.status_overridden_at IS NULL
     AND NOW() >= public.opens_for_week(w.week_start)
     AND NOW() <  w.submission_deadline;

  UPDATE roster_weeks w
     SET status = 'locked'
   WHERE w.week_start IN (v_current, v_next)
     AND w.status = 'open'
     AND w.status_overridden_at IS NULL
     AND w.submission_deadline <= NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;

SELECT public.ensure_roster_weeks();
