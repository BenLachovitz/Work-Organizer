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
-- Schedulable weeks (spec 12)
--
-- Submissions for a roster week run during the PRECEDING week and close on that
-- Wednesday at 19:00 Asia/Jerusalem. So the deadline for a week starting Sunday
-- is always (week_start - 4 days) at 19:00 local.
--
-- Written as `TIMESTAMPTZ '... Asia/Jerusalem'` rather than a fixed +03 offset
-- so the value stays correct across the IDT/IST daylight-saving boundary.
-- ----------------------------------------------------------------------------

-- The spec's original target week. Its Wednesday deadline (2026-08-05 19:00)
-- has already passed, so it is seeded as `locked`. Useful precisely because it
-- exercises the closed-week path: is_week_open() must return FALSE for it.
INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
  ('2026-08-09', 2, TIMESTAMPTZ '2026-08-05 19:00:00 Asia/Jerusalem', 'locked')
ON CONFLICT (week_start) DO NOTHING;

-- The live week guards can actually submit for right now.
INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
  ('2026-08-16', 2, TIMESTAMPTZ '2026-08-12 19:00:00 Asia/Jerusalem', 'open')
ON CONFLICT (week_start) DO NOTHING;

-- A third week with the morning target raised to 3, so the 2-vs-3 capacity
-- rule and its floor of 2 can be exercised without editing data by hand.
INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
  ('2026-08-23', 3, TIMESTAMPTZ '2026-08-19 19:00:00 Asia/Jerusalem', 'open')
ON CONFLICT (week_start) DO NOTHING;
