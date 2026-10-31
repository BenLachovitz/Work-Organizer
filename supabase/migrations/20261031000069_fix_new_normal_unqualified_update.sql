-- ============================================================================
-- Migration 69 : fix set_week_as_new_normal()'s unqualified UPDATE
--
-- Migration 68 fixed the function's two DELETEs (same supautils "requires a
-- WHERE clause" guard), but testing it for real -- through an actual
-- authenticated REST call, not a privileged connection, since that's the
-- only path that exercises the guard at all -- surfaced the same problem on
-- the function's one UPDATE statement, which was missed because it comes
-- after both DELETEs and so was never reached by that first test run.
--
-- scheduler_settings' primary key is the singleton `id BOOLEAN DEFAULT TRUE`
-- (same table/column convention as useUpdateSchedulerSettings() already
-- uses client-side, `.eq('id', true)`) -- `WHERE id` is both the correct
-- explicit filter for a real reason (it's the only row that could ever
-- exist) and satisfies the guard, so this isn't just a workaround.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_week_as_new_normal(p_week_start DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_manager() THEN
    RAISE EXCEPTION 'managers only' USING ERRCODE = '42501';
  END IF;

  DELETE FROM default_morning_target_overrides WHERE TRUE;
  INSERT INTO default_morning_target_overrides (day_index, morning_target_slots)
    SELECT day_index, morning_target_slots
      FROM weekly_morning_target_overrides
     WHERE week_start = p_week_start;

  DELETE FROM default_segment_target_overrides WHERE TRUE;
  INSERT INTO default_segment_target_overrides (day_index, segment, target_slots)
    SELECT day_index, segment, target_slots
      FROM weekly_segment_target_overrides
     WHERE week_start = p_week_start;

  UPDATE scheduler_settings
     SET default_double_shift_display_hours = COALESCE(
           (SELECT double_shift_display_hours FROM roster_weeks WHERE week_start = p_week_start),
           default_double_shift_display_hours
         )
   WHERE id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_week_as_new_normal(DATE) TO authenticated;
