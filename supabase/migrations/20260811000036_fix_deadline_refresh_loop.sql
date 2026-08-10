-- ============================================================================
-- Migration 36 : Fix a live realtime feedback loop in ensure_roster_weeks()
--
-- Migration 29's "keep every untouched week's deadline live against
-- scheduler_settings" UPDATE (the block right after the v_next INSERT) has
-- no guard checking whether the computed deadline actually differs from what
-- is already stored -- it unconditionally rewrites submission_deadline for
-- every in-window, non-overridden, non-terminal week on EVERY call, even
-- when the value doesn't change at all.
--
-- Postgres still performs a physical row UPDATE for a same-value SET, and
-- Realtime broadcasts that as a genuine UPDATE event regardless of whether
-- any column actually changed. useRosterRealtime (src/hooks/useRosterRealtime.ts)
-- subscribes to roster_weeks UPDATEs for whichever week is on screen and
-- reacts by invalidating the roster_weeks query, which re-runs
-- ensure_roster_weeks() (useRosterWeeks() calls it at the top of its
-- queryFn) -- which performs the same no-op UPDATE again, broadcasts again,
-- and invalidates again. Forever, for as long as a manager has the dashboard
-- open with realtime connected: caught live testing this branch (opening
-- /manage against the real project fired ensure_roster_weeks() roughly every
-- 100ms, hammering the database with zero user action).
--
-- Fix: only write when the value genuinely changes, the same idempotence
-- discipline every other write in this function already follows (the two
-- status-reconciliation UPDATEs right below it already guard on `status =`
-- for exactly this reason).
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
  -- settings -- bounded the same way migration 29 already bounds it, PLUS
  -- (migration 36) only writing when the computed deadline actually differs
  -- from what's stored, so an unchanged value is a genuine no-op rather than
  -- a same-value UPDATE that still broadcasts a realtime event.
  UPDATE roster_weeks w
     SET submission_deadline = public.deadline_for_week(w.week_start)
   WHERE w.week_start <> v_current
     AND w.week_start BETWEEN v_real - 7 AND v_real + 28
     AND w.status_overridden_at IS NULL
     AND w.status NOT IN ('generated', 'published')
     AND w.submission_deadline IS DISTINCT FROM public.deadline_for_week(w.week_start);

  -- Reconcile every in-range week's open/locked status against its own
  -- window -- bounded the same way, for the same reason. Already
  -- value-guarded (WHERE w.status = ...), unchanged.
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
