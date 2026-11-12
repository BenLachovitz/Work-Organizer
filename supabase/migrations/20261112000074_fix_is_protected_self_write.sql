-- ============================================================================
-- Migration 74 : fix a real gap found by supabase/tests/employee-role-silence.
-- cloud.test.mjs -- is_protected (migration 71) was never added to
-- guard_profile_columns()'s blocked-column list, unlike is_silenced
-- (migration 72), which WAS added there. RLS's profiles_self_update policy
-- (migration 3) is row-scoped only (id = auth.uid()), with no column
-- restriction -- the trigger is the ONLY thing stopping a guard from writing
-- any given column on their own row. Without this, a guard could run
-- `UPDATE profiles SET is_protected = TRUE WHERE id = auth.uid()` and grant
-- themselves permanent role protection, defeating the entire point of the
-- flag being "set once, by hand, outside the app."
--
-- Confirmed live against production before this fix: a disposable test
-- guard successfully set is_protected = TRUE on their own row via a plain
-- table write. This migration closes that gap the same way is_silenced's
-- was closed in migration 72 -- one more IF block, same function body
-- otherwise.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_manager() THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.role';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.is_active';
    END IF;
    IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.employee_code';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.id';
    END IF;
    IF NEW.is_silenced IS DISTINCT FROM OLD.is_silenced THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.is_silenced';
    END IF;
    IF NEW.is_protected IS DISTINCT FROM OLD.is_protected THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.is_protected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
