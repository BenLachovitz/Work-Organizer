-- ============================================================================
-- Migration 60 : Per-guard hourly rate (estimated gross salary feature)
--
-- One flat hourly wage per guard, manager-set, same dual-column shape as
-- default_kamut (migrations 19/20): it lives on profiles once claimed, but a
-- manager may also set it on roster_codes BEFORE the employee has claimed
-- their code, and trg_profiles_hourly_rate carries that value across at the
-- moment the profile is created. Overtime/Shabbat multipliers (src/lib/
-- payroll.ts) apply on top of this single number rather than the guard
-- having separate rates per shift type.
--
-- NULL means no rate has been set yet (either column) -- the work-log UI
-- must treat that as "no estimate available", not as a rate of zero. Unlike
-- default_kamut, NULL is the real default here: there is no sane "0" wage.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN hourly_rate NUMERIC(8, 2) CHECK (hourly_rate IS NULL OR hourly_rate > 0);

COMMENT ON COLUMN profiles.hourly_rate IS
  'Flat gross hourly wage, manager-set, used only by the personal work-log/estimated-salary feature. NULL until set, either here or on roster_codes before claiming. No history: a rate change applies to every not-yet-computed estimate, past and future alike.';

ALTER TABLE roster_codes
  ADD COLUMN hourly_rate NUMERIC(8, 2) CHECK (hourly_rate IS NULL OR hourly_rate > 0);

COMMENT ON COLUMN roster_codes.hourly_rate IS
  'Hourly wage, set before the employee has claimed their code. Copied onto profiles.hourly_rate at claim time by trg_profiles_hourly_rate; has no further effect afterwards.';

-- ----------------------------------------------------------------------------
-- Carry the rate from roster_codes to profiles at the moment a profile is
-- created, exactly like copy_default_kamut() (migration 20).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copy_hourly_rate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.hourly_rate := COALESCE(
    (SELECT hourly_rate FROM roster_codes WHERE employee_code = NEW.employee_code),
    NEW.hourly_rate
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_hourly_rate
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.copy_hourly_rate();

-- ----------------------------------------------------------------------------
-- roster_code_status: add hourly_rate, COALESCE'd the same way default_kamut
-- already is -- whichever of the two columns currently holds the truth.
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
       COALESCE(p.hourly_rate, c.hourly_rate) AS hourly_rate
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;

-- ----------------------------------------------------------------------------
-- Extend the existing privilege-escalation guard (migration 2) so a guard can
-- see their own rate but never set it themselves -- the same column-level
-- lock already in place for role/is_active/employee_code.
-- ----------------------------------------------------------------------------
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
    IF NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.hourly_rate';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
