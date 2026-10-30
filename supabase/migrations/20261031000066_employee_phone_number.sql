-- ============================================================================
-- Migration 66 : phone_number on the pre-claim/post-claim pair (re-added)
--
-- A phone_number column existed once before (migration 48), for a
-- self-service WhatsApp-OTP forgot-PIN flow that was later fully reverted
-- (migration 50) -- but for a reason that had nothing to do with the phone
-- number itself (the Meta WhatsApp Business API path was abandoned; the OTP
-- delivery channel moved to this app's own push notifications instead). This
-- migration re-adds the exact same column, for a new and unrelated purpose:
-- the "currently on shift" homepage card (v2.28.0) gets tap-to-call and
-- tap-to-WhatsApp links for whichever guard is currently on shift -- a
-- `https://wa.me/<number>` deep link, which needs no API or account, just a
-- phone number to build the URL from.
--
-- Same dual-column shape as default_kamut (migration 20) and is_demo
-- (migration 34): a column on roster_codes for a not-yet-claimed invitation,
-- the same column on profiles for a live guard, carried across at claim time
-- by a dedicated trigger -- mirroring copy_is_demo()/trg_profiles_is_demo
-- (one trigger per copied column, not a shared function).
--
-- Nullable on both tables, unconditionally, and deliberately OPTIONAL this
-- time (unlike migration 48, where AddEmployeeCard required it to feed the
-- WhatsApp OTP call) -- nothing in the app depends on a phone number existing
-- any more; a guard with none on file just shows no call/WhatsApp icons on
-- the shift card.
--
-- No RLS changes: profiles_read is already `USING (TRUE)` (migration 3) --
-- any authenticated guard already reads every column of every other guard's
-- profiles row, confirmed by useVisibleRosters()'s existing unfiltered
-- profiles.select('*') -- and roster_codes/profiles already have unrestricted-
-- by-column manager-only write policies. Same reasoning as migration 48.
--
-- Deliberately NO uniqueness constraint -- Ben's explicit instruction from
-- migration 48 still stands; not re-raising it here.
-- ============================================================================

ALTER TABLE roster_codes ADD COLUMN phone_number TEXT;
ALTER TABLE profiles     ADD COLUMN phone_number TEXT;

COMMENT ON COLUMN roster_codes.phone_number IS
  'E.164 phone number, set before the employee has claimed their code. Copied onto profiles.phone_number at claim time by trg_profiles_phone_number. Optional, no uniqueness constraint.';
COMMENT ON COLUMN profiles.phone_number IS
  'E.164 phone number, used for the "currently on shift" homepage card''s tap-to-call/tap-to-WhatsApp links. NULL means this guard shows up with no call/WhatsApp icons there.';

-- ----------------------------------------------------------------------------
-- Carry the number from roster_codes to profiles at claim time -- identical
-- to migration 48's original trigger.
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
-- roster_code_status: add phone_number back, COALESCE'd the same way
-- default_kamut/is_demo already are. Rebuilt from migration 50's shape (the
-- most recent on disk), not migration 48's, so nothing added since is lost.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS roster_code_status;

CREATE VIEW roster_code_status
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
