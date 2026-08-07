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
-- Badge codes (spec 2.1)
--
-- 005396 is Ben's real code. Everything else is a POC placeholder; real codes
-- get collected from the team once the system is validated. Swapping them is
-- an UPDATE here plus profiles.employee_code -- no schema change.
--
-- Ben is BOTH manager and an active guard: `initial_role` controls dashboard
-- access, `profiles.is_active` controls whether the solver schedules him.
-- The two are orthogonal.
-- ----------------------------------------------------------------------------
INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
  ('005396', 'בן',    'manager'),
  ('100001', 'יובל',  'guard'),
  ('100002', 'לוק',   'guard'),
  ('100003', 'הודיה', 'guard'),
  ('100004', 'שלי',   'guard'),
  ('100005', 'ים',    'guard'),
  ('100006', 'עידן',  'guard'),
  ('100007', 'ניתאי', 'guard'),
  ('100008', 'רום',   'guard'),
  ('100009', 'אדיר',  'guard')
ON CONFLICT (employee_code) DO NOTHING;


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
