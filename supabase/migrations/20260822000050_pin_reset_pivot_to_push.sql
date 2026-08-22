-- ============================================================================
-- Migration 50 : Forgot-PIN pivots from WhatsApp OTP to a push-notification OTP
--
-- Migration 48/49 (last session) built the guard-side forgot-PIN OTP flow on
-- top of Meta's WhatsApp Business Cloud API, which needed a phone_number on
-- file for every guard. Before any real message was ever sent (WHATSAPP_*
-- secrets were never configured), Ben discovered his Meta account is
-- restricted from Ads over a disputed fraudulent charge -- and Meta requires
-- a Business Portfolio to attach a WhatsApp Business Account to an app at
-- all, with no way around it (confirmed: not even "create an app without a
-- use case" avoids it, since a WhatsApp Business Account is fundamentally a
-- Business Portfolio asset). Rather than wait on an account dispute or stand
-- up a new Business Portfolio under a different admin, Ben's call: deliver
-- the OTP through the app's OWN already-working push notification system
-- instead (send-notifications, migrations 40-45) -- no new external
-- dependency, no new account to manage, reuses infrastructure already live
-- in production.
--
-- The OTP mechanics themselves (pin_reset_otps, its hash/attempts/expiry/
-- verify_token shape, claim_attempts' 'otp_request' action) are UNCHANGED --
-- only the delivery channel moves from a Meta Graph API call to
-- send-notifications' existing web-push machinery. phone_number, which
-- existed for no other reason than feeding that Meta call, is reverted
-- entirely -- nothing else in this project ever used it, so there is nothing
-- to preserve. See migration 48's own header for the shape being undone.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Revert phone_number: the VIEW depends on the column, so it must be
--    rebuilt (dropping the reference) BEFORE the column itself can be
--    dropped -- otherwise Postgres refuses with "other objects depend on it".
--    A plain CREATE OR REPLACE cannot do it either: Postgres refuses to drop
--    a column from an existing view's output shape that way (42P16) -- the
--    view must be dropped and recreated outright.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS roster_code_status;

CREATE VIEW roster_code_status
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
       COALESCE(p.is_demo, c.is_demo) AS is_demo
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;

DROP TRIGGER IF EXISTS trg_profiles_phone_number ON public.profiles;
DROP FUNCTION IF EXISTS public.copy_phone_number();

ALTER TABLE roster_codes DROP COLUMN IF EXISTS phone_number;
ALTER TABLE profiles     DROP COLUMN IF EXISTS phone_number;

-- ----------------------------------------------------------------------------
-- 2. notification_log gains 'pin_reset_otp' -- the guard's own forgot-PIN
--    code, delivered as a push notification instead of a WhatsApp message.
--    Same dynamic drop-and-recreate as migration 45 (the constraint's actual
--    name is whatever Postgres auto-generated it as, looked up rather than
--    guessed).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT con.conname INTO v_conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
   WHERE rel.relname = 'notification_log'
     AND con.contype = 'c'
     AND att.attname = 'notification_type';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notification_log DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_notification_type_check
  CHECK (notification_type IN
    ('broadcast','reminder_24h','reminder_2h','roster_published',
     'guard_submitted','guard_cancelled','pin_reset_otp'));

-- notification_log_sent_once (migration 43) is already an ALLOWLIST scoped to
-- just the three cron types -- pin_reset_otp falls outside it automatically,
-- no further change needed: each OTP request is a genuine, distinct event,
-- not a duplicate to suppress, same as guard_submitted/guard_cancelled.
