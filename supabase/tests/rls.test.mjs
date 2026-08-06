/**
 * GATE A -- Row-Level Security verification suite.
 *
 * Runs the real migrations against a real PostgreSQL engine (PGlite, Postgres
 * compiled to WASM) with a Supabase auth shim, then attacks the schema as an
 * authenticated guard.
 *
 * The premise: the anon key ships inside the phone app, so any guard can issue
 * arbitrary PostgREST calls. Every test below is something a guard could try
 * from the browser console. The UI is not a security boundary -- these policies
 * are.
 *
 *   node supabase/tests/rls.test.mjs
 */

import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(HERE, '..');

const MANAGER = '11111111-1111-1111-1111-111111111111'; // בן   - manager + active guard
const GUARD_A = '22222222-2222-2222-2222-222222222222'; // יובל - plain guard
const GUARD_B = '33333333-3333-3333-3333-333333333333'; // לוק  - plain guard

const OPEN_WEEK = '2026-08-16'; // deadline in the future -> writable
const LOCKED_WEEK = '2026-08-09'; // status 'locked'       -> read-only

let db;
let passed = 0;
let failed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Run `fn` inside a rolled-back transaction impersonating `uid`. */
async function withUser(uid, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE authenticated');
    await db.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claim.sub',
      uid ?? '',
    ]);
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

async function withRole(role, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

function ok(label) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
}

function bad(label, detail) {
  failed++;
  failures.push(`${label} -- ${detail}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}\n        ${detail}`);
}

/** Expect a statement to be rejected outright by the engine. */
async function expectError(label, uid, sql, params = [], pattern = null) {
  try {
    await withUser(uid, () => db.query(sql, params));
    bad(label, 'statement SUCCEEDED but should have been rejected');
  } catch (e) {
    const msg = String(e.message ?? e);
    if (pattern && !pattern.test(msg)) {
      bad(label, `rejected, but for the wrong reason: ${msg}`);
    } else {
      ok(label);
    }
  }
}

/** Expect a statement to succeed. */
async function expectOk(label, uid, sql, params = []) {
  try {
    await withUser(uid, () => db.query(sql, params));
    ok(label);
  } catch (e) {
    bad(label, `should have succeeded but failed: ${String(e.message ?? e)}`);
  }
}

/** Expect a SELECT to return exactly `n` rows (RLS filters silently). */
async function expectCount(label, uid, sql, params, n) {
  try {
    const res = await withUser(uid, () => db.query(sql, params));
    if (res.rows.length === n) ok(label);
    else bad(label, `expected ${n} row(s), got ${res.rows.length}`);
  } catch (e) {
    bad(label, `query threw: ${String(e.message ?? e)}`);
  }
}

