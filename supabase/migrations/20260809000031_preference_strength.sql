-- ============================================================================
-- Migration 31 : Turn on the reserved 2-level preference strength
--
-- weekly_wish_preferences.strength has existed since migration 1, always
-- defaulting to 1 -- reserved for a two-level יכול/עדיפות scale (spec 3.1
-- item 2) but never written by anything. A guard whose availability is
-- structurally tilted toward one shift (e.g. mostly afternoon/night, but
-- genuinely prefers night) had no way to say so except free text, which the
-- solver deliberately never reads (spec 3.6). This lets a guard mark a
-- specific slot as preferred; the solver weighting change that makes use of
-- it lives in src/lib/mockSolver.ts, solver/scheduler.py and their referees,
-- not here -- this migration only carries the value through.
--
-- save_week_preferences: one more optional key inside each slot object, same
-- pattern as allows12h. No new SQL parameter, so a stale caller that still
-- sends slots without "strength" keeps working -- COALESCE defaults it to 1,
-- identical to the column's own default.
-- ============================================================================

DROP FUNCTION IF EXISTS public.save_week_preferences(DATE, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.save_week_preferences(
  p_week_start DATE,
  p_slots      JSONB,           -- [{"date":"2026-08-16","shift":"morning","allows12h":true,"strength":2}, ...]
  p_notes      TEXT DEFAULT NULL
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

  -- Records that the guard answered at all, which is what distinguishes
  -- "submitted an empty sheet" from "never submitted" (spec 3.4). An
  -- all-whitespace note is treated as no note, same as an empty slot array is
  -- treated as no availability -- so the column stays a clean NULL rather than
  -- silently accumulating stray spaces.
  INSERT INTO weekly_submissions (guard_id, week_start, notes)
  VALUES (v_uid, p_week_start, NULLIF(TRIM(p_notes), ''))
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET updated_at = NOW(),
        notes      = EXCLUDED.notes;

  DELETE FROM weekly_wish_preferences
   WHERE guard_id = v_uid AND week_start = p_week_start;

  IF p_slots IS NOT NULL AND jsonb_array_length(p_slots) > 0 THEN
    INSERT INTO weekly_wish_preferences
      (guard_id, week_start, target_date, shift, allows_12h, strength)
    SELECT v_uid,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift,
           -- Defensive: an afternoon row can never extend, so drop the flag
           -- here rather than letting the CHECK reject the whole save.
           COALESCE((e->>'allows12h')::BOOLEAN, FALSE)
             AND (e->>'shift') IN ('morning', 'night'),
           COALESCE((e->>'strength')::SMALLINT, 1)
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT) TO authenticated;
