-- ============================================================================
-- Migration 52 : Placeholder rows can optionally occupy a coverage slot
--
-- Migration 39 (§12.9) made a placeholder (guard_id IS NULL) a note-only cell
-- annotation, excluded from every hard-rule check and all coverage/floor/
-- target counting, unconditionally.
--
-- Ben wants a per-row option: a specific placeholder can now be marked to
-- COUNT toward segment coverage (floor/target/ceiling) like a real
-- assignment, while still carrying no guard identity -- so it stays excluded
-- from availability (H1), 12h opt-in (H2), one-shift-per-day (H3), the
-- weekly ceiling (H4), rest (H5/H7), and every guard's own כמות/preference/
-- stretch numbers. Only the referee's guard-agnostic coverage math
-- (src/lib/validate.ts's coverageBySegment, which only ever reads day+shift)
-- picks it up.
--
-- occupies_slot defaults to FALSE, so every existing placeholder keeps
-- today's behaviour unchanged unless a manager explicitly opts a row in. It
-- is meaningless on a real assignment (guard_id IS NOT NULL) -- a real
-- assignment always occupies its own slot already -- so the CHECK below
-- pins it to FALSE there, the same defence-in-depth pattern migration 39
-- used for placeholder_needs_a_note.
--
-- Confirmed with Ben: this does NOT relax placeholder_needs_a_note (migration
-- 39) -- a placeholder still requires at least one note regardless of
-- occupies_slot.
-- ============================================================================

ALTER TABLE schedule_assignments
  ADD COLUMN occupies_slot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE schedule_assignments
  ADD CONSTRAINT occupies_slot_only_on_placeholder
  CHECK (occupies_slot = FALSE OR guard_id IS NULL);

COMMENT ON COLUMN schedule_assignments.occupies_slot IS
  'Placeholder-only flag (guard_id IS NULL, migration 39/§12.9): TRUE makes this specific placeholder count toward segment coverage (floor/target/ceiling) like a real assignment, while still carrying no guard identity -- never checked against availability, rest, one-shift-per-day, the weekly ceiling, or any guard''s כמות. Always FALSE on a real assignment, enforced by the CHECK above. Defaults to FALSE so every existing row keeps today''s behaviour unchanged. See RosterEditor.tsx, RosterGrid.tsx, and validate.ts.';

-- ----------------------------------------------------------------------------
-- save_run_assignments: thread occupies_slot through the existing full-
-- replace INSERT. Signature is unchanged (still UUID, JSONB) -- only the
-- shape of each JSONB array element grows one more optional key -- so this is
-- CREATE OR REPLACE, same pattern migration 38 used for note_before/note_after.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_run_assignments(
  p_run_id      UUID,
  p_assignments JSONB   -- [{"date":"2026-08-09","shift":"morning","guard_id":"uuid"|null,"note_before":"...","note_after":"...","occupies_slot":false}, ...]
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
    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id, note_before, note_after, occupies_slot)
    SELECT p_run_id,
           (e->>'date')::DATE,
           (e->>'shift')::shift_type,
           (e->>'guard_id')::UUID,
           NULLIF(TRIM(e->>'note_before'), ''),
           NULLIF(TRIM(e->>'note_after'), ''),
           COALESCE((e->>'occupies_slot')::BOOLEAN, FALSE)
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
