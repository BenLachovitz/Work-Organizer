-- ============================================================================
-- Migration 45 : Manager notified when a guard submits, edits, or cancels
--
-- Two new notification_type values, 'guard_submitted' and 'guard_cancelled'.
-- Deliberately client-triggered (a guard's own browser calls send-notifications
-- right after save_week_preferences/delete_week_submission succeeds), NOT a
-- database trigger on weekly_submissions -- test:cloud calls those RPCs
-- directly, dozens of times per run, against the LIVE project (there is no
-- separate test database in this project). A table-level trigger would fire
-- on every one of those and push a real notification to the real manager's
-- phone on every future test run. Client code bypasses that entirely: the
-- test suite talks to the RPC over supabase-js directly, never through
-- React, so it never reaches the code that fires the notification. It also
-- means the manager's own edit-on-behalf-of path (manager_save_week_preferences
-- / manager_delete_week_submission, and their dedicated hooks in
-- useManager.ts) is naturally excluded without needing an auth.uid() check --
-- it is simply a different code path that was never wired to notify.
--
-- Neither type is deduped by notification_log_sent_once (migration 43's
-- narrowed predicate already only lists the three cron types) -- each
-- submit/edit/cancel is a distinct, real event worth its own notification.
-- ============================================================================

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
    ('broadcast','reminder_24h','reminder_2h','roster_published','guard_submitted','guard_cancelled'));

-- ----------------------------------------------------------------------------
-- manager_targets -- mirrors broadcast_targets()/unsubmitted_targets()
-- (migration 40): who gets a "guard submitted" notification. Reuses
-- is_manager()'s own role set (manager OR admin) rather than hardcoding
-- Ben's id, so this keeps working if a second manager is ever added.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.manager_targets()
RETURNS TABLE (guard_id UUID)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM profiles WHERE role IN ('manager', 'admin') AND is_active;
$$;

REVOKE ALL ON FUNCTION public.manager_targets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_targets() TO authenticated;
