-- ============================================================================
-- Migration 17 : Free-text note on a weekly submission
--
-- The availability grid answers "when", not "why" or "what else the manager
-- should know" -- "עדיפות למשמרות לילה", "עד 4 משמרות השבוע", "דבר איתי אם אתה
-- צריך עזרה". That does not fit the slot model (spec 3.1) and should not: it is
-- context for a human reading the roster, not a constraint for the solver to
-- enforce. So it lives as one free-text field on weekly_submissions, next to
-- the availability it explains, and the solver never reads it.
--
-- Length-capped, not because 500 characters is meaningful, but because an
-- unbounded text column on a public-facing form is a standing invitation.
-- ============================================================================

ALTER TABLE weekly_submissions
  ADD COLUMN notes TEXT;

ALTER TABLE weekly_submissions
  ADD CONSTRAINT notes_length CHECK (char_length(notes) <= 500);

COMMENT ON COLUMN weekly_submissions.notes IS
  'Free-text context from the guard, e.g. "prefers night shifts". Never read by the solver.';


-- ----------------------------------------------------------------------------
-- save_week_preferences: one more, optional, argument.
--
-- Appended with a DEFAULT so a PostgREST caller who still sends only
-- {p_week_start, p_slots} (named JSON args) resolves to this same function
-- unchanged -- Postgres matches named-argument calls against parameters with
-- defaults regardless of position. Dropped and recreated anyway, matching how
-- migration 8 changed this function's shape: a signature change is worth
-- seeing explicitly in the migration history, not just editing in place.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_week_preferences(DATE, JSONB);

CREATE OR REPLACE FUNCTION public.save_week_preferences(
  p_week_start DATE,
  p_slots      JSONB,           -- [{"date":"2026-08-16","shift":"morning","allows12h":true}, ...]
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
    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift, allows_12h)
    SELECT v_uid,
           p_week_start,
           (e->>'date')::DATE,
           (e->>'shift')::base_shift,
           -- Defensive: an afternoon row can never extend, so drop the flag
           -- here rather than letting the CHECK reject the whole save.
           COALESCE((e->>'allows12h')::BOOLEAN, FALSE)
             AND (e->>'shift') IN ('morning', 'night')
      FROM jsonb_array_elements(p_slots) AS e;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_week_preferences(DATE, JSONB, TEXT) TO authenticated;
