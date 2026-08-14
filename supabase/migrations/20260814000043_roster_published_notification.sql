-- ============================================================================
-- Migration 43 : Manual "roster published" broadcast + a real publish_roster RPC
--
-- Two independent additions, both prerequisites for a manager-facing button
-- that announces a published roster to the team on demand (never
-- automatically -- a manager sometimes publishes just to check the layout,
-- not to ship it).
--
-- 1. A new notification_type, 'roster_published'. Unlike the three existing
--    cron-driven types, this one is deliberately NOT deduped to "once per
--    (type, week, guard) ever" -- a manager who republishes a correction
--    later in the same week should be able to announce again. The existing
--    partial unique index (migration 40) is narrowed to keep its original
--    guarantee for the three system types only.
--
-- 2. publish_roster(p_run_id) -- the sibling unpublish_run/delete_schedule_run/
--    save_run_assignments never got (migration 14): today's client does the
--    publish as three separate, non-atomic table writes (see
--    src/hooks/useGenerateSchedule.ts). Same shape as those siblings: derives
--    the week from the run itself rather than trusting a second caller-
--    supplied parameter, and finally writes published_at, which has existed
--    on schedule_runs since its creation but was never once set.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1a. notification_type CHECK -- add 'roster_published'.
-- Dropped by looking up its actual (Postgres-assigned) name rather than
-- assuming it, so this doesn't silently no-op if the default naming ever
-- differs from what migration 40 produced.
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
  CHECK (notification_type IN ('broadcast','reminder_24h','reminder_2h','roster_published'));

-- ----------------------------------------------------------------------------
-- 1b. Narrow notification_log_sent_once so 'roster_published' can log more
-- than one 'sent' row per (week, guard) -- each press is a distinct,
-- deliberate manager decision, not a duplicate to suppress. The three cron
-- types keep exactly the guarantee they had before this migration.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS notification_log_sent_once;

CREATE UNIQUE INDEX notification_log_sent_once
  ON notification_log (notification_type, week_start, guard_id)
  WHERE status = 'sent' AND notification_type IN ('broadcast','reminder_24h','reminder_2h');

COMMENT ON INDEX notification_log_sent_once IS
  'At most one sent row per (type, week, guard) for the three cron-driven types only. roster_published is deliberately excluded -- see migration 43.';

-- ----------------------------------------------------------------------------
-- 1c. is_week_published -- lets the Edge Function refuse a spoofed or stale
-- week_start server-side rather than trusting the request body.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_week_published(p_week_start DATE)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM schedule_runs WHERE week_start = p_week_start AND is_published
  );
$$;

REVOKE ALL ON FUNCTION public.is_week_published(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_week_published(DATE) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. publish_roster -- same shape as unpublish_run/delete_schedule_run
-- (migration 14): manager-gated, derives the week from the run row rather
-- than accepting it as a second parameter, one transaction instead of three
-- separate client round trips.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_roster(p_run_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week DATE;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT week_start INTO v_week FROM schedule_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown run %', p_run_id USING ERRCODE = '22023';
  END IF;

  -- Unpublish any existing published run for the week first: the partial
  -- unique index one_published_run_per_week would otherwise reject the
  -- second publication outright.
  UPDATE schedule_runs SET is_published = FALSE
   WHERE week_start = v_week AND is_published;

  UPDATE schedule_runs
     SET is_published = TRUE, published_at = NOW()
   WHERE id = p_run_id;

  UPDATE roster_weeks SET status = 'published'
   WHERE week_start = v_week;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_roster(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_roster(UUID) TO authenticated;
