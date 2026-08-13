-- ============================================================================
-- Migration 42 : Replace the notify GUCs with a config table
--
-- Migration 41's notification_tick() read notify_url/cron_secret via
-- current_setting('app.settings.*'), meant to be set once with
-- `ALTER DATABASE postgres SET app.settings.* = '...'`. That statement fails
-- on this hosted project: `ERROR: 42501: permission denied to set parameter
-- "app.settings.notify_url"` -- the Management API's role isn't allowed to
-- alter database-level config, and neither is any other role available here
-- short of a superuser this project doesn't have direct access to.
--
-- Replaced with an ordinary table instead. Same secrets-never-in-git
-- discipline as everywhere else in this project: the table starts empty
-- (NULL), and Ben fills it in with a plain UPDATE from the SQL editor after
-- this migration applies -- an operation that only needs standard DML
-- privileges, which the Management API role already has (proven by every
-- other migration and test in this project).
--
-- RLS is enabled with ZERO policies -- not "manager can read", genuinely no
-- policies at all -- so `authenticated`/`anon` get no access whatsoever via
-- PostgREST. Only the SQL editor (runs as postgres) and notification_tick()
-- (SECURITY DEFINER, owned by postgres) can ever read this table.
-- ============================================================================

CREATE TABLE notification_secrets (
  id          BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE CHECK (id),
  notify_url  TEXT,
  cron_secret TEXT
);

INSERT INTO notification_secrets (id) VALUES (TRUE);

ALTER TABLE notification_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_secrets FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE notification_secrets IS
  'Singleton holding the send-notifications URL and its shared secret, read by notification_tick(). No RLS policies at all -- unreachable via PostgREST regardless of role. Fill in via a plain UPDATE from the SQL editor after this migration applies; starts NULL, which notification_tick() treats as "not configured yet, do nothing".';


CREATE OR REPLACE FUNCTION public.notification_tick()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, cron
AS $$
DECLARE
  v_url      TEXT;
  v_secret   TEXT;
  v_headers  JSONB;
  v_deadline TIMESTAMPTZ;
BEGIN
  SELECT notify_url, cron_secret INTO v_url, v_secret FROM notification_secrets WHERE id;

  IF v_url IS NULL OR v_secret IS NULL OR v_url = '' OR v_secret = '' THEN
    RETURN; -- not configured yet -- see this table's comment
  END IF;
  v_headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);

  IF public.broadcast_due() THEN
    PERFORM net.http_post(url := v_url, headers := v_headers, body := jsonb_build_object('type', 'broadcast'));
  END IF;

  SELECT submission_deadline INTO v_deadline
    FROM roster_weeks WHERE status = 'open' ORDER BY week_start ASC LIMIT 1;

  IF v_deadline IS NOT NULL THEN
    IF public.reminder_due(v_deadline, INTERVAL '24 hours') THEN
      PERFORM net.http_post(url := v_url, headers := v_headers, body := jsonb_build_object('type', 'reminder_24h'));
    END IF;
    IF public.reminder_due(v_deadline, INTERVAL '2 hours') THEN
      PERFORM net.http_post(url := v_url, headers := v_headers, body := jsonb_build_object('type', 'reminder_2h'));
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_tick() FROM PUBLIC, anon, authenticated;
