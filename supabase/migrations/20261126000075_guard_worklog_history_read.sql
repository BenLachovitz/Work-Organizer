-- ============================================================================
-- Migration 75 : a guard may read ANY published week's roster, not just the
-- current one -- schedule_runs/schedule_assignments only, work-log seeding only
--
-- Bug: the work-log feature (migration 58, spec 15) seeds a guard's own
-- work_log_entries by reading schedule_runs/schedule_assignments under the
-- GUARD'S OWN session, which migration 16's guard_visible_from() floor
-- restricts to the current week (plus a brief Sunday-morning grace window).
-- That floor was built for the guard-facing ROSTER page, to stop the archive
-- (manager-only by design) leaking through the is_manager() RLS branch's own
-- unconditional bypass. The work-log feature's seeding has a completely
-- different requirement -- a guard reviewing THEIR OWN past months of worked
-- shifts for salary purposes -- and nobody widened this policy for it.
--
-- Effect: if a week's roster is published late enough, or a guard simply
-- doesn't open /worklog within about a week of it, that week silently and
-- PERMANENTLY fails to seed for them (seedWeekFromRoster's
-- `if (!runId) return` reads as "not published yet", not "RLS hid it") --
-- confirmed live: two guards' real, already-worked shifts never arrived
-- because the roster was published a few days after the usual lead time.
--
-- Fix: drop the date floor for SELECT on these two tables -- a guard may read
-- any PUBLISHED run/assignment, any week, same as the is_manager() branch
-- already allows unconditionally. This does NOT reopen the guard-facing
-- roster archive: useVisibleRosters() (src/hooks/useGuardPortal.ts) already
-- applies its own independent client-side guardVisibleWeekFloor() filter on
-- top of whatever RLS returns, specifically so it never trusts RLS alone (see
-- that function's own comment) -- so the Roster tab and GuardHome are
-- unaffected by this change. guard_visible_from() itself (migration 16) is
-- left in place, still used by that client-side mirror; it is simply no
-- longer referenced by these two policies.
-- ============================================================================

DROP POLICY IF EXISTS runs_read ON schedule_runs;

CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated
  USING (is_manager() OR is_published);

DROP POLICY IF EXISTS assign_read ON schedule_assignments;

CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM schedule_runs r
      WHERE r.id = schedule_assignments.run_id
        AND (is_manager() OR r.is_published)
    )
  );
