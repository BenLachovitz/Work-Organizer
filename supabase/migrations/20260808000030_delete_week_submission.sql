-- ============================================================================
-- Migration 30 : Let a guard cancel their own submission outright
--
-- Ben's scenario: a guard submits, then something changes in their life
-- inside the still-open window and they want to un-submit -- not edit down
-- to an empty week (spec 3.4's "submitted, empty" is a different, deliberate
-- state: "I am unavailable this week") but genuinely go back to "never
-- submitted", so they can reconsider and submit a fresh one later, or not
-- submit at all.
--
-- Mirrors save_week_preferences' shape exactly: SECURITY INVOKER, v_uid from
-- auth.uid() (so this can only ever act on the CALLER's own row -- a manager
-- calling it deletes their own submission, not another guard's; a manager
-- clearing someone else's submission is a direct table write under
-- subs_manager_write/prefs_manager_write, same as everywhere else), gated on
-- is_week_open() OR is_manager(). Both DELETEs in one transaction rather
-- than two separate client-side calls -- the same reasoning
-- save_week_preferences' own header comment gives: two PostgREST calls can
-- half-fail and leave a torn state.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_week_submission(
  p_week_start DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.is_week_open(p_week_start) OR public.is_manager()) THEN
    RAISE EXCEPTION 'submission window closed' USING ERRCODE = '42501';
  END IF;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = v_uid AND week_start = p_week_start;

  DELETE FROM weekly_submissions
   WHERE guard_id = v_uid AND week_start = p_week_start;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_week_submission(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_week_submission(DATE) TO authenticated;
