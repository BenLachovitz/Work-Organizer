-- ============================================================================
-- Migration 55 : weekly_kippur_guards
--
-- The guards chosen to cover a given week's Yom Kippur block (migration 54's
-- kippur_guard_count says how many; this table says WHO). One row per chosen
-- guard, not an array column -- lets the manager UI check each guard's
-- submitted availability individually, and lets deletion (a guard removed
-- from the pick, or the whole feature turned back off for a week) be a plain
-- row delete rather than array surgery.
--
-- Same read/write shape as weekly_morning_target_overrides (migration 35) /
-- weekly_segment_target_overrides (migration 37): everyone reads (the grid
-- and the guard's own view need to know who's on the block), only a manager
-- writes.
-- ============================================================================

CREATE TABLE weekly_kippur_guards (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  guard_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (week_start, guard_id)
);

COMMENT ON TABLE weekly_kippur_guards IS
  'The guards chosen to cover this week''s Yom Kippur block (kippur_day1 + kippur_day2, one row each, written automatically at generation time -- see useGenerateSchedule.ts). A guard listed here must have submitted matching availability before generation; see src/lib/shifts.ts requiresBases.';

ALTER TABLE weekly_kippur_guards ENABLE ROW LEVEL SECURITY;

CREATE POLICY kippur_guards_read ON weekly_kippur_guards
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY kippur_guards_manager_write ON weekly_kippur_guards
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

CREATE INDEX idx_kippur_guards_week ON weekly_kippur_guards (week_start);
