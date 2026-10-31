-- ============================================================================
-- Migration 68 : fix set_week_as_new_normal()'s unqualified DELETEs
--
-- Bug found the same day migration 67 shipped: pressing "set as new normal"
-- failed with "DELETE requires a WHERE clause" (Postgres error 21000, raised
-- by supautils -- this project's session_preload_libraries extension, which
-- enforces exactly this rule for the `authenticated` role as a guard against
-- an accidental full-table wipe, e.g. a dropped .eq() filter). It wasn't
-- caught before shipping because every connection used to test the function
-- beforehand (the Management API, used for db:apply and ad-hoc diagnostics)
-- runs as a privileged role that supautils exempts -- only a REAL
-- `authenticated`-role call, i.e. the actual app in the actual browser,
-- ever hits the guard. These are also the first fully unqualified DELETEs
-- anywhere in this codebase; every other DELETE already carries a WHERE.
--
-- Fix: WHERE TRUE satisfies the syntactic requirement while keeping the
-- exact intended behaviour (clear the whole standing-default table before
-- re-inserting the selected week's current rows) -- the standard escape
-- hatch for a deliberate full-table delete under this kind of guard.
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
         );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_week_as_new_normal(DATE) TO authenticated;
