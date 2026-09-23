-- ============================================================================
-- Migration 57 : Morning target override -- allow 1, allow every day
--
-- Migration 35 gave the morning (S1) target a per-day override, but limited
-- to weekdays (day_index 1-5) and to 2/3 -- Saturday/Sunday were hard-locked
-- to 2 with no override possible at all, per the "weekend always runs light"
-- rule documented there. The manager wants the same every-day, 1-or-more
-- flexibility weekly_segment_target_overrides (migration 37) already gives
-- S2/S3/S4: a value of 1 for a genuinely short-staffed day, on ANY day of
-- the week including Saturday/Sunday.
--
-- The week-level roster_weeks.morning_target_slots baseline toggle is NOT
-- touched by this migration -- it stays a strict 2-or-3 choice. Only the
-- per-day EXCEPTION table gets wider.
--
-- segmentFloors() in src/lib/shifts.ts already computes S1's floor as
-- `morning === 3 ? 2 : Math.min(1, morning)`, which is already correct for
-- morning === 1 (floor 1) -- no solver/referee logic needed changing, only
-- these two CHECK constraints and the application-layer types around them.
--
-- One side effect worth recording: this also lifts the previously-permanent
-- limit noted in spec 12.14 -- a Yom Kippur block landing on a Saturday can
-- now get a 3-guard ceiling via an explicit weekend override, where before
-- the hard weekend lock made that impossible.
-- ============================================================================

ALTER TABLE weekly_morning_target_overrides
  DROP CONSTRAINT weekly_morning_target_overrides_day_index_check,
  DROP CONSTRAINT weekly_morning_target_overrides_morning_target_slots_check,
  ADD CONSTRAINT weekly_morning_target_overrides_day_index_check
    CHECK (day_index BETWEEN 0 AND 6),
  ADD CONSTRAINT weekly_morning_target_overrides_morning_target_slots_check
    CHECK (morning_target_slots IN (1, 2, 3));

COMMENT ON TABLE weekly_morning_target_overrides IS
  'Per-day exception to roster_weeks.morning_target_slots for one specific week (e.g. a holiday or a short-staffed day). A day with no row here just follows the week baseline (weekdays) or the flat weekend baseline of 2 -- see morningTargetForDay() in src/lib/shifts.ts. Any day 0-6 is overridable to 1, 2, or 3 as of migration 57.';
