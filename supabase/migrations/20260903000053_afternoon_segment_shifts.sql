-- ============================================================================
-- Migration 53 : Afternoon block segment shifts (afternoon_early / afternoon_late)
--
-- The afternoon block (14:45-22:45) is two coverage segments, S2 (early,
-- 14:45-18:45) and S3 (late, 18:45-22:45). Until now the only way to occupy
-- just one half manually was a 12h day12/night12 shift, which also commits
-- the guard to the morning or night. These two new shift_type values let the
-- roster editor put a guard -- or a coverage-occupying placeholder,
-- migration 52 -- into just S2 or just S3 alone.
--
-- Manual-edit only, same as a placeholder: never produced by the solver.
-- save_run_assignments already casts generically ((e->>'shift')::shift_type),
-- so it needs no change for these to work -- the values just need to exist.
--
-- Deliberately just the two ADD VALUE statements and nothing else in this
-- file: Postgres forbids using a newly-added enum value inside the same
-- transaction it was added in, and this project's db:apply runs one
-- transaction per migration file.
-- ============================================================================

ALTER TYPE shift_type ADD VALUE 'afternoon_early';
ALTER TYPE shift_type ADD VALUE 'afternoon_late';
