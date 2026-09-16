-- ============================================================================
-- Migration 56 : Yom Kippur shift types (kippur_day1 / kippur_day2)
--
-- Every existing shift type is scoped to one calendar day, and
-- schedule_assignments has a real DB-level unique index,
-- one_shift_per_guard_per_day, on (run_id, target_date, guard_id) -- a guard
-- can only ever hold ONE shift row per date. The Kippur block (early
-- afternoon of Kippur eve through the end of Kippur day, excluding that
-- final night) therefore needs its own two shift types, one per day, rather
-- than two ordinary same-day rows:
--
--   kippur_day1 : S2 + S3 + S4 (14:45 -> 06:45 next day)
--   kippur_day2 : S1 + S2 + S3 (06:45 -> 22:45, deliberately no night)
--
-- Manual-edit only, same as afternoon_early/afternoon_late (migration 53):
-- never produced by the solver, written automatically by
-- useGenerateSchedule.ts once a week's weekly_kippur_guards are configured.
-- save_run_assignments already casts generically ((e->>'shift')::shift_type),
-- so it needs no change for these to work -- the values just need to exist.
--
-- Deliberately just the two ADD VALUE statements and nothing else in this
-- file: Postgres forbids using a newly-added enum value inside the same
-- transaction it was added in, and this project's db:apply runs one
-- transaction per migration file.
-- ============================================================================

ALTER TYPE shift_type ADD VALUE 'kippur_day1';
ALTER TYPE shift_type ADD VALUE 'kippur_day2';
