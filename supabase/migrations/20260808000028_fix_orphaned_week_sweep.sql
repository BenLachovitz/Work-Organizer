-- ============================================================================
-- Migration 28 : Fix orphaned weeks left open after an admin-cursor reversal
--
-- Bug (Ben, 8 August): changed the submission-window open-time to an
-- already-past time to verify the admin cursor (migration 26) advances --
-- it did, correctly. Then changed the open-time to a future time (today
-- 23:00), expecting the cycle to reverse. Instead the week that had been
-- auto-opened while the cursor was briefly advanced (2026-08-16) stayed
-- 'open' and kept accepting submissions, sitting in the manager's archive
-- view rather than the live pair.
--
-- Root cause: admin_current_week_start() is NOT guaranteed to move only
-- forward -- changing open_time to a LATER time-of-day after it had already
-- advanced moves the cursor back. current_week_start() (the pre-migration-26
-- calendar-only cursor RLS still uses) never had this problem; it is
-- monotonic by construction. But ensure_roster_weeks()'s open/lock sweep was
-- still scoped to `w.week_start IN (v_current, v_next)` -- the two weeks
-- CURRENTLY tracked. The moment a week falls out of that pair (because the
-- cursor reverted), the sweep never looks at it again: it is frozen at
-- whatever status it had the instant it was excluded. Since it had just been
-- auto-opened, it stayed open forever.
--
-- Fix: stop scoping the sweep (and migration 27's deadline refresh) to
-- (v_current, v_next) at all. Reconcile EVERY eligible row -- gated only on
-- status_overridden_at IS NULL (nothing a manager decided) and, for the
-- deadline refresh, week_start <> v_current (the week already in progress
-- has nothing meaningful left to refresh -- its submission phase is over by
-- construction). This is safe precisely because each week's own
-- opens_for_week()/deadline_for_week()/submission_deadline math is
-- self-contained: a genuinely finished week's deadline is in the past no
-- matter how broad the WHERE clause is, so it can never satisfy "should be
-- open" regardless of scope. The (v_current, v_next) restriction was never
-- load-bearing for correctness -- it just left this exact gap once the
-- cursor could move backward.
--
-- Also fixes a second, related gap the old lock-sweep condition had: it only
-- ever checked `submission_deadline <= NOW()`, never
-- `NOW() < opens_for_week(week_start)`. That was fine when the only way a
-- week left its open window was time passing forward past its deadline --
-- but now the open-time itself can move INTO the future relative to a
-- week that is already open (exactly what Ben did), and the old condition
-- had no way to catch that. The new condition re-checks the FULL window
-- (`NOT (opens <= NOW() < deadline)`), matching what already gates the
-- INSERT and the open-sweep.
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

  -- Keep every untouched week's deadline in step with live settings -- not
  -- just v_next (migration 27). A week that was briefly v_next, got
  -- auto-opened, then fell out of the tracked pair when the admin cursor
  -- moved on must keep tracking live settings too, or the sweep below would
  -- be reconciling it against a stale deadline forever. v_current excluded:
  -- it is always already past its own deadline by construction, nothing
  -- meaningful to refresh.
  UPDATE roster_weeks w
     SET submission_deadline = public.deadline_for_week(w.week_start)
   WHERE w.week_start <> v_current
     AND w.status_overridden_at IS NULL
     AND w.status NOT IN ('generated', 'published');

  -- Reconcile EVERY eligible week's open/locked status against its own
  -- window -- not just (v_current, v_next). See the migration header for
  -- why the old pair-scoped sweep left a week stuck open once the admin
  -- cursor moved past it, and why dropping that scope is safe.
  UPDATE roster_weeks w
     SET status = 'locked'
   WHERE w.status = 'open'
     AND w.status_overridden_at IS NULL
     AND NOT (NOW() >= public.opens_for_week(w.week_start) AND NOW() < w.submission_deadline);

  UPDATE roster_weeks w
     SET status = 'open'
   WHERE w.status = 'locked'
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
