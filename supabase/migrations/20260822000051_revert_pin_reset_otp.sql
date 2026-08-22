-- ============================================================================
-- Migration 51 : Revert the self-service forgot-PIN OTP feature entirely
--
-- Migrations 48-50 built and then rebuilt a guard-side self-service forgot-
-- PIN flow (first on Meta WhatsApp, then pivoted to a push notification).
-- After it shipped, a session-persistence regression appeared in production
-- (every page refresh, on every device, signed Ben back out to the Login
-- page) that could not be pinned down to any specific line of the changes
-- made -- a full diff of every file touched since the manager-only
-- reset-pin tool (migration 47's neighbour) showed nothing touching session
-- storage, the Supabase client config, or the passkey ceremony at all, and
-- the regression reproduced even on a device with no passkey registered,
-- ruling out the app-restart lock gate too. Rather than keep debugging a
-- live regression with an unconfirmed cause, Ben's call: revert the whole
-- feature back to the last confirmed-stable point (the manager-only
-- reset-pin tool) and revisit self-service recovery later, in isolation.
--
-- Migrations 48-50 are deliberately NOT deleted or edited -- they already
-- ran against the live database, and this project's own discipline is that
-- migrations are discovered, never rewritten or skipped after the fact. This
-- migration only reverses their net effect, the same way any other schema
-- change gets undone: with a new migration on top, never a rewritten past
-- one. phone_number needs no further action here -- migration 50 already
-- fully reverted it (columns, trigger, view) before this regression was
-- even found; only pin_reset_otps and the two widened CHECK constraints
-- are still live and need reversing.
-- ============================================================================

DROP TABLE IF EXISTS pin_reset_otps;

-- claim_attempts.action back to its pre-migration-49 shape. Rows logged
-- under 'otp_request' during the reverted feature's testing are audit noise
-- for a feature that no longer exists -- deleted so the tightened CHECK can
-- be re-added (a CHECK addition validates every existing row).
DELETE FROM claim_attempts WHERE action = 'otp_request';

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
  CHECK (action IN ('status', 'claim'));

-- notification_log.notification_type back to its pre-migration-50 shape.
-- Same reasoning as above -- rows logged under 'pin_reset_otp' during
-- testing are deleted so the tightened CHECK can be re-added.
DELETE FROM notification_log WHERE notification_type = 'pin_reset_otp';

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
     'guard_submitted','guard_cancelled'));
