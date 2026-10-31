-- ============================================================================
-- Migration 67 : sticky per-day coverage overrides + display-hours setting
--
-- Two manager-facing per-week settings reset to a blank/default state every
-- time a new week is created, forcing the manager to re-enter the same
-- values every week during a staffing period that genuinely needs them:
--   1. The per-day morning-target overrides and per-day/per-segment
--      (S2/S3/S4) coverage-target overrides (weekly_morning_target_overrides,
--      weekly_segment_target_overrides, migrations 35/37).
--   2. The per-week 12h/11h "double shift display hours" setting
--      (roster_weeks.double_shift_display_hours, migration 47).
--
-- The week-level morning baseline (2-or-3) does NOT have this problem: it's
-- already sourced from one persistent setting
-- (scheduler_settings.default_morning_target_slots, migration 24), so
-- changing it once already applies to every future week. This migration
-- gives the two settings above the same "standing default, seeded once per
-- new week" treatment already proven by that column AND by
-- profiles.default_kamut -> weekly_guard_targets.configured_kamut
-- (migration 19/20): a persistent default, copied into a per-week row only
-- when that row doesn't exist yet (ON CONFLICT DO NOTHING), never touched
-- again afterwards.
--
-- Unlike default_kamut/default_morning_target_slots, which are edited
-- directly in their own settings UI, the manager's explicit choice here is
-- that these two settings get no separate "edit the defaults" page --
-- instead, a new "set as new normal" action snapshots whichever week the
-- manager is currently looking at and makes THAT the new standing default,
-- until pressed again. A one-off special week never silently becomes the
-- new standard.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Standing-default tables -- NOT per-week (no week_start). The template
--    every new week's own weekly_morning_target_overrides/
--    weekly_segment_target_overrides rows get seeded from. Same effective
--    constraints as their per-week counterparts (day_index 0-6, the
--    widened-by-migration-57 shape), manager-only RLS -- nothing guard-
--    facing ever needs to read a standing default directly.
-- ----------------------------------------------------------------------------
CREATE TABLE default_morning_target_overrides (
  day_index            SMALLINT PRIMARY KEY CHECK (day_index BETWEEN 0 AND 6),
  morning_target_slots SMALLINT NOT NULL CHECK (morning_target_slots IN (1, 2, 3))
);

CREATE TABLE default_segment_target_overrides (
  day_index    SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  segment      TEXT NOT NULL CHECK (segment IN ('S2', 'S3', 'S4')),
  target_slots SMALLINT NOT NULL CHECK (target_slots IN (1, 2)),
  PRIMARY KEY (day_index, segment)
);

ALTER TABLE default_morning_target_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE default_segment_target_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY default_morning_overrides_manager_only ON default_morning_target_overrides
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

CREATE POLICY default_segment_overrides_manager_only ON default_segment_target_overrides
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

-- ----------------------------------------------------------------------------
-- 2. scheduler_settings gains the display-hours sibling to
--    default_morning_target_slots -- same singleton-settings-row pattern,
--    same column shape as roster_weeks.double_shift_display_hours itself.
-- ----------------------------------------------------------------------------
ALTER TABLE scheduler_settings
  ADD COLUMN default_double_shift_display_hours SMALLINT NOT NULL DEFAULT 12
    CHECK (default_double_shift_display_hours IN (11, 12));

-- ----------------------------------------------------------------------------
-- 3. ensure_roster_weeks() -- same body as migration 36's (the current/live
--    version), with two additions: double_shift_display_hours now flows
--    into both roster_weeks INSERTs from the new setting column instead of
--    silently falling through to the column's own DEFAULT 12 every time;
--    and two new seeding blocks for the override tables, identical in shape
--    to the existing weekly_guard_targets block directly below them.
-- ----------------------------------------------------------------------------
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
  v_hours   SMALLINT;
  v_real    DATE := public.current_week_start();
BEGIN
  SELECT default_morning_target_slots, default_double_shift_display_hours
    INTO v_target, v_hours
    FROM scheduler_settings WHERE id;

  -- The week in progress. Its own submission window closed long ago.
  INSERT INTO roster_weeks (week_start, morning_target_slots, double_shift_display_hours, submission_deadline, status)
  VALUES (v_current, v_target, v_hours, public.deadline_for_week(v_current), 'locked')
  ON CONFLICT (week_start) DO NOTHING;

  -- The week being filled in. Open only once its Saturday 20:00 has arrived.
  INSERT INTO roster_weeks (week_start, morning_target_slots, double_shift_display_hours, submission_deadline, status)
  VALUES (
    v_next,
    v_target,
    v_hours,
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

  -- Seed this week's per-day morning-target overrides from the standing
  -- default, wherever a day's override is missing -- same "seed once, never
  -- re-touch" shape as the כמות block above.
  INSERT INTO weekly_morning_target_overrides (week_start, day_index, morning_target_slots)
  SELECT wk.week_start, d.day_index, d.morning_target_slots
    FROM (VALUES (v_current), (v_next)) AS wk(week_start)
    CROSS JOIN default_morning_target_overrides d
  ON CONFLICT (week_start, day_index) DO NOTHING;

  -- Same for the per-day/per-segment (S2/S3/S4) overrides.
  INSERT INTO weekly_segment_target_overrides (week_start, day_index, segment, target_slots)
  SELECT wk.week_start, d.day_index, d.segment, d.target_slots
    FROM (VALUES (v_current), (v_next)) AS wk(week_start)
    CROSS JOIN default_segment_target_overrides d
  ON CONFLICT (week_start, day_index, segment) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. set_week_as_new_normal(p_week_start) -- the manager's explicit "make
--    what I see right now the new normal" action. SECURITY INVOKER, same as
--    set_week_status: every table it touches already has RLS that correctly
--    authorizes a manager caller (manager-write on both new default_*
--    tables, manager-write on scheduler_settings, manager-or-self read on
--    the two weekly_* override tables and roster_weeks) -- no need to
--    bypass RLS, so no DEFINER. The explicit check up front exists purely
--    so a guard calling this gets a clean, specific rejection rather than a
--    confusing "0 rows affected" silent no-op from RLS alone.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_week_as_new_normal(p_week_start DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  DELETE FROM default_morning_target_overrides;
  INSERT INTO default_morning_target_overrides (day_index, morning_target_slots)
    SELECT day_index, morning_target_slots
      FROM weekly_morning_target_overrides
     WHERE week_start = p_week_start;

  DELETE FROM default_segment_target_overrides;
  INSERT INTO default_segment_target_overrides (day_index, segment, target_slots)
    SELECT day_index, segment, target_slots
      FROM weekly_segment_target_overrides
     WHERE week_start = p_week_start;

  UPDATE scheduler_settings
     SET default_double_shift_display_hours = COALESCE(
           (SELECT double_shift_display_hours FROM roster_weeks WHERE week_start = p_week_start),
           default_double_shift_display_hours
         );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_week_as_new_normal(DATE) TO authenticated;
