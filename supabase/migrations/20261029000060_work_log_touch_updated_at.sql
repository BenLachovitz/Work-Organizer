-- ============================================================================
-- Migration 60 : Keep work_log_entries.updated_at honest
--
-- Reuses touch_updated_at() (migration 2), already attached to
-- weekly_submissions, for the same reason: an edited/manual entry's
-- updated_at should reflect the edit, not the original seed time.
-- ============================================================================

CREATE TRIGGER trg_work_log_touch
  BEFORE UPDATE ON public.work_log_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();
