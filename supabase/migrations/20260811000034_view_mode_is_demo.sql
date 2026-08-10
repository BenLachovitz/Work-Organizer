-- ============================================================================
-- Migration 34 : is_demo flag, for the admin real/test view-mode toggle
--
-- The manager wants a header toggle that switches the admin dashboard's
-- employee lists between "real" and "test" (דמה) accounts, with Ben (005396)
-- always visible in both since he doesn't have a separate demo account.
--
-- "- דמה" has been a display_name suffix convention since migration 25, but
-- string-matching a Hebrew suffix everywhere it matters is fragile (a real
-- employee's name could someday contain it; renaming a demo guard would
-- silently break the filter). A real column is the explicit, robust source
-- of truth instead -- the same call this project already made for default_
-- kamut (migration 19/20): one column on profiles, mirrored on roster_codes
-- for the pre-claim state, because a row can live in either table depending
-- on whether the employee has registered yet.
--
-- Backfilled by known employee_code, not by matching the display_name suffix
-- -- so the flag stays correct even if a demo guard is renamed later, and
-- doesn't depend on the Hebrew string matching exactly.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE roster_codes
  ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.is_demo IS
  'True for the seeded mock guards used to sanity-test the scheduler, false for real employees (Ben included). Source of truth for the admin real/test view-mode toggle -- not inferred from display_name.';
COMMENT ON COLUMN roster_codes.is_demo IS
  'Same flag as profiles.is_demo, held here for the pre-claim state. Copied onto profiles at claim time by trg_profiles_is_demo, mirroring how default_kamut already carries itself across claiming (migration 20).';

-- The 7 known mock guards (migration 25's rename target codes). Ben (005396)
-- and every real code stay FALSE -- he was never in this set to begin with.
UPDATE profiles SET is_demo = TRUE
  WHERE employee_code IN ('100001', '100002', '100003', '100004', '100005', '100006', '100007');
UPDATE roster_codes SET is_demo = TRUE
  WHERE employee_code IN ('100001', '100002', '100003', '100004', '100005', '100006', '100007');

-- ----------------------------------------------------------------------------
-- Carry the flag from roster_codes to profiles at claim time, the same shape
-- trg_profiles_default_kamut already uses (migration 20) -- a trigger rather
-- than a claim-code change, so the one publicly-reachable unauthenticated
-- write path in the system stays untouched no matter who or what inserts the
-- row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copy_is_demo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.is_demo := COALESCE(
    (SELECT is_demo FROM roster_codes WHERE employee_code = NEW.employee_code),
    NEW.is_demo
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_is_demo
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.copy_is_demo();

-- roster_code_status needs the flag too, for the Team Management page's list.
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
       COALESCE(p.is_demo, c.is_demo) AS is_demo
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;
