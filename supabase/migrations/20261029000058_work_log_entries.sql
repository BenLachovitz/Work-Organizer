-- ============================================================================
-- Migration 58 : Personal work log (estimated gross salary feature)
--
-- A guard-facing, self-service tool: each guard gets a personal log of hours
-- actually worked, seeded from their own PUBLISHED roster assignments, which
-- they may then correct (stayed late, left early) or add to (an ad-hoc shift
-- that was never in any roster at all). This feeds an estimated GROSS salary
-- calculation (src/lib/payroll.ts) under standard Israeli overtime/Shabbat
-- law. There is deliberately no manager-approval gate -- this is not
-- connected to any real payroll system, so a guard who inflates their own
-- hours only misleads themselves about their own estimate.
--
-- Kept entirely out of schedule_assignments/schedule_runs, which are the
-- solver's own domain (RLS, save_run_assignments, publish/unpublish
-- semantics all assume "scheduling intent", not "actual hours worked"). The
-- only link back is the nullable source_assignment_id, used purely to avoid
-- re-seeding a row the guard already has.
-- ============================================================================

CREATE TYPE work_log_source AS ENUM ('roster', 'edited', 'manual');

-- ----------------------------------------------------------------------------
-- work_log_entries
--
-- `source` distinguishes three states: 'roster' = untouched seed from a
-- published assignment, 'edited' = seeded then the guard changed the actual
-- times, 'manual' = never existed in any roster (an ad-hoc shift the guard
-- adds themselves). scheduled_start/scheduled_end record the nominal
-- SHIFTS[shift] window at seed time, purely for display ("you logged 1h more
-- than scheduled") -- actual_start/actual_end are what the salary
-- calculation actually uses.
--
-- shift is nullable: a fully manual entry (helped cover a gap with no fixed
-- shift grid) may have no shift_type at all, just a pair of actual times.
-- ----------------------------------------------------------------------------
CREATE TABLE work_log_entries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id             UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_date          DATE NOT NULL,
  shift                shift_type,
  source               work_log_source NOT NULL DEFAULT 'manual',
  source_assignment_id UUID REFERENCES schedule_assignments(id) ON DELETE SET NULL,
  scheduled_start      TIMESTAMPTZ,
  scheduled_end        TIMESTAMPTZ,
  actual_start         TIMESTAMPTZ NOT NULL,
  actual_end           TIMESTAMPTZ NOT NULL,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT actual_end_after_start CHECK (actual_end > actual_start),
  -- An ad-hoc entry someone mis-keys (wrong AM/PM, forgot to set a date) is a
  -- bug in their own estimate, not a real 40-hour day -- this is the
  -- Phase-3 sanity cap flagged in the feature plan.
  CONSTRAINT actual_duration_sane CHECK (actual_end - actual_start <= INTERVAL '18 hours')
);

COMMENT ON TABLE work_log_entries IS
  'Per-guard personal log of hours actually worked, for the self-service estimated-salary feature. Independent of schedule_assignments -- never read by the solver or by anything scheduling-related.';

-- A published assignment seeds at most one work-log row, so re-running the
-- lazy seed (or the one-time backfill script) is always safe to repeat.
CREATE UNIQUE INDEX work_log_one_per_assignment
  ON work_log_entries (source_assignment_id) WHERE source_assignment_id IS NOT NULL;

CREATE INDEX idx_work_log_guard_date ON work_log_entries (guard_id, target_date);
