-- ============================================================================
-- Migration 37 : Per-day afternoon/night target overrides
--
-- Migration 35 let a manager override the morning (S1) target per day. The
-- afternoon (S2 early / S3 late) and night (S4) targets were still flat --
-- always 2, with a floor of 1 -- and not day-overridable at all. This adds
-- the same per-day exception ability to those three segments, each to 1 or 2
-- guards (not 2/3 like morning -- these segments don't have a "raised"
-- tier), with the rule that a target of 1 always carries a floor of 1 too:
-- a shift can never be allowed to go fully empty. See segmentFloors() in
-- src/lib/shifts.ts, which clamps floor to min(1, target) for S2/S3/S4.
--
-- One table for all three segments, not three near-duplicate tables --
-- unlike morning (2/3, weekdays only), S2/S3/S4 now share an identical
-- shape (1/2, every day of the week), so a `segment` column is the natural
-- generalization. Unlike morning, there is no existing weekend-specific
-- rule for these segments, so all 7 days are overridable (day_index 0-6).
--
-- Sparse by design, same convention as weekly_morning_target_overrides: a
-- (day, segment) with no row here just follows the flat baseline of 2.
-- ============================================================================

CREATE TABLE weekly_segment_target_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start   DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  day_index    SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  segment      TEXT NOT NULL CHECK (segment IN ('S2', 'S3', 'S4')),
  target_slots SMALLINT NOT NULL CHECK (target_slots IN (1, 2)),
  UNIQUE (week_start, day_index, segment)
);

COMMENT ON TABLE weekly_segment_target_overrides IS
  'Per-day, per-segment exception to the flat afternoon/night target of 2, for one specific week. A (day, segment) with no row here just follows the baseline -- see segmentTargets()/segmentFloors() in src/lib/shifts.ts.';

ALTER TABLE weekly_segment_target_overrides ENABLE ROW LEVEL SECURITY;

-- Same read/write shape as weekly_morning_target_overrides (migration 35):
-- everyone reads (the grid needs it to render coverage correctly for every
-- viewer), only a manager writes.
CREATE POLICY segment_target_overrides_read ON weekly_segment_target_overrides
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY segment_target_overrides_manager_write ON weekly_segment_target_overrides
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

CREATE INDEX idx_segment_target_overrides_week ON weekly_segment_target_overrides (week_start);
