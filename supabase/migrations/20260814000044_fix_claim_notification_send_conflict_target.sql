-- ============================================================================
-- Migration 44 : Fix claim_notification_send's ON CONFLICT arbiter
--
-- Migration 43 narrowed notification_log_sent_once's predicate to
-- `WHERE status = 'sent' AND notification_type IN (...)`. Postgres infers an
-- ON CONFLICT arbiter by matching columns AND predicate exactly against an
-- existing unique index -- claim_notification_send's own ON CONFLICT clause
-- still specified the OLD predicate (`WHERE status = 'sent'` alone), which no
-- longer matches any index, so every call started failing outright with
-- 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"). Caught by test:cloud (Gate G) before this reached
-- anything else -- the three cron-driven notification types would otherwise
-- have silently stopped sending entirely.
--
-- claim_notification_send is only ever called for the three cron types (the
-- Edge Function inserts roster_published rows directly, no claim), so this
-- predicate is always true when it actually runs -- fixing the arbiter to
-- match the narrowed index changes no observable behaviour.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_notification_send(
  p_type TEXT, p_week_start DATE, p_guard_id UUID, p_intended_at TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE SQL SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO notification_log (notification_type, week_start, guard_id, status, intended_at, sent_at)
  VALUES (p_type, p_week_start, p_guard_id, 'sent', p_intended_at, NOW())
  ON CONFLICT (notification_type, week_start, guard_id)
    WHERE status = 'sent' AND notification_type IN ('broadcast','reminder_24h','reminder_2h')
    DO NOTHING
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.claim_notification_send(TEXT, DATE, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
