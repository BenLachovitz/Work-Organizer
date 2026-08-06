-- ============================================================================
-- Migration 5 : Tighten table grants
--
-- Found by the reachability audit in `npm run db:verify`.
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting anon and authenticated full
-- CRUD on every new table in `public`. A later `GRANT SELECT` does NOT revoke
-- the rest -- GRANT only adds. So migration 3's `GRANT SELECT ON roster_codes`
-- left INSERT/UPDATE/DELETE in place from the default.
--
-- Neither leak was exploitable: roster_codes has no write policy and
-- schema_migrations has none at all, so RLS denied every write. But that left
-- RLS as the ONLY thing standing between a guard and the badge-code table.
-- Grants and RLS should both have to fail before anything is reachable.
-- ============================================================================

-- roster_codes is service-role-write-only. Managers read it (policy
-- codes_manager_read); nobody writes it through PostgREST.
REVOKE INSERT, UPDATE, DELETE ON roster_codes FROM authenticated;

-- schema_migrations is created by supabase/apply.mjs and is pure infrastructure.
-- No API client has any business touching it.
REVOKE ALL ON schema_migrations FROM anon, authenticated;

-- Belt and braces: anon should hold nothing anywhere. Re-run here because
-- tables created after migration 3 picked the default grants back up.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- Same reasoning for the manager status view.
REVOKE INSERT, UPDATE, DELETE ON roster_code_status FROM authenticated;
