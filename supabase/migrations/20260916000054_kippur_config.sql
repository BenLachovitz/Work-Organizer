-- ============================================================================
-- Migration 54 : Yom Kippur special-coverage config
--
-- Yom Kippur is a driving-prohibited holiday: 2-3 guards need to cover an
-- unbroken block from Kippur eve's early afternoon through the end of Kippur
-- day (excluding that final night), because they cannot drive home and back.
-- This adds the two small, standing config points a manager sets:
--
--   - scheduler_settings.kippur_handling_enabled: a global "turn this feature
--     on" switch (default off) -- same singleton-row settings table migration
--     22 already created for the submission window. Whether a given week
--     actually needs the special panel is a computed fact (does this week
--     contain Yom Kippur? -- src/lib/holidays.ts, Hebrew-calendar-derived),
--     not something set per week; this flag only controls whether the app
--     ever looks for that at all.
--   - roster_weeks.kippur_guard_count: how many guards (2 or 3) cover the
--     block, for whichever week actually needs it. A plain nullable column,
--     same shape as double_shift_display_hours (migration 47) -- meaningful
--     only on an actual Kippur week, no RLS change needed since
--     weeks_manager_write already governs every column on this table.
--
-- The actual chosen guards live in a separate table, weekly_kippur_guards
-- (migration 55) -- this migration is config only.
-- ============================================================================

ALTER TABLE scheduler_settings
  ADD COLUMN kippur_handling_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN scheduler_settings.kippur_handling_enabled IS
  'Standing switch for the Yom Kippur special-coverage feature. When on, the manager dashboard surfaces a guard-picker on whichever week the Hebrew calendar places Yom Kippur in (src/lib/holidays.ts) -- this flag does not itself mark any specific week.';

ALTER TABLE roster_weeks
  ADD COLUMN kippur_guard_count SMALLINT CHECK (kippur_guard_count IN (2, 3));

COMMENT ON COLUMN roster_weeks.kippur_guard_count IS
  'How many guards (2 or 3) cover the Yom Kippur block this week. NULL on every ordinary week; meaningful only when this week actually contains Yom Kippur eve + day.';
