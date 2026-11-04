-- ============================================================================
-- Migration 70 : soft-delete for work_log_entries
--
-- Bug: a guard deleting a roster-seeded entry (source = 'roster' or
-- 'edited') had no visible effect -- useWorkLogWeek()/useMonthlySalarySummary()
-- call seedWeekFromRoster() on every load, which treats "no work_log_entries
-- row for this published assignment" as "never seeded yet" and immediately
-- re-inserts it. A hard DELETE is exactly that signal, so the row always came
-- straight back. This matters for real use: a guard scheduled for a shift
-- who then called in sick/was pulled the day before needs to be able to
-- remove it from their own salary estimate, not just edit its times.
--
-- Fix is a soft delete: `deleted_at` marks a row as removed without actually
-- deleting it, so its source_assignment_id still occupies
-- work_log_one_per_assignment's unique slot and the lazy seed's "already
-- seeded" check (which does not, and must not, filter by deleted_at) still
-- sees it -- the row is gone from every guard-facing view and from
-- computePayroll's input, but never comes back on its own. See
-- useDeleteWorkLogEntry() (src/hooks/useWorkLog.ts), which now UPDATEs this
-- column instead of issuing a DELETE.
-- ============================================================================

ALTER TABLE work_log_entries ADD COLUMN deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN work_log_entries.deleted_at IS
  'Soft-delete marker. Set by the guard removing an entry they do not want counted (e.g. a roster shift they ended up not working) -- the row is kept, not hard-deleted, so the lazy roster seed never resurrects it. NULL = not deleted.';
