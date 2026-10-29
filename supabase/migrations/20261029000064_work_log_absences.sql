-- ============================================================================
-- Migration 64 : Sick/vacation absences (estimated gross salary feature)
--
-- Fully separate from work_log_entries: an absence is not worked time at
-- all, carries no actual_start/actual_end, and never touches the overtime
-- engine (src/lib/payroll.ts's computePayroll). Its pay value comes from a
-- DIFFERENT, much simpler calculation -- the guard's own average daily
-- gross over a trailing window, times a percentage (100% for vacation;
-- 0/50/100% for sick, depending on which day of a consecutive run of sick
-- entries this one is) -- see averageDailyGross()/sickPayPercent() in
-- payroll.ts.
--
-- No balance/ledger of any kind, by deliberate choice (same trust model as
-- the rest of this feature, spec'd with the owner): the app never checks
-- whether a guard has any sick/vacation days actually left. One row per
-- guard per day -- a day cannot be both sick AND vacation, and cannot be
-- logged twice.
-- ============================================================================

CREATE TYPE absence_type AS ENUM ('sick', 'vacation');

CREATE TABLE work_log_absences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  type        absence_type NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guard_id, target_date)
);

COMMENT ON TABLE work_log_absences IS
  'Self-reported sick/vacation days for the personal work-log/estimated-salary feature. No balance or ledger -- never checked against how many days a guard actually has left. Independent of work_log_entries; never read by computePayroll''s overtime engine.';

GRANT SELECT, INSERT, UPDATE, DELETE ON work_log_absences TO authenticated;

ALTER TABLE work_log_absences ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_log_absences_read ON work_log_absences
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY work_log_absences_self_write ON work_log_absences
  FOR ALL TO authenticated
  USING      (guard_id = auth.uid())
  WITH CHECK (guard_id = auth.uid());

CREATE POLICY work_log_absences_manager_write ON work_log_absences
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

CREATE TRIGGER trg_work_log_absences_touch
  BEFORE UPDATE ON public.work_log_absences
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();
