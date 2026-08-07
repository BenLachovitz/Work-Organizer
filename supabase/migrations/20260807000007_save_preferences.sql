-- ============================================================================
-- Migration 7 : Atomic preference save
--
-- Saving a week means "replace whatever this guard had with exactly this set",
-- which is a DELETE plus an INSERT. Doing that as two PostgREST calls can leave
-- a guard with an empty sheet if the second call fails -- silently converting
-- "I can work Sunday and Tuesday" into "I am unavailable all week". That is the
-- worst possible failure mode for this app, so it goes in one transaction.
--
-- SECURITY INVOKER is deliberate and load-bearing. The function runs as the
-- CALLING guard, so every statement inside it is still filtered by RLS:
-- ownership (guard_id = auth.uid()) and the Wednesday 19:00 deadline are
-- enforced exactly as they are for a direct table write. SECURITY DEFINER here
-- would silently bypass both.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_week_preferences(
  p_week_start  DATE,
  p_slots       JSONB,   -- [{"date":"2026-08-16","shift":"morning"}, ...]
  p_12h_day     BOOLEAN DEFAULT FALSE,
  p_12h_night   BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- RLS would reject this anyway, but a bare policy violation surfaces as an
  -- opaque error. Checking first lets the UI show a real message.
  IF NOT (public.is_week_open(p_week_start) OR public.is_manager()) THEN
    RAISE EXCEPTION 'submission window closed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO weekly_submissions (guard_id, week_start, can_work_12h_day, can_work_12h_night)
  VALUES (v_uid, p_week_start, COALESCE(p_12h_day, FALSE), COALESCE(p_12h_night, FALSE))
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET can_work_12h_day   = EXCLUDED.can_work_12h_day,
        can_work_12h_night = EXCLUDED.can_work_12h_night;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = v_uid AND week_start = p_week_start;

  -- An empty array is a valid, meaningful submission: "unavailable this week"
  -- (spec 3.4). The weekly_submissions row above is what records that the guard
  -- answered at all, which is why it is written before this branch.
  IF p_slots IS NOT NULL AND jsonb_array_length(p_slots) > 0 THEN
    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
    SELECT v_uid,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_week_preferences(DATE, JSONB, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_week_preferences(DATE, JSONB, BOOLEAN, BOOLEAN)
  TO authenticated;
