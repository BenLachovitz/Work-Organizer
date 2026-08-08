-- ============================================================================
-- Migration 21 : Real employee deletion, replacing deactivation
--
-- The manager wants an employee who quit fully gone, not sitting in a
-- "לא פעילים" list. This is deliberately irreversible: `auth.users` is not
-- exposed through PostgREST at all (it lives outside the `public` schema), so
-- there is no RLS policy to gate a direct table write the way roster_codes
-- got one in migration 20 -- this can only happen through a SECURITY DEFINER
-- function.
--
-- Deleting `auth.users` is the one statement that removes everything: it
-- cascades to `profiles` (ON DELETE CASCADE, migration 1), which cascades to
-- every table that references `guard_id` -- schedule_assignments,
-- weekly_wish_preferences, weekly_submissions, weekly_guard_targets. A
-- guard's shifts disappear from every roster they are in, including a
-- published one, and `schedule_runs.generated_by` (ON DELETE SET NULL) simply
-- forgets who ran a generation rather than losing the run itself.
--
-- roster_codes is deleted too, whether the code was ever claimed or not --
-- "clear all of the employee's data" includes the invitation, and it frees
-- the code for reuse. This also means the same function now covers what
-- useCancelInvitation used to (an unclaimed code has no matching profile, so
-- the auth.users branch below is simply skipped) -- one delete path instead
-- of two.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_employee(p_employee_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_id UUID;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_profile_id FROM profiles WHERE employee_code = p_employee_code;

  -- A manager cannot delete their own account this way. There is exactly one
  -- manager today; doing this to yourself is an instant, self-service
  -- lockout with no recovery path short of asking someone to run SQL by hand.
  IF v_profile_id IS NOT NULL AND v_profile_id = auth.uid() THEN
    RAISE EXCEPTION 'cannot delete your own account' USING ERRCODE = '42501';
  END IF;

  IF v_profile_id IS NOT NULL THEN
    DELETE FROM auth.users WHERE id = v_profile_id;
  END IF;

  DELETE FROM roster_codes WHERE employee_code = p_employee_code;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_employee(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_employee(TEXT) TO authenticated;