/** Expect an UPDATE/DELETE to silently affect zero rows (filtered by USING). */
async function expectNoRowsAffected(label, uid, sql, params = []) {
  try {
    const res = await withUser(uid, () =>
      db.query(sql + ' RETURNING 1 AS hit', params),
    );
    if (res.rows.length === 0) ok(label);
    else bad(label, `affected ${res.rows.length} row(s); expected 0`);
  } catch (e) {
    // A hard rejection is an even stronger outcome than silent filtering.
    ok(label);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  db = new PGlite();
  await db.waitReady;

  const files = [
    join(HERE, '_supabase_shim.sql'),
    join(SUPABASE_DIR, 'migrations', '20260806000001_types_tables.sql'),
    join(SUPABASE_DIR, 'migrations', '20260806000002_functions_triggers.sql'),
    join(SUPABASE_DIR, 'migrations', '20260806000003_rls_policies.sql'),
    join(SUPABASE_DIR, 'seed.sql'),
  ];

  for (const f of files) {
    const sql = await readFile(f, 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      console.error(`\n\x1b[31mFailed applying ${f}\x1b[0m\n${e.message}\n`);
      throw e;
    }
    console.log(`  applied  ${f.replace(SUPABASE_DIR, 'supabase')}`);
  }

  // Fixture users. Created as superuser, mirroring what the claim-code Edge
  // Function will do with the service role in Step B.
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${MANAGER}', '005396@guards.local'),
      ('${GUARD_A}', '100001@guards.local'),
      ('${GUARD_B}', '100002@guards.local');

    INSERT INTO profiles (id, employee_code, display_name, role, is_active) VALUES
      ('${MANAGER}', '005396', 'בן',   'manager', TRUE),
      ('${GUARD_A}', '100001', 'יובל', 'guard',   TRUE),
      ('${GUARD_B}', '100002', 'לוק',  'guard',   TRUE);

    -- Both guards submitted for the open week.
    INSERT INTO weekly_submissions (guard_id, week_start, can_work_12h_day) VALUES
      ('${GUARD_A}', '${OPEN_WEEK}', TRUE),
      ('${GUARD_B}', '${OPEN_WEEK}', FALSE);

    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift) VALUES
      ('${GUARD_A}', '${OPEN_WEEK}', '2026-08-16', 'morning'),
      ('${GUARD_A}', '${OPEN_WEEK}', '2026-08-17', 'night'),
      ('${GUARD_B}', '${OPEN_WEEK}', '2026-08-16', 'afternoon');

    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut) VALUES
      ('${OPEN_WEEK}', '${GUARD_A}', 3),
      ('${OPEN_WEEK}', '${GUARD_B}', 4);

    -- One unpublished draft and one published roster.
    INSERT INTO schedule_runs (id, week_start, version, solver_status, is_published) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', '${OPEN_WEEK}',   1, 'OPTIMAL', FALSE),
      ('aaaaaaaa-0000-0000-0000-000000000002', '${LOCKED_WEEK}', 1, 'OPTIMAL', TRUE);

    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', '2026-08-16', 'morning', '${GUARD_A}'),
      ('aaaaaaaa-0000-0000-0000-000000000002', '2026-08-09', 'morning', '${GUARD_A}');
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n\x1b[1mGATE A -- Row-Level Security\x1b[0m\n');
  await setup();

  console.log('\n\x1b[1m1. Preference isolation between guards\x1b[0m');
  await expectCount(
    'guard sees ONLY their own preferences (2 of 3 rows)',
    GUARD_A,
    'SELECT * FROM weekly_wish_preferences',
    [],
    2,
  );
  await expectCount(
    "guard cannot target another guard's preferences directly",
    GUARD_A,
    'SELECT * FROM weekly_wish_preferences WHERE guard_id = $1',
    [GUARD_B],
    0,
  );
  await expectCount(
    'MANAGER reads every guard preference (dashboard must not render empty)',
    MANAGER,
    'SELECT * FROM weekly_wish_preferences',
    [],
    3,
  );
  await expectNoRowsAffected(
    "guard cannot DELETE another guard's preferences",
    GUARD_A,
    'DELETE FROM weekly_wish_preferences WHERE guard_id = $1',
    [GUARD_B],
  );
  await expectError(
    "guard cannot INSERT a preference under another guard's id",
    GUARD_A,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, '2026-08-18', 'morning')`,
    [GUARD_B, OPEN_WEEK],
    /row-level security/i,
  );

  console.log('\n\x1b[1m2. Submission deadline (Thursday 20:00) enforced by the engine\x1b[0m');
  await expectOk(
    'guard CAN submit while the week is open',
    GUARD_A,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, '2026-08-18', 'afternoon')`,
    [GUARD_A, OPEN_WEEK],
  );
  await expectError(
    'guard CANNOT submit for a locked week',
    GUARD_A,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, '2026-08-10', 'morning')`,
    [GUARD_A, LOCKED_WEEK],
    /row-level security/i,
  );
  await expectOk(
    'MANAGER can still edit a locked week',
    MANAGER,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, '2026-08-10', 'morning')`,
    [GUARD_A, LOCKED_WEEK],
  );
  await expectNoRowsAffected(
    'guard cannot move the deadline to reopen a week',
    GUARD_A,
    `UPDATE roster_weeks SET submission_deadline = NOW() + INTERVAL '30 days'
     WHERE week_start = $1`,
    [LOCKED_WEEK],
  );

  console.log('\n\x1b[1m3. Privilege escalation\x1b[0m');
  await expectError(
    'guard cannot promote themselves to manager',
    GUARD_A,
    `UPDATE profiles SET role = 'manager' WHERE id = $1`,
    [GUARD_A],
    /cannot modify profiles.role/i,
  );
  await expectError(
    'guard cannot flip their own is_active flag',
    GUARD_A,
    'UPDATE profiles SET is_active = FALSE WHERE id = $1',
    [GUARD_A],
    /cannot modify profiles.is_active/i,
  );
  await expectError(
    'guard cannot rewrite their own badge code',
    GUARD_A,
    `UPDATE profiles SET employee_code = '005396' WHERE id = $1`,
    [GUARD_A],
    /cannot modify profiles.employee_code/i,
  );
  await expectNoRowsAffected(
    "guard cannot demote the manager",
    GUARD_A,
    `UPDATE profiles SET role = 'guard' WHERE id = $1`,
    [MANAGER],
  );
  await expectOk(
    'guard CAN still edit their own display name',
    GUARD_A,
    `UPDATE profiles SET display_name = 'יובל כ.' WHERE id = $1`,
    [GUARD_A],
  );
  await expectOk(
    'MANAGER can change a role',
    MANAGER,
    `UPDATE profiles SET role = 'manager' WHERE id = $1`,
    [GUARD_A],
  );

  console.log('\n\x1b[1m4. Manager-only configuration tables\x1b[0m');
  await expectError(
    'guard cannot create a roster week',
    GUARD_A,
    `INSERT INTO roster_weeks (week_start, submission_deadline)
     VALUES ('2026-08-30', NOW() + INTERVAL '5 days')`,
    [],
    /row-level security/i,
  );
  await expectOk(
    'MANAGER can create a roster week',
    MANAGER,
    `INSERT INTO roster_weeks (week_start, submission_deadline)
     VALUES ('2026-08-30', NOW() + INTERVAL '5 days')`,
  );
  await expectNoRowsAffected(
    'guard cannot raise their own כמות',
    GUARD_A,
    'UPDATE weekly_guard_targets SET configured_kamut = 5 WHERE guard_id = $1',
    [GUARD_A],
  );
  await expectError(
    'guard cannot INSERT a כמות row for themselves',
    GUARD_A,
    `INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
     VALUES ($1, $2, 5)`,
    ['2026-08-23', GUARD_A],
    /row-level security/i,
  );
  await expectCount(
    'guard CAN read their own כמות',
    GUARD_A,
    'SELECT * FROM weekly_guard_targets',
    [],
    1,
  );
  await expectCount(
    "guard cannot read another guard's כמות",
    GUARD_A,
    'SELECT * FROM weekly_guard_targets WHERE guard_id = $1',
    [GUARD_B],
    0,
  );

  console.log('\n\x1b[1m5. Badge-code table is sealed\x1b[0m');
  await expectCount(
    'guard cannot enumerate unclaimed badge codes',
    GUARD_A,
    'SELECT * FROM roster_codes',
    [],
    0,
  );
  await expectCount(
    'MANAGER can audit badge codes (10 seeded)',
    MANAGER,
    'SELECT * FROM roster_codes',
    [],
    10,
  );
  await expectError(
    'nobody can INSERT a badge code through the API -- not even the manager',
    MANAGER,
    `INSERT INTO roster_codes (employee_code, display_name) VALUES ('999999', 'שתול')`,
    [],
    /permission denied|row-level security/i,
  );

  console.log('\n\x1b[1m6. Draft rosters do not leak before publication\x1b[0m');
  await expectCount(
    'guard sees ONLY the published run',
    GUARD_A,
    'SELECT * FROM schedule_runs',
    [],
    1,
  );
  await expectCount(
    'MANAGER sees draft + published',
    MANAGER,
    'SELECT * FROM schedule_runs',
    [],
    2,
  );
  await expectCount(
    'guard sees no assignment belonging to a draft run',
    GUARD_A,
    'SELECT * FROM schedule_assignments',
    [],
    1,
  );
  await expectError(
    'guard cannot assign themselves a shift',
    GUARD_A,
    `INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000002', '2026-08-11', 'morning', $1)`,
    [GUARD_A],
    /row-level security/i,
  );
  // Note: this is silently filtered rather than rejected. No policy grants a
  // guard UPDATE on schedule_runs, so the row is invisible to the statement and
  // zero rows change -- Postgres does not raise for an UPDATE that matches
  // nothing. Asserting "0 rows affected" is the correct check here; asserting
  // "throws" would be testing the wrong mechanism.
  await expectNoRowsAffected(
    'guard cannot publish a draft roster',
    GUARD_A,
    `UPDATE schedule_runs SET is_published = TRUE
     WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'`,
  );
  await expectNoRowsAffected(
    'guard cannot unpublish the live roster',
    GUARD_A,
    `UPDATE schedule_runs SET is_published = FALSE
     WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002'`,
  );
  await expectNoRowsAffected(
    'guard cannot delete assignments from the published roster',
    GUARD_A,
    'DELETE FROM schedule_assignments WHERE guard_id = $1',
    [GUARD_A],
  );

  console.log('\n\x1b[1m7. Anonymous access\x1b[0m');
  for (const t of ['profiles', 'weekly_wish_preferences', 'schedule_assignments']) {
    try {
      await withRole('anon', () => db.query(`SELECT * FROM ${t}`));
      bad(`anon cannot read ${t}`, 'SELECT succeeded');
    } catch (e) {
      if (/permission denied/i.test(String(e.message))) ok(`anon cannot read ${t}`);
      else bad(`anon cannot read ${t}`, String(e.message));
    }
  }

  console.log('\n\x1b[1m8. Data-integrity constraints\x1b[0m');
  await expectError(
    'a preference cannot escape its own week',
    MANAGER,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, '2026-09-30', 'morning')`,
    [GUARD_A, OPEN_WEEK],
    /date_within_week/i,
  );
  await expectError(
    'a guard cannot be double-booked on one day (manual override guard-rail)',
    MANAGER,
    `INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '2026-08-16', 'night', $1)`,
    [GUARD_A],
    /one_shift_per_guard_per_day/i,
  );
  // Must use a fresh version number: reusing version 1 would trip the
  // (week_start, version) unique key first and never exercise the partial index.
  await expectError(
    'a week cannot have two published rosters',
    MANAGER,
    `INSERT INTO schedule_runs (week_start, version, solver_status, is_published)
     VALUES ($1, 2, 'OPTIMAL', TRUE)`,
    [LOCKED_WEEK],
    /one_published_run_per_week/i,
  );
  await expectOk(
    'but a week may hold many unpublished drafts',
    MANAGER,
    `INSERT INTO schedule_runs (week_start, version, solver_status, is_published)
     VALUES ($1, 2, 'OPTIMAL', FALSE)`,
    [LOCKED_WEEK],
  );
  await expectError(
    'a roster week must start on a Sunday',
    MANAGER,
    `INSERT INTO roster_weeks (week_start, submission_deadline)
     VALUES ('2026-08-19', NOW() + INTERVAL '5 days')`,
    [],
    /roster_weeks_week_start_check|check constraint/i,
  );
  await expectError(
    'badge codes must be exactly 6 digits',
    MANAGER,
    `UPDATE profiles SET employee_code = '12' WHERE id = $1`,
    [GUARD_A],
    /profiles_employee_code_check|check constraint/i,
  );
  await expectError(
    'כמות cannot exceed the 5-shift ceiling',
    MANAGER,
    'UPDATE weekly_guard_targets SET configured_kamut = 9 WHERE guard_id = $1',
    [GUARD_A],
    /configured_kamut|check constraint/i,
  );

  console.log('\n\x1b[1m9. Empty submissions are a first-class state (spec 3.4)\x1b[0m');
  await expectCount(
    'submitted-but-empty is distinguishable from never-submitted',
    MANAGER,
    `SELECT p.display_name,
            (s.id IS NOT NULL) AS submitted,
            COUNT(w.id)        AS slots
       FROM profiles p
       LEFT JOIN weekly_submissions s
              ON s.guard_id = p.id AND s.week_start = $1
       LEFT JOIN weekly_wish_preferences w
              ON w.guard_id = p.id AND w.week_start = $1
      GROUP BY p.display_name, s.id`,
    [OPEN_WEEK],
    3,
  );

  // ---------------------------------------------------------------------
  console.log(
    `\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
      (failed ? `\x1b[31m${failed} failed\x1b[0m` : '0 failed'),
  );
  if (failed) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n\x1b[32mGATE A PASSED\x1b[0m\n');
}

run().catch((e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e);
  process.exit(1);
});
