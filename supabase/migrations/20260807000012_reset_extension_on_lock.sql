-- ============================================================================
-- Migration 12 : Locking again clears a reopen extension
--
-- Reopening an expired week pushes the deadline to NOW() + 24h so guards can
-- actually write. But locking it again only flipped the status, leaving the
-- extended deadline sitting there -- so the week still showed "23 hours left"
-- while being locked, and un-locking it later would silently inherit whatever
-- remained of that window.
--
-- The extension exists solely to support an active reopen. When the manager
-- locks again, and the canonical Wednesday deadline has already passed, the
-- deadline reverts to that canonical value so the week returns to a clean,
-- honest state rather than carrying an invisible remainder.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_week_status(
  p_week_start    DATE,
  p_status        week_status,
  p_extend_hours  INT DEFAULT 24
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deadline TIMESTAMPTZ;
  v_canonical TIMESTAMPTZ := public.deadline_for_week(p_week_start);
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT submission_deadline INTO v_deadline
    FROM roster_weeks WHERE week_start = p_week_start;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown week %', p_week_start USING ERRCODE = '22023';
  END IF;

  IF p_status = 'open' THEN
    -- Reopening an expired week: give it a real window, otherwise the status
    -- change gates nothing (is_week_open also requires NOW() < deadline).
    IF v_deadline <= NOW() THEN
      v_deadline := NOW() + make_interval(hours => GREATEST(p_extend_hours, 1));
    END IF;
  ELSE
    -- Locking again: drop any extension, but only once the canonical deadline
    -- has genuinely passed. Locking a week EARLY must not move its deadline
    -- forward, or an early lock would quietly become an extension.
    IF NOW() > v_canonical AND v_deadline > v_canonical THEN
      v_deadline := v_canonical;
    END IF;
  END IF;

  UPDATE roster_weeks
     SET status = p_status,
         submission_deadline = v_deadline,
         status_overridden_at = NOW()
   WHERE week_start = p_week_start;

  RETURN v_deadline;
END;
$$;

REVOKE ALL ON FUNCTION public.set_week_status(DATE, week_status, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_week_status(DATE, week_status, INT) TO authenticated;
