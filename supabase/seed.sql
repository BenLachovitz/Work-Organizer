-- ============================================================================
-- Seed data -- Dynamic Security Guard Shift Scheduler
--
-- This seed contains ONLY data that legitimately exists before anyone logs in:
-- pre-registered badge codes and the schedulable weeks.
--
-- It deliberately does NOT create profiles. A profile requires an auth.users
-- row, and those are created by the real claim-code flow (Step B) so that the
-- flow itself is what gets exercised, rather than being bypassed by fixtures.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Badge codes (spec 2.1) -- ONE-TIME BOOTSTRAP ONLY.
--
-- 005396 is Ben's real code; 100001-100007 are the seven guards who have
-- since registered for real. Team management (migration 20) is now how a
-- badge code gets added, edited or deleted -- this block's only job is
-- getting a genuinely EMPTY database to a usable starting point.
--
-- Gated on the table being empty, not `ON CONFLICT DO NOTHING`: this file
-- reruns on every `db:apply`, and a manager DELETING an employee (migration
-- 21 -- a real, intended action) makes them a non-conflict again, not a
-- protected one. `ON CONFLICT DO NOTHING` would silently resurrect anyone
-- deleted the next time this script ran -- which is exactly what happened to
-- one of the original placeholder codes before this fix. Once the table has
-- ANY row, real or not, this block never touches it again.
--
-- Ben is BOTH manager and an active guard: `initial_role` controls dashboard
-- access, `profiles.is_active` controls whether the solver schedules him.
-- The two are orthogonal.
-- ----------------------------------------------------------------------------
INSERT INTO roster_codes (employee_code, display_name, initial_role)
SELECT v.employee_code, v.display_name, v.initial_role::user_role
  FROM (VALUES
    ('005396', 'בן',    'manager'),
    ('100001', 'יובל',  'guard'),
    ('100002', 'לוק',   'guard'),
    ('100003', 'הודיה', 'guard'),
    ('100004', 'שלי',   'guard'),
    ('100005', 'ים',    'guard'),
    ('100006', 'עידן',  'guard'),
    ('100007', 'ניתאי', 'guard')
  ) AS v(employee_code, display_name, initial_role)
 WHERE NOT EXISTS (SELECT 1 FROM roster_codes);


-- ----------------------------------------------------------------------------
-- Schedulable weeks
--
-- Weeks are NOT seeded by hand any more. ensure_roster_weeks() (migration 10)
-- owns the lifecycle: it creates the current week and walks forward until one
-- week is open for submissions, deriving every deadline from the Wednesday
-- 19:00 Asia/Jerusalem rule.
--
-- Hand-seeded weeks were scaffolding for the test suites (a locked one, an open
-- one, and one at morning target 3). Those paths are covered by the suites now,
-- which build their own throwaway weeks rather than relying on fixtures that
-- silently go stale as real dates pass.
--
-- Idempotent, so this is safe on every db:apply.
-- ----------------------------------------------------------------------------
SELECT public.ensure_roster_weeks();
