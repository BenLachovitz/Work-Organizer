-- ============================================================================
-- Migration 16 : A night shift stays readable until it ends
--
-- The archive cut is at the week boundary: guards see published rosters from
-- current_week_start() onwards. But a Saturday night shift runs 22:45 -> 06:45,
-- so at 03:00 on Sunday the guard is still at work while the roster they are
-- working has already become "last week" and gone invisible. Opening the app
-- mid-shift to check whether they finish at 06:45 or 14:45 would show nothing.
--
-- So the visible window reaches back one week, but only until 07:00 on Sunday --
-- ten minutes after the last night shift ends. For the rest of the week it
-- behaves exactly as before, and the manager-only archive is otherwise intact.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_visible_from()
RETURNS DATE
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN NOW() < ((public.current_week_start()::TEXT || ' 07:00:00')::TIMESTAMP
                   AT TIME ZONE 'Asia/Jerusalem')
      THEN public.current_week_start() - 7   -- Sunday before 07:00: last night's roster
    ELSE public.current_week_start()
  END;
$$;

GRANT EXECUTE ON FUNCTION public.guard_visible_from() TO authenticated;

COMMENT ON FUNCTION public.guard_visible_from() IS
  'Earliest week_start a guard may read. Reaches back one week until 07:00 on '
  'Sunday so an in-progress Saturday night shift stays visible.';


-- ----------------------------------------------------------------------------
-- Both policies move from current_week_start() to guard_visible_from(). The
-- manager branch is untouched: managers always see everything.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS runs_read ON schedule_runs;

CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated
  USING (
    is_manager()
    OR (is_published AND week_start >= public.guard_visible_from())
  );

DROP POLICY IF EXISTS assign_read ON schedule_assignments;

CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM schedule_runs r
      WHERE r.id = schedule_assignments.run_id
        AND (
          is_manager()
          OR (r.is_published AND r.week_start >= public.guard_visible_from())
        )
    )
  );
