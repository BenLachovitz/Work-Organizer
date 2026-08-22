-- ============================================================================
-- Migration 49 : pin_reset_otps -- WhatsApp OTP state for self-service PIN reset
--
-- Backing table for the new whatsapp-pin-reset Edge Function: a guard who
-- forgot her PIN can now recover it herself via a WhatsApp one-time code
-- (Meta Cloud API) instead of only through the manager-mediated reset-pin
-- fallback (migration 47's neighbour, shipped last session, which stays in
-- place for any guard with no phone_number on file yet -- migration 48).
--
-- Follows the EXACT "fully sealed" shape webauthn_challenges (migration 46)
-- and notification_secrets (migration 42) already use: RLS on, ZERO
-- policies, REVOKE ALL from every PostgREST role -- completely unreachable
-- via the API regardless of role, only the whatsapp-pin-reset function's
-- service-role client can ever touch it. No consumed_at column, for the same
-- reason webauthn_challenges has none: a row is DELETEd the instant it's
-- consumed (by otp_complete succeeding) or superseded (a fresh otp_request
-- for the same code deletes any prior live row first), so "at most one live
-- OTP per employee_code" holds without a partial unique index.
--
-- Attempts are capped PER ROW (5), not via claim_attempts' rolling
-- (code, ip) time-window throttle -- a different shape for a different job.
-- claim_rate_ok/record_claim_attempt gate how often the (paid) WhatsApp send
-- itself can be triggered; this gates how many WRONG GUESSES one live code
-- tolerates before it's dead and a fresh send is required. Reusing one
-- mechanism for both would either make brute-forcing a live code too cheap
-- (a rolling window allows many guesses) or make legitimate re-sends too
-- expensive (a per-row cap doesn't limit how often otp_request itself fires).
-- ============================================================================

CREATE TABLE pin_reset_otps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code TEXT NOT NULL,
  otp_hash      TEXT NOT NULL,        -- sha-256 hex of the 6-digit code -- never the plaintext
  attempts      SMALLINT NOT NULL DEFAULT 0,
  verified_at   TIMESTAMPTZ,
  verify_token  TEXT,                 -- set alongside verified_at; required by otp_complete
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pin_reset_otps_code ON pin_reset_otps (employee_code, created_at DESC);

ALTER TABLE pin_reset_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pin_reset_otps FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE pin_reset_otps IS
  'Short-lived WhatsApp OTP state for self-service PIN reset (whatsapp-pin-reset Edge Function). Fully sealed -- RLS on, zero policies, no PostgREST access at all regardless of role. Rows are deleted on consumption or superseded by a fresh request.';

-- ----------------------------------------------------------------------------
-- Widen claim_attempts.action to also cover otp_request -- reusing
-- claim_rate_ok()/record_claim_attempt() completely unmodified (migration 4,
-- since narrowed to pure audit-only by migration 6: no auto-disable branch
-- exists any more to worry about triggering for the wrong action). Only
-- otp_request goes through this table -- otp_verify/otp_complete are
-- throttled by pin_reset_otps.attempts instead (see header).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT con.conname INTO v_conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
   WHERE rel.relname = 'claim_attempts'
     AND con.contype = 'c'
     AND att.attname = 'action';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE claim_attempts DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE claim_attempts
  ADD CONSTRAINT claim_attempts_action_check
  CHECK (action IN ('status', 'claim', 'otp_request'));
