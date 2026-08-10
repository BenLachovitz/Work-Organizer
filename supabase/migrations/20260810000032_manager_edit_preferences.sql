-- ============================================================================
-- Migration 32 : Manager edits a guard's own preferences
--
-- save_week_preferences / delete_week_submission are both hardcoded to
-- auth.uid() (see their own header comments) -- a manager calling either one
-- only ever acts on the MANAGER's own row, never another guard's. Managing a
-- guard's submission on their behalf (new manager preference detail/edit
-- window) needs an explicit p_guard_id, so it cannot reuse those functions.
--
-- Mirrors save_week_preferences' body exactly (same atomic delete-then-insert
-- across weekly_submissions/weekly_wish_preferences in one transaction, for
-- the same half-fail reason its header comment gives) and
-- delete_week_submission's, keyed on p_guard_id instead of auth.uid().
--
-- SECURITY INVOKER, gated on is_manager() only -- deliberately NOT
-- is_week_open(): a manager's edit on a guard's behalf isn't bound by that
-- guard's own submission deadline, the same way a manager can already edit a
-- roster after publish. RLS (prefs_manager_write / subs_manager_write, both
-- USING (is_manager())) still applies underneath since this is INVOKER, so
-- the explicit check here exists only to fail with a readable message
-- instead of an opaque policy violation.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.manager_save_week_preferences(
  p_guard_id   UUID,
  p_week_start DATE,
  p_slots      JSONB,           -- [{"date":"2026-08-16","shift":"morning","allows12h":true,"strength":2}, ...]
  p_notes      TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'insufficient privilege: manager only' USING ERRCODE = '42501';
  END IF;

  INSERT INTO weekly_submissions (guard_id, week_start, notes)
  VALUES (p_guard_id, p_week_start, NULLIF(TRIM(p_notes), ''))
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET updated_at = NOW(),
        notes      = EXCLUDED.notes;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = p_guard_id AND week_start = p_week_start;

  IF p_slots IS NOT NULL AND jsonb_array_length(p_slots) > 0 THEN
    INSERT INTO weekly_wish_preferences
      (guard_id, week_start, target_date, shift, allows_12h, strength)
    SELECT p_guard_id,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift,
           COALESCE((e->>'allows12h')::BOOLEAN, FALSE)
             AND (e->>'shift') IN ('morning', 'night'),
           COALESCE((e->>'strength')::SMALLINT, 1)
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.manager_save_week_preferences(UUID, DATE, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_save_week_preferences(UUID, DATE, JSONB, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.manager_delete_week_submission(
  p_guard_id   UUID,
  p_week_start DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'insufficient privilege: manager only' USING ERRCODE = '42501';
  END IF;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = p_guard_id AND week_start = p_week_start;

  DELETE FROM weekly_submissions
   WHERE guard_id = p_guard_id AND week_start = p_week_start;
END;
$$;

REVOKE ALL ON FUNCTION public.manager_delete_week_submission(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_delete_week_submission(UUID, DATE) TO authenticated;
