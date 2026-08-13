-- ============================================================================
-- Migration 40 : Push notification storage
--
-- Two tables. push_subscriptions holds one row per browser/device a guard has
-- enabled notifications on (a guard might have this on their phone AND a
-- desktop browser, so it's keyed by endpoint, not by guard_id alone).
-- notification_log is an audit trail of every send ATTEMPT -- sent, skipped,
-- or failed -- which doubles as the idempotency ledger migration 41's cron
-- jobs rely on, and is what Ben queries from the SQL editor to see what fired
-- and when while testing on his phone.
--
-- Deliberately no polling here or in migration 41: each notification type
-- gets its own weekly cron entry (spec 12.10), not a repeating "is it due
-- yet?" check. These tables exist to make that safe -- specifically,
-- idempotent (never send the same reminder twice for the same guard+week)
-- and auditable (see exactly why any given send did or didn't happen).
-- ============================================================================

CREATE TABLE push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE push_subscriptions IS
  'One row per PushManager subscription (browser/device). endpoint is globally unique -- re-subscribing the same device upserts in place rather than accumulating duplicates. Rows are pruned by send-notifications when the push service reports the endpoint gone (404/410).';

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO authenticated;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Same shape as weekly_submissions' subs_read/subs_self_write (migration 3),
-- minus the is_week_open() clause, which doesn't apply here.
CREATE POLICY push_subs_read ON push_subscriptions
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY push_subs_self_write ON push_subscriptions
  FOR ALL TO authenticated
  USING      (guard_id = auth.uid())
  WITH CHECK (guard_id = auth.uid());

CREATE TRIGGER trg_push_subs_touch_updated_at
  BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- notification_log -- audit trail AND idempotency ledger.
--
-- status='sent' is uniquely constrained per (type, week, guard) via a PARTIAL
-- index, not a table-wide UNIQUE: every attempt is still logged (including
-- repeat skips, useful while testing), but only one row can ever claim the
-- 'sent' state for a given (notification_type, week_start, guard_id). That
-- partial index is what claim_notification_send() below relies on.
-- ----------------------------------------------------------------------------
CREATE TABLE notification_log (
  id                 BIGSERIAL PRIMARY KEY,
  notification_type  TEXT NOT NULL CHECK (notification_type IN ('broadcast','reminder_24h','reminder_2h')),
  week_start         DATE REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  guard_id           UUID REFERENCES profiles(id) ON DELETE CASCADE, -- NULL = whole-run skip (e.g. no open week)
  status             TEXT NOT NULL CHECK (status IN
                        ('sent','skipped_already_sent','skipped_out_of_window',
                         'skipped_no_subscription','skipped_no_open_week','failed')),
  detail             TEXT,
  intended_at        TIMESTAMPTZ,           -- the computed target moment (deadline - offset, or the broadcast's own deadline reference)
  sent_at            TIMESTAMPTZ,           -- set only when status = 'sent'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX notification_log_sent_once
  ON notification_log (notification_type, week_start, guard_id)
  WHERE status = 'sent';

CREATE INDEX notification_log_created_at_idx ON notification_log (created_at DESC);

COMMENT ON TABLE notification_log IS
  'Audit trail for every push send attempt. The partial unique index notification_log_sent_once is what makes a send idempotent per (type, week, guard) -- see claim_notification_send() below.';

-- Service-role only for writes: the Edge Function writes here with the
-- secret key (which bypasses grants entirely), and managers read it for the
-- SQL-editor query (spec 12.10). No INSERT policy for `authenticated` -- a
-- guard forging a 'sent' row would poison the idempotency ledger and hide
-- real skips from Ben while he's testing.
GRANT SELECT ON notification_log TO authenticated;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_manager_read ON notification_log
  FOR SELECT TO authenticated
  USING (is_manager());


-- ----------------------------------------------------------------------------
-- Targeting queries, as reusable functions -- both the Edge Function and the
-- test suite call these, so "who gets a broadcast" / "who hasn't submitted"
-- is defined exactly once, not duplicated between SQL and TypeScript.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_targets()
RETURNS TABLE (guard_id UUID)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM profiles WHERE is_active AND NOT is_demo;
$$;

-- No role filter: a manager is also a real, active guard who submits their
-- own availability (spec 2.1 -- Ben is scheduled on the grid exactly like
-- everyone else). Filtering to role='guard' would silently exclude him from
-- his own reminders.
CREATE OR REPLACE FUNCTION public.unsubmitted_targets(p_week_start DATE)
RETURNS TABLE (guard_id UUID)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id
    FROM profiles p
   WHERE p.is_active AND NOT p.is_demo
     AND NOT EXISTS (
       SELECT 1 FROM weekly_submissions ws
        WHERE ws.guard_id = p.id AND ws.week_start = p_week_start
     );
$$;

REVOKE ALL ON FUNCTION public.broadcast_targets() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unsubmitted_targets(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_targets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.unsubmitted_targets(DATE) TO authenticated;
-- (SECURITY DEFINER because the Edge Function's service-role client already
--  bypasses RLS anyway, but granting to `authenticated` too means a manager
--  can run these directly from the SQL editor to sanity-check targeting
--  without needing service-role access.)


-- ----------------------------------------------------------------------------
-- reminder_due -- the tolerance-window guard a reminder send must pass before
-- it's allowed to actually send (migration 41, send-notifications). STABLE,
-- not IMMUTABLE: depends on NOW().
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reminder_due(
  p_deadline   TIMESTAMPTZ,
  p_offset     INTERVAL,
  p_tolerance  INTERVAL DEFAULT INTERVAL '20 minutes'
)
RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT ABS(EXTRACT(EPOCH FROM (NOW() - (p_deadline - p_offset)))) <= EXTRACT(EPOCH FROM p_tolerance);
$$;

GRANT EXECUTE ON FUNCTION public.reminder_due(TIMESTAMPTZ, INTERVAL, INTERVAL) TO authenticated;


-- ----------------------------------------------------------------------------
-- claim_notification_send -- the idempotency primitive. Optimistically claims
-- the 'sent' slot for (type, week, guard) BEFORE the actual push call, so two
-- near-simultaneous invocations (a duplicate cron fire, a manual re-trigger
-- while testing) cannot both send. Returns the claimed row's id, or NULL if
-- someone already claimed it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notification_send(
  p_type TEXT, p_week_start DATE, p_guard_id UUID, p_intended_at TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE SQL SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO notification_log (notification_type, week_start, guard_id, status, intended_at, sent_at)
  VALUES (p_type, p_week_start, p_guard_id, 'sent', p_intended_at, NOW())
  ON CONFLICT (notification_type, week_start, guard_id) WHERE status = 'sent' DO NOTHING
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.claim_notification_send(TEXT, DATE, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
-- Deliberately NOT granted to `authenticated` -- only the Edge Function's
-- service-role client (which bypasses grants entirely) should ever claim a
-- send. The test suite exercises it via the service-role sql() helper, same
-- as every other cloud test's setup/oracle queries.
