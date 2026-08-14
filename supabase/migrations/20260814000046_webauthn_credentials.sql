-- ============================================================================
-- Migration 46 : App-scoped WebAuthn credentials
--
-- Replaces v2.16.0's use of Supabase Auth's native, experimental Passkey API
-- (auth.passkey.*) with a from-scratch WebAuthn implementation. That API only
-- creates true, discoverable, OS-synced passkeys (shown in the phone's system
-- "Passwords & passkeys" list, eligible to sync to the guard's Google/Apple
-- account) -- real-device testing confirmed that isn't what's wanted here: a
-- credential scoped to this app and this device, never synced or offered
-- through the OS account-picker UI. WebAuthn supports that directly via
-- residentKey: 'discouraged' at registration (handled in the webauthn Edge
-- Function, not here) -- this migration just gives that flow somewhere to
-- store the result.
--
-- Two tables:
--   webauthn_credentials -- one row per registered device, guard-owned, same
--     shape as push_subscriptions (migration 40): the guard can read/rename/
--     remove their own rows. Deliberately NO insert grant to `authenticated`
--     at all (tighter than push_subscriptions' FOR ALL) -- a row can only
--     ever be created by the Edge Function's service-role client after an
--     actual verified WebAuthn ceremony, never forged directly by a guard's
--     own client.
--   webauthn_challenges -- short-lived server-side nonces for the two-step
--     register/authenticate ceremony. Sealed exactly like notification_secrets
--     (migration 42): RLS enabled with ZERO policies, so `authenticated`/anon
--     get no access at all via PostgREST regardless of role -- only the Edge
--     Function's service-role client (which bypasses RLS/grants entirely)
--     ever touches it. Rows are deleted the moment they're consumed
--     (single-use, doubling as cleanup); an abandoned ceremony just leaves a
--     harmless expired row.
-- ============================================================================

CREATE TABLE webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    BYTEA NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  device_type   TEXT,
  backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
  transports    TEXT[],
  friendly_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

COMMENT ON TABLE webauthn_credentials IS
  'One row per app-scoped WebAuthn credential (residentKey: discouraged -- not a synced OS passkey). credential_id is the base64url credential ID from the authenticator, globally unique. public_key/counter are what verifyAuthenticationResponse() checks a sign-in attempt against.';

GRANT SELECT, UPDATE, DELETE ON webauthn_credentials TO authenticated;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY webauthn_credentials_read ON webauthn_credentials
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY webauthn_credentials_self_update ON webauthn_credentials
  FOR UPDATE TO authenticated
  USING      (guard_id = auth.uid())
  WITH CHECK (guard_id = auth.uid());

CREATE POLICY webauthn_credentials_self_delete ON webauthn_credentials
  FOR DELETE TO authenticated
  USING (guard_id = auth.uid());

CREATE INDEX webauthn_credentials_guard_idx ON webauthn_credentials (guard_id);


CREATE TABLE webauthn_challenges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'auth')),
  challenge  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE webauthn_challenges IS
  'Short-lived server-issued nonces for the two-step WebAuthn ceremony. No RLS policies at all -- unreachable via PostgREST regardless of role, same pattern as notification_secrets (migration 42). Consumed rows are deleted immediately by the Edge Function; an abandoned ceremony just leaves a harmless expired row.';

ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON webauthn_challenges FROM PUBLIC, anon, authenticated;

CREATE INDEX webauthn_challenges_guard_purpose_idx ON webauthn_challenges (guard_id, purpose);
