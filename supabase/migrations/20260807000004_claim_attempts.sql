-- ============================================================================
-- Migration 4 : Badge-claim throttling
--
-- The claim-code Edge Function is deployed WITHOUT JWT verification -- it has
-- to be, because the caller has no session yet. That makes it the one publicly
-- reachable write path in the system, so rate limiting is the security control,
-- not a nicety.
--
-- Threat: a 6-digit code space is only 1,000,000 wide and holds ~10 valid
-- codes. Unthrottled, the `status` action is a trivial enumeration oracle and
-- `claim` is a race to steal an unclaimed colleague's identity.
-- ============================================================================

CREATE TABLE claim_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code TEXT,
  ip            TEXT,
  action        TEXT NOT NULL CHECK (action IN ('status', 'claim')),
  succeeded     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_claim_attempts_code ON claim_attempts (employee_code, created_at DESC);
CREATE INDEX idx_claim_attempts_ip   ON claim_attempts (ip, created_at DESC);

-- Service-role only: RLS on with zero policies = deny-all for anon and
-- authenticated. The Edge Function reaches it with the secret key.
ALTER TABLE claim_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON claim_attempts FROM anon, authenticated;


-- ----------------------------------------------------------------------------
-- Window and thresholds.
--   per code : 10 attempts / 15 min  -- stops targeting one colleague's badge
--   per IP   : 30 attempts / 15 min  -- stops sweeping the whole code space
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_rate_ok(p_code TEXT, p_ip TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window CONSTANT INTERVAL := INTERVAL '15 minutes';
  v_by_code INT;
  v_by_ip   INT;
BEGIN
  SELECT COUNT(*) INTO v_by_code
    FROM claim_attempts
   WHERE employee_code = p_code AND created_at > NOW() - v_window;

  SELECT COUNT(*) INTO v_by_ip
    FROM claim_attempts
   WHERE ip = p_ip AND p_ip IS NOT NULL AND created_at > NOW() - v_window;

  RETURN v_by_code < 10 AND v_by_ip < 30;
END;
$$;


-- ----------------------------------------------------------------------------
-- Records an attempt, and disables a code after repeated failed CLAIMS.
--
-- Auto-disable applies to 'claim' only. A wrong-code typo hitting 'status'
-- should not be able to lock a real guard out of registering -- that would turn
-- the throttle into a denial-of-service against the team.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_claim_attempt(
  p_code TEXT, p_ip TEXT, p_action TEXT, p_succeeded BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_failures INT;
BEGIN
  INSERT INTO claim_attempts (employee_code, ip, action, succeeded)
  VALUES (p_code, p_ip, p_action, p_succeeded);

  IF p_action = 'claim' AND NOT p_succeeded THEN
    SELECT COUNT(*) INTO v_failures
      FROM claim_attempts
     WHERE employee_code = p_code
       AND action = 'claim'
       AND NOT succeeded
       AND created_at > NOW() - INTERVAL '15 minutes';

    IF v_failures >= 5 THEN
      UPDATE roster_codes
         SET claim_enabled = FALSE
       WHERE employee_code = p_code AND NOT is_claimed;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rate_ok(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_claim_attempt(TEXT, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;


-- ----------------------------------------------------------------------------
-- Manager view of registration status, for the dashboard. SECURITY INVOKER, so
-- roster_codes' own manager-only policy still governs access.
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
       p.is_active
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;
