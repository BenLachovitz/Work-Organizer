-- ============================================================================
-- Migration 73 : roster_code_status exposes the live profiles.role (not just
-- the frozen initial_role), plus is_silenced and is_protected, for
-- TeamManagement's new role/silence controls.
--
-- Rebuilt from migration 66's shape (the most recent on disk), per that
-- migration's own precedent, so nothing added since is lost.
-- ============================================================================

DROP VIEW IF EXISTS roster_code_status;

CREATE VIEW roster_code_status
WITH (security_invoker = true) AS
SELECT c.employee_code,
       c.display_name,
       c.initial_role,
       -- Live role once claimed; falls back to the frozen creation-time
       -- value for a still-pending invitation (which has no profiles row).
       COALESCE(p.role, c.initial_role) AS role,
       c.is_claimed,
       c.claim_enabled,
       c.claimed_at,
       p.id AS profile_id,
       p.is_active,
       COALESCE(p.default_kamut, c.default_kamut) AS default_kamut,
       COALESCE(p.is_demo, c.is_demo) AS is_demo,
       COALESCE(p.phone_number, c.phone_number) AS phone_number,
       -- No roster_codes mirror for either (migrations 71/72) -- FALSE for
       -- anything unclaimed, since there is no profile yet to be silenced or
       -- protected.
       COALESCE(p.is_silenced, FALSE) AS is_silenced,
       COALESCE(p.is_protected, FALSE) AS is_protected
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;
