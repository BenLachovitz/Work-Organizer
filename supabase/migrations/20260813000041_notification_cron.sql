-- ============================================================================
-- Migration 41 : pg_cron + pg_net scheduling for push notifications
--
-- First use of both extensions in this project.
--
-- ORIGINAL DESIGN (worth recording, since it's why this looks the way it
-- does): three separate weekly cron.schedule() entries, one per notification
-- type, each firing once a week at a precomputed day/time -- avoiding any
-- kind of repeating "is it due yet?" poll. That design assumed
-- `ALTER DATABASE postgres SET cron.timezone = 'Asia/Jerusalem'` would make
-- pg_cron's hour/day-of-week fields evaluate in Israel wall-clock time. It
-- does not: Supabase's hosted Postgres rejects that GUC outright
-- (`55P02: parameter "cron.timezone" cannot be changed without restarting
-- the server`) and a client cannot trigger that restart.
--
-- REVISED DESIGN: a single cron job, `notification_tick`, fires every 15
-- minutes (`*/15 * * * *` -- a cadence, not a wall-clock time, so it needs no
-- timezone at all). Each tick is pure SQL, no HTTP call, no Edge Function
-- invocation: it compares NOW() against absolute TIMESTAMPTZ targets --
-- "the nearest Sunday 11:00 Israel time" for the broadcast (computed with
-- `AT TIME ZONE 'Asia/Jerusalem'`, the same DST-aware idiom
-- deadline_for_week() already uses -- migration 22), and the open week's
-- REAL, already-stored submission_deadline minus 24h/2h for the reminders.
-- Only when one of those comparisons is actually within reminder_due()'s
-- +-20-minute tolerance (migration 40) does the tick fire net.http_post --
-- which is the one thing that costs an Edge Function invocation. In an
-- ordinary week that's still only a handful of real HTTP calls, not 96/day:
-- the 15-minute wake-up is cheap Postgres-only work; only the rare "yes,
-- actually due" tick ever reaches send-notifications. This also means
-- scheduler_settings changes need no special handling here at all -- the
-- tick always reads the OPEN week's live, current deadline, so there is
-- nothing to precompute or go stale.
--
-- Secrets are NOT embedded in this file (it is committed to git). notify_url
-- / notify_secret are read at tick-time from two database-level GUCs, set
-- ONCE, manually, exactly like every other secret in this project (spec
-- 11.1):
--
--   ALTER DATABASE postgres SET app.settings.notify_url  = 'https://<project-ref>.supabase.co/functions/v1/send-notifications';
--   ALTER DATABASE postgres SET app.settings.cron_secret = '<same value as the CRON_SHARED_SECRET Edge Function secret>';
--
-- Until those two ALTER DATABASE statements are run, notification_tick()
-- returns immediately (checked explicitly, not left to error) -- no crash,
-- no partial send, just silently does nothing every 15 minutes.
--
-- Wrapped defensively (DO blocks, not bare CREATE EXTENSION / cron.schedule):
-- pg_cron requires a background-worker process pg_cron's PGlite -- WASM,
-- single-process, no background workers at all -- can never provide (this is
-- Gate A local's test harness, spec 14.2). Every other migration in this
-- project is designed to apply cleanly there ("migrations are DISCOVERED,
-- not listed" -- rls.test.mjs -- specifically so nothing gets silently
-- skipped from local testing). Rather than break that guarantee for every
-- migration from this one onward, this one degrades itself: on a real
-- Supabase-hosted Postgres (which has both extensions) it behaves exactly as
-- if these were bare statements; on PGlite it logs a NOTICE and leaves
-- notification_tick() defined but unscheduled, so migrations 42+ still apply
-- and Gate A local keeps testing everything after this point.
-- ============================================================================

DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron/pg_net unavailable in this Postgres build (expected on PGlite/local testing; a real Supabase project has both) -- cron scheduling will be skipped further down this migration.';
END $$;


-- ----------------------------------------------------------------------------
-- broadcast_due -- is NOW() within tolerance of this week's OR next week's
-- Sunday 11:00 Israel time? Checking both candidates (rather than trying to
-- pick "the nearest one") is simplest and always correct: the +-20-minute
-- tolerance window is tiny next to a week, so at most one candidate can ever
-- be true at a time.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_due()
RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  WITH local_today AS (
    SELECT (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE AS d
  ),
  sundays AS (
    SELECT (d - (EXTRACT(DOW FROM d)::INT) * INTERVAL '1 day')::DATE AS this_sunday
    FROM local_today
  )
  SELECT
    public.reminder_due((this_sunday::TEXT || ' 11:00')::TIMESTAMP AT TIME ZONE 'Asia/Jerusalem', INTERVAL '0')
    OR
    public.reminder_due(((this_sunday + 7)::TEXT || ' 11:00')::TIMESTAMP AT TIME ZONE 'Asia/Jerusalem', INTERVAL '0')
  FROM sundays;
$$;

GRANT EXECUTE ON FUNCTION public.broadcast_due() TO authenticated;


-- ----------------------------------------------------------------------------
-- notification_tick -- the cron entry point. Cheap on every run (a handful
-- of indexed lookups); net.http_post only fires on the rare tick where
-- something is actually due.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notification_tick()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, cron
AS $$
DECLARE
  v_url      TEXT := current_setting('app.settings.notify_url', true);
  v_secret   TEXT := current_setting('app.settings.cron_secret', true);
  v_headers  JSONB;
  v_deadline TIMESTAMPTZ;
BEGIN
  IF v_url IS NULL OR v_secret IS NULL OR v_url = '' OR v_secret = '' THEN
    RETURN; -- not configured yet -- see this file's header
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('notification_tick', '*/15 * * * *', $sched$SELECT public.notification_tick();$sched$);
  ELSE
    RAISE NOTICE 'pg_cron not installed -- notification_tick() is defined but not scheduled (expected on PGlite/local testing).';
  END IF;
END $$;
