-- ============================================================================
-- Migration 14 : A published roster stays under the manager's control
--
-- Migration 13 refused to edit a published roster, reasoning that guards are
-- reading it off their phones. That was wrong about how the week actually runs:
-- somebody calls in sick on Tuesday and the roster has to change while it is
-- live. Either the shift is dropped (if coverage stays above the floor) or
-- another guard swaps in. Refusing the edit does not prevent the change -- it
-- just pushes it back to WhatsApp, which is the thing this app exists to
-- replace.
--
-- So: a published roster is editable and deletable. The safety rules still
-- apply -- the referee judges an edit whether or not the roster is live -- but
-- the manager is never locked out of their own roster.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_run_assignments(
  p_run_id      UUID,
  p_assignments JSONB
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

  -- Published or not, the replacement is one transaction: a half-applied edit
  -- would leave the roster missing people, and on a LIVE roster that is worse
  -- than on a draft.
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


-- ----------------------------------------------------------------------------
-- delete_schedule_run
--
-- Deleting the run cascades to its assignments. The week's status has to follow
-- suit, or a week would still claim to be 'published' with nothing published --
-- and `ensure_roster_weeks()` skips weeks a manager has touched, so nothing
-- else would ever correct it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_schedule_run(p_run_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week DATE;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT week_start INTO v_week FROM schedule_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown run %', p_run_id USING ERRCODE = '22023';
  END IF;

  DELETE FROM schedule_runs WHERE id = p_run_id;

  UPDATE roster_weeks w
     SET status = CASE
           WHEN EXISTS (SELECT 1 FROM schedule_runs r WHERE r.week_start = v_week)
             THEN 'generated'::week_status
           ELSE 'locked'::week_status
         END
   WHERE w.week_start = v_week
     AND w.status = 'published'
     AND NOT EXISTS (
       SELECT 1 FROM schedule_runs r WHERE r.week_start = v_week AND r.is_published
     );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_schedule_run(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_schedule_run(UUID) TO authenticated;


-- ----------------------------------------------------------------------------
-- unpublish_run -- take a roster off the guards' phones without deleting it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unpublish_run(p_run_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week DATE;
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  SELECT week_start INTO v_week FROM schedule_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown run %', p_run_id USING ERRCODE = '22023';
  END IF;

  UPDATE schedule_runs SET is_published = FALSE WHERE id = p_run_id;

  UPDATE roster_weeks SET status = 'generated'
   WHERE week_start = v_week AND status = 'published';
END;
$$;

REVOKE ALL ON FUNCTION public.unpublish_run(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpublish_run(UUID) TO authenticated;
