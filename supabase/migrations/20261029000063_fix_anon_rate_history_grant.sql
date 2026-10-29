-- ============================================================================
-- Migration 63 : Close an anon-access gap on my_hourly_rate_history()
--
-- Supabase grants EXECUTE on every new function in `public` to anon and
-- authenticated by default (ALTER DEFAULT PRIVILEGES, set at the project
-- level, not something any migration here controls). Migration 61 only
-- revoked from PUBLIC, which does not touch anon's own direct grant -- so
-- an entirely unauthenticated caller (no login at all) could call this
-- function and get back the GUARD rate (is_manager() resolves FALSE for a
-- null auth.uid(), landing on the guard branch). Found by testing the live
-- function with no session at all before trusting it.
--
-- This revokes anon's default grant explicitly. `authenticated` keeps its
-- grant from migration 61 -- a real guard or manager calling this for
-- their OWN rate is exactly the intended use.
-- ============================================================================

REVOKE ALL ON FUNCTION public.my_hourly_rate_history() FROM PUBLIC, anon;
