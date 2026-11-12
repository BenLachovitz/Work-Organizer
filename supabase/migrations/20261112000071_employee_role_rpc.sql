-- ============================================================================
-- Migration 71 : Employee role control (promote/demote) + a protected-account
-- flag for the one account this must never apply to
--
-- is_manager() (migration 2) is purely role-based (`role IN ('manager',
-- 'admin')`), never keyed to any specific profile id -- every is_manager()-
-- gated RLS policy and SECURITY DEFINER RPC in this project already works
-- correctly the moment a second row has that role. manager_targets()
-- (migration 45) was already written anticipating this ("keeps working if a
-- second manager is ever added"). profiles_manager_write (migration 3,
-- FOR ALL ... USING (is_manager()) WITH CHECK (is_manager())) already lets a
-- manager UPDATE any row's role today. What's missing is a validated write
-- path with a lockout guard -- nothing in the app calls this today.
--
-- is_protected is a second, independent safeguard on top of that: a flag
-- that makes set_employee_role refuse to touch a row's role AT ALL,
-- regardless of caller or how many other managers exist. It has no write
-- path anywhere in the app -- no RPC parameter, no column grant, nothing in
-- guard_profile_columns()'s blocklist (there is nothing to defend against,
-- since nothing here can ever set it to TRUE). The only way it is ever set
-- is a one-time, manual UPDATE the owner runs himself directly against the
-- database, e.g.:
--
--   UPDATE profiles SET is_protected = TRUE WHERE employee_code = '005396';
--
-- Deliberately not part of this migration's DDL -- this migration only adds
-- the column (defaulted FALSE for every existing and future row) and the
-- function that respects it.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN is_protected BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.is_protected IS
  'True only for the creator''s own account, set once by hand directly in the database -- no app code path (RPC, RLS grant, or UI) ever writes this column. set_employee_role() refuses to change a protected row''s role at all, for any caller, regardless of how many other managers exist.';

-- ----------------------------------------------------------------------------
-- set_employee_role -- promote a guard to manager, or demote a manager back
-- to guard. SECURITY INVOKER, not DEFINER: unlike delete_employee (which must
-- reach auth.users, invisible through PostgREST), this only ever writes
-- profiles.role, and profiles_manager_write already permits that write for a
-- manager caller. The explicit is_manager() check below is the same
-- two-layer defense this project always applies elsewhere (e.g. reset-pin:
-- the platform/RLS already refuses a non-manager; this just fails fast with
-- a clear error instead of an opaque "0 rows updated").
--
-- Checked in order: (1) caller must be a manager: (2) the target row must not
-- be protected -- checked before anything else, so a protected account's role
-- can never change through this function, not even by itself; (3) only when
-- demoting (p_role = 'guard'), count every OTHER manager/admin row -- if none
-- remain, refuse. Self-demotion is deliberately allowed otherwise (the Ben
-- handover needs it: promote the replacement, then demote yourself) -- the
-- count above already makes that safe.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_employee_role(p_profile_id UUID, p_role public.user_role)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_protected BOOLEAN;
  v_remaining INT;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT is_protected INTO v_protected FROM profiles WHERE id = p_profile_id;
  IF v_protected IS NULL THEN
    RAISE EXCEPTION 'no such profile' USING ERRCODE = '42704';
  END IF;

  IF v_protected THEN
    RAISE EXCEPTION 'this account''s role is protected and cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF p_role = 'guard' THEN
    SELECT COUNT(*) INTO v_remaining
      FROM profiles
     WHERE role IN ('manager', 'admin') AND id <> p_profile_id;
    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'cannot demote the last remaining manager' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE profiles SET role = p_role WHERE id = p_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_employee_role(UUID, public.user_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_employee_role(UUID, public.user_role) TO authenticated;
