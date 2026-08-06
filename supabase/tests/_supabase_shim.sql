-- ============================================================================
-- Supabase compatibility shim -- TEST HARNESS ONLY. Never applied to a real
-- project, where Supabase provides all of this natively.
--
-- Recreates the minimum surface our migrations depend on:
--   * the anon / authenticated / service_role roles
--   * the auth schema, auth.users, and auth.uid()
--
-- auth.uid() reads `request.jwt.claim.sub` exactly as Supabase's does, so the
-- tests impersonate a user with set_config() the same way a real JWT would.
-- ============================================================================

CREATE ROLE anon          NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id                 UUID PRIMARY KEY,
  instance_id        UUID,
  aud                TEXT,
  role               TEXT,
  email              TEXT UNIQUE,
  encrypted_password TEXT,
  email_confirmed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Identical semantics to Supabase's auth.uid(): NULL when unauthenticated.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
