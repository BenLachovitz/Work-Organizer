-- ============================================================================
-- Migration 59 : work_log_entries grants and RLS
--
-- Same shape as every other per-guard table (weekly_submissions,
-- weekly_wish_preferences): guard reads/writes their own rows, manager reads
-- (and may write, as a support escape hatch) everyone's. There is no
-- is_week_open()-style lock here -- unlike preferences, a work-log entry is
-- never time-boxed by a submission deadline.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON work_log_entries TO authenticated;

ALTER TABLE work_log_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_log_read ON work_log_entries
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY work_log_self_write ON work_log_entries
  FOR ALL TO authenticated
  USING      (guard_id = auth.uid())
  WITH CHECK (guard_id = auth.uid());

CREATE POLICY work_log_manager_write ON work_log_entries
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());
