-- ============================================================================
-- Migration 48 : phone_number on the pre-claim/post-claim pair
--
-- First contact channel that has ever existed in this schema -- until now the
-- only "email" anywhere was the synthetic {code}@guards.local GoTrue login,
-- which nobody reads. Laid down for the self-service WhatsApp-OTP forgot-PIN
-- flow (migration 49), following the same dual-column shape default_kamut
-- (migration 20) and is_demo (migration 34) already established: a column on
-- roster_codes for a not-yet-claimed invitation, the same column on profiles
-- for a live guard, carried across at claim time by a dedicated trigger --
-- mirroring migration 34's copy_is_demo()/trg_profiles_is_demo shape (a
-- separate trigger per copied column, not one shared function), rather than
-- editing copy_default_kamut() itself.
--
-- Nullable on both tables, unconditionally -- every currently-claimed real
-- guard has none yet, and there is no sane placeholder value to backfill.
-- "Required for a NEW employee" is a UI-only rule in AddEmployeeCard, the same
-- way display_name's non-empty rule is UI-only despite the column allowing it.
--
-- No RLS changes: roster_codes already has codes_manager_write (migration 20)
-- and profiles already has profiles_manager_write (migration 3), both
-- unrestricted-by-column FOR ALL manager policies -- same reasoning already
-- documented for default_kamut (spec 12.4).
--
-- Deliberately NO uniqueness constraint yet -- Ben's explicit instruction:
-- testing will use several mock employees sharing his own real phone number,
-- and the constraint will be added later on his explicit go-ahead once that
-- testing is done. Do not add it without being asked again.
-- ============================================================================

ALTER TABLE roster_codes ADD COLUMN phone_number TEXT;
ALTER TABLE profiles     ADD COLUMN phone_number TEXT;

COMMENT ON COLUMN roster_codes.phone_number IS
  'E.164 phone number, set before the employee has claimed their code. Copied onto profiles.phone_number at claim time by trg_profiles_phone_number. No uniqueness constraint yet -- deliberately deferred, see migration header.';
COMMENT ON COLUMN profiles.phone_number IS
  'E.164 phone number, used by the whatsapp-pin-reset Edge Function (migration 49) to send a self-service PIN-reset OTP. NULL means this guard has no self-service reset path yet -- the manager-only reset-pin fallback still applies.';

-- ----------------------------------------------------------------------------
-- Carry the number from roster_codes to profiles at claim time -- same shape
-- as copy_is_demo()/trg_profiles_is_demo (migration 34): a dedicated trigger
-- per copied column rather than growing one shared function, so the one
-- publicly-reachable unauthenticated endpoint (claim-code) stays untouched no
-- matter who or what inserts the row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copy_phone_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.phone_number := COALESCE(
    (SELECT phone_number FROM roster_codes WHERE employee_code = NEW.employee_code),
    NEW.phone_number
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_phone_number
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.copy_phone_number();

-- ----------------------------------------------------------------------------
-- roster_code_status: add phone_number, COALESCE'd the same way default_kamut
-- and is_demo already are -- one column regardless of whether the row is
-- still pre-claim (roster_codes.phone_number) or a real profile
-- (profiles.phone_number, the live, editable value from then on). Rebuilt
-- from migration 34's version (the most recent), not migration 20's, so
-- is_demo is not lost.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW roster_code_status
WITH (security_invoker = true) AS
SELECT c.employee_code,
       c.display_name,
       c.initial_role,
       c.is_claimed,
       c.claim_enabled,
       c.claimed_at,
       p.id AS profile_id,
       p.is_active,
       COALESCE(p.default_kamut, c.default_kamut) AS default_kamut,
       COALESCE(p.is_demo, c.is_demo) AS is_demo,
       COALESCE(p.phone_number, c.phone_number) AS phone_number
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;
