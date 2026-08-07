-- ============================================================================
-- Migration 8 : Per-day 12-hour opt-in
--
-- The opt-in was a pair of week-level booleans on weekly_submissions, so a
-- guard willing to do one long day had to accept long days for the whole week.
-- Real availability is not that uniform.
--
-- The flag moves onto the preference row itself. That is what makes the whole
-- feature safe: `allows_12h` is a property of "I am available for morning on
-- this day", so deleting that availability deletes the flag with it. There is
-- no reconciliation code and no way to end up opted in for a day you no longer
-- work.
--
-- Only morning and night can extend:
--   morning + allows_12h -> eligible for day12   (06:45-18:45)
--   night   + allows_12h -> eligible for night12 (18:45-06:45)
-- An afternoon row can never carry the flag; the CHECK enforces it.
-- ============================================================================

ALTER TABLE weekly_wish_preferences
  ADD COLUMN allows_12h BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE weekly_wish_preferences
  ADD CONSTRAINT twelve_h_on_extendable_shift
  CHECK (NOT allows_12h OR shift IN ('morning', 'night'));

COMMENT ON COLUMN weekly_wish_preferences.allows_12h IS
  'Guard will extend this specific shift to 12h. morning -> day12, night -> night12.';


-- ----------------------------------------------------------------------------
-- Carry the existing week-level opt-ins onto the matching rows so nobody who
-- has already submitted loses their preference.
-- ----------------------------------------------------------------------------
UPDATE weekly_wish_preferences w
   SET allows_12h = TRUE
  FROM weekly_submissions s
 WHERE s.guard_id = w.guard_id
   AND s.week_start = w.week_start
   AND ((w.shift = 'morning' AND s.can_work_12h_day)
     OR (w.shift = 'night'   AND s.can_work_12h_night));


-- ----------------------------------------------------------------------------
-- Drop the old columns. Keeping both would be two sources of truth for the same
-- fact -- exactly the bug called out in spec 1.1 that moved these flags off the
-- per-slot rows in the first place.
-- ----------------------------------------------------------------------------
ALTER TABLE weekly_submissions DROP COLUMN can_work_12h_day;
ALTER TABLE weekly_submissions DROP COLUMN can_work_12h_night;


-- ----------------------------------------------------------------------------
-- save_week_preferences: slots now carry their own allows_12h.
--
-- Still SECURITY INVOKER, so ownership and the submission deadline are enforced
-- by RLS exactly as before. The old 4-argument signature is dropped so a stale
-- caller fails loudly instead of silently saving without the 12h flags.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_week_preferences(DATE, JSONB, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION public.save_week_preferences(
  p_week_start DATE,
  p_slots      JSONB   -- [{"date":"2026-08-16","shift":"morning","allows12h":true}, ...]
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
  -- "submitted an empty sheet" from "never submitted" (spec 3.4).
  INSERT INTO weekly_submissions (guard_id, week_start)
  VALUES (v_uid, p_week_start)
  ON CONFLICT (guard_id, week_start) DO UPDATE
    SET updated_at = NOW();

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

REVOKE ALL ON FUNCTION public.save_week_preferences(DATE, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_week_preferences(DATE, JSONB) TO authenticated;
