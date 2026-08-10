-- ============================================================================
-- Migration 35 : Per-day morning target overrides
--
-- roster_weeks.morning_target_slots is a single value for the whole week
-- (Mon-Fri, per morningTargetForDay()). The manager wants finer control for
-- an exceptional week -- e.g. a holiday week needing Mon-Wed at 2 guards but
-- Thu-Fri at 3 -- without changing the week's own baseline setting.
--
-- Sparse by design, same convention weekly_submissions.requested_shifts and
-- notes already use (spec 3.4/3.10): a day's row exists only when it DIFFERS
-- from the week's own morning_target_slots baseline. Saving a value equal to
-- the current baseline deletes the row instead of storing a redundant one --
-- so raising or lowering the week-level toggle later automatically re-applies
-- to every day that was never explicitly overridden, which is exactly the
-- "temporary exception" shape a holiday week needs.
--
-- Weekdays only (day_index 1-5). Saturday and Sunday stay hard-locked at
-- target 2 -- the existing rule that the weekend always runs light regardless
-- of the week's setting, which this migration does not change.
-- ============================================================================

CREATE TABLE weekly_morning_target_overrides (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start            DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  day_index             SMALLINT NOT NULL CHECK (day_index BETWEEN 1 AND 5),
  morning_target_slots  SMALLINT NOT NULL CHECK (morning_target_slots IN (2, 3)),
  UNIQUE (week_start, day_index)
);

COMMENT ON TABLE weekly_morning_target_overrides IS
  'Per-day exception to roster_weeks.morning_target_slots for one specific week (e.g. a holiday). A day with no row here just follows the week baseline -- see morningTargetForDay() in src/lib/shifts.ts.';

ALTER TABLE weekly_morning_target_overrides ENABLE ROW LEVEL SECURITY;

-- Same read/write shape as roster_weeks itself (migration 1/3): everyone
-- reads (the grid needs it to render coverage correctly for every viewer),
-- only a manager writes.
CREATE POLICY morning_target_overrides_read ON weekly_morning_target_overrides
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY morning_target_overrides_manager_write ON weekly_morning_target_overrides
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

CREATE INDEX idx_morning_target_overrides_week ON weekly_morning_target_overrides (week_start);
