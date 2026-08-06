-- ============================================================================
-- Migration 6 : Remove the auto-disable rule from record_claim_attempt
--
-- Migration 4 disabled a badge code after 5 failed claims. Gate B showed the
-- rule was both unreachable and, if made reachable, actively harmful:
--
--   * A claim against a NONEXISTENT code matches no row -> disables nothing.
--   * A claim against an ALREADY-CLAIMED code is excluded by `NOT is_claimed`.
--   * A claim against an UNCLAIMED code with a valid PIN SUCCEEDS -- there is
--     no "wrong password" during registration; claiming creates the account.
--
--   So it could only fire on a corrupted state. And the obvious "fix" -- also
--   counting malformed requests -- would let any unauthenticated stranger
--   permanently lock any guard out of registering by sending five junk
--   payloads. An unbounded, attacker-triggered lockout is a denial-of-service
--   control, not a security one.
--
-- What actually defends this endpoint:
--   1. Rate limiting (10/code, 30/IP per 15 min) -- bounded and self-healing.
--   2. `claim_enabled` as a MANUAL manager kill-switch.
--   3. `roster_code_status`, so a manager can see who has registered and when,
--      and reset a code that was claimed by the wrong person.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_claim_attempt(
  p_code TEXT, p_ip TEXT, p_action TEXT, p_succeeded BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Audit only. Disabling a code is a deliberate manager action, never an
  -- automatic consequence of traffic from an unauthenticated caller.
  INSERT INTO claim_attempts (employee_code, ip, action, succeeded)
  VALUES (p_code, p_ip, p_action, p_succeeded);
END;
$$;

REVOKE ALL ON FUNCTION public.record_claim_attempt(TEXT, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN roster_codes.claim_enabled IS
  'Manual manager kill-switch. Never set automatically -- see migration 6.';
