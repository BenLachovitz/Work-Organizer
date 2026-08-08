-- ============================================================================
-- Migration 29 : Bound migration 28's sweep to a realistic window
--
-- Migration 28 dropped the (v_current, v_next) scope entirely, reconciling
-- EVERY roster_weeks row with status_overridden_at IS NULL against its own
-- window. That is too broad: it also swept rows that have nothing to do
-- with the admin cursor at all -- test suites create their own throwaway
-- fixture weeks (rls.cloud.test.mjs's OPEN_WEEK, 2026-10-04; LOCKED_WEEK,
-- 2026-10-11; manager.cloud.test.mjs's WEEK, 2026-09-06) with their own
-- deadlines and statuses that intentionally do not match what
-- opens_for_week()/deadline_for_week() would compute for those dates.
--
-- Caught in exactly the way this was designed to catch orphaned real weeks:
-- a `db:apply` run (whose trailing `SELECT ensure_roster_weeks()` fires on
-- every migration touching that function) swept a leftover OPEN_WEEK row
-- from an earlier, not-yet-cleaned-up test run from 'open' to 'locked',
-- because 2026-10-04 is two months past admin_current_week_start() and its
-- own opens_for_week() is therefore still far in the future. The next test
-- run's `ON CONFLICT (week_start) DO NOTHING` insert then left it stuck
-- locked, and "guard CAN submit while the week is open" failed.
--
-- Fix: bound the sweep to a window around the REAL calendar week
-- (current_week_start() -- stable, calendar-only, unaffected by settings
-- changes, unlike the admin cursor being reconciled). The window only needs
-- to be wide enough to cover every week the admin cursor could ever
-- legitimately point at: admin_current_week_start()'s formula shifts by
-- (open_offset_days - 7) days, and open_offset_days is CHECK-constrained to
-- [1, 20] (migration 22), so v_next can range from roughly real-current to
-- real-current + 20 days. `-7 .. +28` (5 weeks) covers that with comfortable
-- margin on both sides while staying nowhere near the two-months-out test
-- fixtures.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_roster_weeks()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current DATE := public.admin_current_week_start();
  v_next    DATE := v_current + 7;
  v_target  INT;
  v_real    DATE := public.current_week_start();
BEGIN
  SELECT default_morning_target_slots INTO v_target
    FROM scheduler_settings WHERE id;

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

  -- Keep every untouched, in-range week's deadline in step with live
  -- settings -- not just v_next (migration 27), but bounded to a realistic
  -- window around the real calendar week (migration 29), not the whole
  -- table (migration 28's mistake -- see header). v_current excluded: it is
  -- always already past its own deadline by construction.
  UPDATE roster_weeks w
     SET submission_deadline = public.deadline_for_week(w.week_start)
   WHERE w.week_start <> v_current
     AND w.week_start BETWEEN v_real - 7 AND v_real + 28
     AND w.status_overridden_at IS NULL
     AND w.status NOT IN ('generated', 'published');

  -- Reconcile every in-range week's open/locked status against its own
  -- window -- bounded the same way, for the same reason.
  UPDATE roster_weeks w
     SET status = 'locked'
   WHERE w.status = 'open'
     AND w.week_start BETWEEN v_real - 7 AND v_real + 28
     AND w.status_overridden_at IS NULL
     AND NOT (NOW() >= public.opens_for_week(w.week_start) AND NOW() < w.submission_deadline);

  UPDATE roster_weeks w
     SET status = 'open'
   WHERE w.status = 'locked'
     AND w.week_start BETWEEN v_real - 7 AND v_real + 28
     AND w.status_overridden_at IS NULL
     AND NOW() >= public.opens_for_week(w.week_start)
     AND NOW() <  w.submission_deadline;

  -- Seed this week's כמות from each guard's baseline, wherever it is missing.
  INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
  SELECT wk.week_start, p.id, p.default_kamut
    FROM (VALUES (v_current), (v_next)) AS wk(week_start)
    CROSS JOIN profiles p
   WHERE p.is_active
  ON CONFLICT (week_start, guard_id) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;

SELECT public.ensure_roster_weeks();
