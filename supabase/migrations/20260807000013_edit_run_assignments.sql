-- ============================================================================
-- Migration 13 : Manual editing of a draft roster
--
-- The manager knows things the solver cannot: who is quietly covering for whom,
-- who asked in person, who should not be paired on a night. So a generated
-- draft has to be editable before publication.
--
-- Replacing a run's assignments is a DELETE plus an INSERT. Done as two
-- PostgREST calls it can half-fail and leave a roster with people missing --
-- the same failure mode that made save_week_preferences a single function.
-- Same solution: one transaction.
--
-- SECURITY INVOKER, so RLS still governs every statement inside. Only a manager
-- can write schedule_assignments, and this does not change that.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_run_assignments(
  p_run_id      UUID,
  p_assignments JSONB   -- [{"date":"2026-08-09","shift":"morning","guard_id":"uuid"}, ...]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week      DATE;
  v_published BOOLEAN;
  v_count     INT;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT week_start, is_published INTO v_week, v_published
    FROM schedule_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown run %', p_run_id USING ERRCODE = '22023';
  END IF;

  -- A published roster is what guards are reading off their phones. Editing it
  -- silently underneath them would be worse than making the manager unpublish
  -- first, which is an explicit, visible act.
  IF v_published THEN
    RAISE EXCEPTION 'cannot edit a published roster; unpublish it first'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM schedule_assignments WHERE run_id = p_run_id;

  IF p_assignments IS NOT NULL AND jsonb_array_length(p_assignments) > 0 THEN
    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id)
    SELECT p_run_id,
           (e->>'date')::DATE,
           (e->>'shift')::shift_type,
           (e->>'guard_id')::UUID
      FROM jsonb_array_elements(p_assignments) AS e;
  END IF;

  SELECT COUNT(*) INTO v_count FROM schedule_assignments WHERE run_id = p_run_id;

  -- Mark the run as hand-edited so its stored solver_status stops claiming the
  -- roster is exactly what the engine produced.
  UPDATE schedule_runs
     SET solver_status = CASE
           WHEN solver_status LIKE '%+EDITED' THEN solver_status
           ELSE solver_status || '+EDITED'
         END
   WHERE id = p_run_id;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.save_run_assignments(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_run_assignments(UUID, JSONB) TO authenticated;
