-- ============================================================================
-- Migration 33 : Guard-requested shift count
--
-- Adds a per-week, per-guard "I'd like N shifts this week" signal alongside
-- the manager-configured כמות. Nullable -- absence means "no explicit
-- request, defer entirely to the configured target," normalised the same way
-- an all-whitespace note collapses to NULL (spec-established convention:
-- absence of a real request should leave a clean absence of data, not a
-- stray value equal to the default). The "which number actually wins"
-- business logic (lower request lowers the floor; equal is a no-op; higher
-- only ever earns a soft bonus, never raises the penalized floor) lives
-- entirely client-side in src/lib/shifts.ts -- this column is just storage.
--
-- CHECK allows up to 6, one more than MAX_SHIFTS_PER_WEEK (5) -- reserved for
-- a deliberately deferred follow-up (a guard already configured at 5 may in
-- future request a 6th shift, which needs its own change to the hard 5-shift
-- weekly ceiling in both solver engines). Nothing writes 6 yet; the guard and
-- manager UIs both cap the stepper at 5 until that follow-up ships, so this
-- headroom is free now rather than a second ALTER later.
-- ============================================================================

ALTER TABLE weekly_submissions
  ADD COLUMN requested_shifts SMALLINT CHECK (requested_shifts BETWEEN 0 AND 6);

COMMENT ON COLUMN weekly_submissions.requested_shifts IS
  'Guard-stated preferred shift count for the week, NULL = no explicit request (defer to configured_kamut). See src/lib/shifts.ts effectiveKamut()/stretchTarget() for how it is applied.';

-- --- save_week_preferences: guard's own row -------------------------------
DROP FUNCTION IF EXISTS public.save_week_preferences(DATE, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.save_week_preferences(
  p_week_start       DATE,
  p_slots            JSONB,   -- [{"date":"2026-08-16","shift":"morning","allows12h":true,"strength":2}, ...]
  p_notes            TEXT DEFAULT NULL,
  p_requested_shifts SMALLINT DEFAULT NULL
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

  IF NOT (public.is_week_open(p_week_start) OR public.is_manager()) THEN
    RAISE EXCEPTION 'submission window closed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO weekly_submissions (guard_id, week_start, notes, requested_shifts)
  VALUES (v_uid, p_week_start, NULLIF(TRIM(p_notes), ''), p_requested_shifts)
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET updated_at        = NOW(),
        notes             = EXCLUDED.notes,
        requested_shifts  = EXCLUDED.requested_shifts;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = v_uid AND week_start = p_week_start;

  IF p_slots IS NOT NULL AND jsonb_array_length(p_slots) > 0 THEN
    INSERT INTO weekly_wish_preferences
      (guard_id, week_start, target_date, shift, allows_12h, strength)
    SELECT v_uid,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift,
           COALESCE((e->>'allows12h')::BOOLEAN, FALSE)
             AND (e->>'shift') IN ('morning', 'night'),
           COALESCE((e->>'strength')::SMALLINT, 1)
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT, SMALLINT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT, SMALLINT)
  TO authenticated;

-- --- manager_save_week_preferences: manager editing a guard's row --------
DROP FUNCTION IF EXISTS public.manager_save_week_preferences(UUID, DATE, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.manager_save_week_preferences(
  p_guard_id         UUID,
  p_week_start       DATE,
  p_slots            JSONB,
  p_notes            TEXT DEFAULT NULL,
  p_requested_shifts SMALLINT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'insufficient privilege: manager only' USING ERRCODE = '42501';
  END IF;

  INSERT INTO weekly_submissions (guard_id, week_start, notes, requested_shifts)
  VALUES (p_guard_id, p_week_start, NULLIF(TRIM(p_notes), ''), p_requested_shifts)
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET updated_at        = NOW(),
        notes             = EXCLUDED.notes,
        requested_shifts  = EXCLUDED.requested_shifts;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = p_guard_id AND week_start = p_week_start;

  IF p_slots IS NOT NULL AND jsonb_array_length(p_slots) > 0 THEN
    INSERT INTO weekly_wish_preferences
      (guard_id, week_start, target_date, shift, allows_12h, strength)
    SELECT p_guard_id,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift,
           COALESCE((e->>'allows12h')::BOOLEAN, FALSE)
             AND (e->>'shift') IN ('morning', 'night'),
           COALESCE((e->>'strength')::SMALLINT, 1)
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.manager_save_week_preferences(UUID, DATE, JSONB, TEXT, SMALLINT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_save_week_preferences(UUID, DATE, JSONB, TEXT, SMALLINT)
  TO authenticated;
