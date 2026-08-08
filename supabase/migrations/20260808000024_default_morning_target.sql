-- ============================================================================
-- Migration 24 : Standing default for the Mon-Fri morning target
--
-- morning_target_slots (2 or 3) is a per-week value set by hand on
-- WeekControlsPanel. Until now a NEW week's starting value was carried
-- forward from whichever roster_weeks row happened to be the most recently
-- created one (migration 19's ensure_roster_weeks()) -- an implicit,
-- undiscoverable behaviour, not a real setting a manager can see or flip.
--
-- This adds an explicit standing default on scheduler_settings (migration 22
-- already established the shape: a singleton row, read only at the moment
-- ensure_roster_weeks() inserts a new roster_weeks row). Flipping it affects
-- weeks created from then on; it never rewrites an already-existing week's
-- stored morning_target_slots, and a manager's own per-week edit on
-- WeekControlsPanel is untouched -- same non-retroactive relationship
-- migration 22 already has with deadline_for_week()/opens_for_week().
-- ============================================================================

ALTER TABLE scheduler_settings
  ADD COLUMN default_morning_target_slots INT NOT NULL DEFAULT 2
    CHECK (default_morning_target_slots IN (2, 3));

COMMENT ON COLUMN scheduler_settings.default_morning_target_slots IS
  'Starting morning_target_slots for a NEW roster_weeks row, read by ensure_roster_weeks(). Does not touch an existing week; WeekControlsPanel''s per-week control still overrides one specific week.';

-- ----------------------------------------------------------------------------
-- ensure_roster_weeks(): same body as migration 19, except v_target now comes
-- from the explicit standing default instead of being carried forward from
-- the latest existing roster_weeks row.
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
