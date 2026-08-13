-- ============================================================================
-- Migration 38 : Free-text notes on a manually-edited assignment cell
--
-- The manager sometimes knows a real-world wrinkle the shift model itself
-- can't express -- a guard covering an "afternoon" shift will actually walk
-- in at 10:45 and work a 12h day instead of the two segments that would
-- normally model that, or a guard on "morning" is leaving two hours early
-- that one day. Reshaping the actual assignment to fit isn't what's wanted
-- (spec 2.2/2.3's segment model stays the source of truth for coverage); the
-- manager just wants to annotate the cell so anyone reading the roster --
-- including the guard it's about -- sees it.
--
-- Two columns, not one: the note can sit before and/or after the guard's
-- name independently ("(10:45>) שלי" vs "שלי (עד 14:00)"), and both can be
-- set on the same cell at once.
--
-- Same shape as schedule_assignments.post before it was dropped (migration
-- 23): nullable, manager-only, solver-blind. Unlike post, this one gets
-- wired into the UI end to end from the start (RosterEditor's SlotEditor,
-- RosterGrid, exportRoster.ts) so it doesn't end up as unused schema weight.
--
-- Length-capped short -- these render inside an 11px chip and a fixed-width
-- canvas column, not a paragraph field like weekly_submissions.notes.
--
-- Manual-edit only: save_run_assignments already does a full DELETE + INSERT
-- per save (migration 13/14), so these ride along in the same JSONB payload
-- as date/shift/guard_id. The solver-generation path (useGenerateSchedule)
-- inserts SolverOutput.assignments directly and never sets these -- a fresh
-- solve has no notes to carry over, which matches how a new run already
-- starts with no manual edits of any other kind either.
-- ============================================================================

ALTER TABLE schedule_assignments
  ADD COLUMN note_before TEXT,
  ADD COLUMN note_after  TEXT;

ALTER TABLE schedule_assignments
  ADD CONSTRAINT note_before_length CHECK (char_length(note_before) <= 40),
  ADD CONSTRAINT note_after_length  CHECK (char_length(note_after)  <= 40);

COMMENT ON COLUMN schedule_assignments.note_before IS
  'Manager-written free text rendered before the guard''s name on this cell, e.g. an early-arrival note. Never read by the solver or referee.';
COMMENT ON COLUMN schedule_assignments.note_after IS
  'Manager-written free text rendered after the guard''s name on this cell, e.g. an early-departure note. Never read by the solver or referee.';


-- ----------------------------------------------------------------------------
-- save_run_assignments: thread note_before/note_after through the existing
-- full-replace INSERT. Signature is unchanged (still UUID, JSONB) -- only the
-- shape of each JSONB array element grows two optional keys -- so this is
-- CREATE OR REPLACE rather than a DROP+recreate.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_run_assignments(
  p_run_id      UUID,
  p_assignments JSONB   -- [{"date":"2026-08-09","shift":"morning","guard_id":"uuid","note_before":"...","note_after":"..."}, ...]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week  DATE;
  v_count INT;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT week_start INTO v_week FROM schedule_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown run %', p_run_id USING ERRCODE = '22023';
  END IF;

  DELETE FROM schedule_assignments WHERE run_id = p_run_id;

  IF p_assignments IS NOT NULL AND jsonb_array_length(p_assignments) > 0 THEN
    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id, note_before, note_after)
    SELECT p_run_id,
           (e->>'date')::DATE,
           (e->>'shift')::shift_type,
           (e->>'guard_id')::UUID,
           NULLIF(TRIM(e->>'note_before'), ''),
           NULLIF(TRIM(e->>'note_after'), '')
      FROM jsonb_array_elements(p_assignments) AS e;
  END IF;

  SELECT COUNT(*) INTO v_count FROM schedule_assignments WHERE run_id = p_run_id;

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
