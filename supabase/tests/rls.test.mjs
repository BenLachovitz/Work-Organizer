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
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(HERE, '..');

const MANAGER = '11111111-1111-1111-1111-111111111111'; // בן   - manager + active guard
const GUARD_A = '22222222-2222-2222-2222-222222222222'; // יובל - plain guard
const GUARD_B = '33333333-3333-3333-3333-333333333333'; // לוק  - plain guard
const GUARD_C = '44444444-4444-4444-4444-444444444444'; // new hire, claimed mid-test
const GUARD_D = '55555555-5555-5555-5555-555555555555'; // deleted mid-test

// Weeks this suite OWNS. The seed no longer creates fixed weeks -- it calls
// ensure_roster_weeks(), whose output depends on today's date -- so borrowing
// one would make this suite fail on a future date rather than on a regression.
const OPEN_WEEK = '2026-11-01';   // created open, deadline far in the future
const LOCKED_WEEK = '2026-11-08'; // created locked, deadline already past

/** week_start + n days, as YYYY-MM-DD. Keeps fixtures inside their own week. */
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

/** Like `withUser`, but COMMITs -- for the one test that has to prove a
 *  cascade actually persisted, not merely that the statement did not error. */
async function withUserCommitted(uid, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE authenticated');
    await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', uid ?? '']);
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
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

  // Migrations are DISCOVERED, not listed. A hardcoded list silently stops
  // testing every migration added after it was written -- which is exactly what
  // happened: the seed began calling a function defined in migration 10 while
  // this harness was still applying only the first three.
  const migrations = (await readdir(join(SUPABASE_DIR, 'migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort() // timestamp prefixes make lexical order == chronological order
    .map((f) => join(SUPABASE_DIR, 'migrations', f));

  const files = [
    join(HERE, '_supabase_shim.sql'),
    ...migrations,
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

    -- Weeks owned by this suite, with explicit deadlines so the assertions
    -- hold on any calendar date.
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
      ('${OPEN_WEEK}',   2, NOW() + INTERVAL '30 days', 'open'),
      ('${LOCKED_WEEK}', 2, NOW() - INTERVAL '2 days',  'locked')
    ON CONFLICT (week_start) DO NOTHING;

    -- Both guards submitted for the open week.
    INSERT INTO weekly_submissions (guard_id, week_start) VALUES
      ('${GUARD_A}', '${OPEN_WEEK}'),
      ('${GUARD_B}', '${OPEN_WEEK}');

    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift) VALUES
      ('${GUARD_A}', '${OPEN_WEEK}', '${OPEN_WEEK}'::date + 0, 'morning'),
      ('${GUARD_A}', '${OPEN_WEEK}', '${OPEN_WEEK}'::date + 1, 'night'),
      ('${GUARD_B}', '${OPEN_WEEK}', '${OPEN_WEEK}'::date + 0, 'afternoon');

    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut) VALUES
      ('${OPEN_WEEK}', '${GUARD_A}', 3),
      ('${OPEN_WEEK}', '${GUARD_B}', 4);

    -- One unpublished draft and one published roster.
    INSERT INTO schedule_runs (id, week_start, version, solver_status, is_published) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', '${OPEN_WEEK}',   1, 'OPTIMAL', FALSE),
      ('aaaaaaaa-0000-0000-0000-000000000002', '${LOCKED_WEEK}', 1, 'OPTIMAL', TRUE);

    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', '${OPEN_WEEK}'::date + 0, 'morning', '${GUARD_A}'),
      ('aaaaaaaa-0000-0000-0000-000000000002', '${LOCKED_WEEK}'::date + 0, 'morning', '${GUARD_A}');
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
     VALUES ($1, $2, $3, 'morning')`,
    [GUARD_B, OPEN_WEEK, addDays(OPEN_WEEK, 2)],
    /row-level security/i,
  );

  console.log('\n\x1b[1m2. Submission deadline (Wednesday 19:00) enforced by the engine\x1b[0m');
  await expectOk(
    'guard CAN submit while the week is open',
    GUARD_A,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, $3, 'afternoon')`,
    [GUARD_A, OPEN_WEEK, addDays(OPEN_WEEK, 2)],
  );
  await expectError(
    'guard CANNOT submit for a locked week',
    GUARD_A,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, $3, 'morning')`,
    [GUARD_A, LOCKED_WEEK, addDays(LOCKED_WEEK, 1)],
    /row-level security/i,
  );
  await expectOk(
    'MANAGER can still edit a locked week',
    MANAGER,
    `INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
     VALUES ($1, $2, $3, 'morning')`,
    [GUARD_A, LOCKED_WEEK, addDays(LOCKED_WEEK, 1)],
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
     VALUES ('2026-11-22', NOW() + INTERVAL '5 days')`,
    [],
    /row-level security/i,
  );
  await expectOk(
    'MANAGER can create a roster week',
    MANAGER,
    `INSERT INTO roster_weeks (week_start, submission_deadline)
     VALUES ('2026-11-22', NOW() + INTERVAL '5 days')`,
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
    [OPEN_WEEK, GUARD_A],
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
    // 8, not 10 -- seed.sql used to include two placeholder codes (רום,
    // אדיר) for guards nobody had hired yet. Removed once real team
    // management existed to add them for real; see the seed.sql comment.
    'MANAGER can audit badge codes (8 seeded)',
    MANAGER,
    'SELECT * FROM roster_codes',
    [],
    8,
  );
  await expectError(
    'guard cannot INSERT a badge code (adding an employee is manager-only)',
    GUARD_A,
    `INSERT INTO roster_codes (employee_code, display_name) VALUES ('999999', 'שתול')`,
    [],
    /permission denied|row-level security/i,
  );
  await expectOk(
    'manager CAN add a new employee, with a default כמות (migration 20)',
    MANAGER,
    `INSERT INTO roster_codes (employee_code, display_name, default_kamut) VALUES ('999999', 'שתול', 3)`,
    [],
  );
  // `withUser` runs each assertion inside its own rolled-back transaction, so
  // the row above does not persist for a later statement to see -- expected,
  // and irrelevant here since this checks RLS filtering, not the row's
  // contents. A DELETE blocked by RLS's USING clause matches zero rows rather
  // than throwing (the same silent-filter behaviour UPDATE has), so this
  // needs expectNoRowsAffected, not expectError -- an earlier version of this
  // assertion used expectError and passed for the wrong reason back when
  // roster_codes had no DELETE grant at all; the base grant now exists and
  // RLS is what has to stop the guard.
  await expectNoRowsAffected(
    'guard cannot DELETE a badge code',
    GUARD_A,
    `DELETE FROM roster_codes WHERE employee_code = '999999'`,
    [],
  );
  await expectOk(
    'manager can cancel an unclaimed invitation',
    MANAGER,
    `DELETE FROM roster_codes WHERE employee_code = '999999'`,
    [],
  );
  {
    // Both inserts have to persist for the trigger to see the first from the
    // second, so this runs as direct, un-rolled-back statements -- mirroring
    // production, where claim-code's admin client and the roster_codes row it
    // reads exist in the same real transaction, not two throwaway ones.
    await db.exec(`
      INSERT INTO roster_codes (employee_code, display_name, default_kamut)
      VALUES ('999998', 'חדש', 4);
      INSERT INTO auth.users (id, email) VALUES ('${GUARD_C}', '999998@guards.local');
      INSERT INTO profiles (id, employee_code, display_name, role, is_active)
      VALUES ('${GUARD_C}', '999998', 'חדש', 'guard', TRUE);
    `);
    await expectCount(
      "claiming carries the pre-configured default onto the guard's profile (trg_profiles_default_kamut)",
      MANAGER,
      'SELECT * FROM profiles WHERE id = $1 AND default_kamut = 4',
      [GUARD_C],
      1,
    );
    // This profile is not part of the suite's normal fixture set, and section
    // 9 below counts every row in `profiles` -- it must not still be here.
    await db.exec(`
      DELETE FROM profiles WHERE id = '${GUARD_C}';
      DELETE FROM auth.users WHERE id = '${GUARD_C}';
      DELETE FROM roster_codes WHERE employee_code = '999998';
    `);
  }

  console.log('\n\x1b[1m5a. delete_employee -- real cascade deletion (migration 21)\x1b[0m');
  {
    // A guard with real dependent rows, so the cascade has something to prove.
    await db.exec(`
      INSERT INTO roster_codes (employee_code, display_name) VALUES ('999997', 'למחיקה');
      INSERT INTO auth.users (id, email) VALUES ('${GUARD_D}', '999997@guards.local');
      INSERT INTO profiles (id, employee_code, display_name, role, is_active)
      VALUES ('${GUARD_D}', '999997', 'למחיקה', 'guard', TRUE);
      INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
      VALUES ('${GUARD_D}', '${OPEN_WEEK}', '${OPEN_WEEK}', 'morning');
    `);

    await expectError(
      'guard cannot call delete_employee',
      GUARD_A,
      'SELECT public.delete_employee($1)',
      ['999997'],
      /managers only|insufficient privilege/i,
    );
    await expectError(
      'manager cannot delete their own account',
      MANAGER,
      'SELECT public.delete_employee($1)',
      ['005396'],
      /cannot delete your own account/i,
    );

    // Has to COMMIT, not roll back like every other assertion here -- the
    // whole point is proving the cascade actually persisted.
    await withUserCommitted(MANAGER, () =>
      db.query('SELECT public.delete_employee($1)', ['999997']),
    );

    const [profileGone, prefsGone, codeGone] = await Promise.all([
      db.query('SELECT * FROM profiles WHERE employee_code = $1', ['999997']),
      db.query('SELECT * FROM weekly_wish_preferences WHERE guard_id = $1', [GUARD_D]),
      db.query('SELECT * FROM roster_codes WHERE employee_code = $1', ['999997']),
    ]);
    profileGone.rows.length === 0 && prefsGone.rows.length === 0 && codeGone.rows.length === 0
      ? ok('deleting the employee cascades away their profile, preferences and badge code')
      : bad(
          'delete_employee cascade',
          `profile=${profileGone.rows.length} prefs=${prefsGone.rows.length} code=${codeGone.rows.length}`,
        );

    // An unclaimed invitation (no profile at all) goes through the same
    // function -- the auth.users branch is simply skipped.
    await db.exec(`INSERT INTO roster_codes (employee_code, display_name) VALUES ('999996', 'ממתין')`);
    await withUserCommitted(MANAGER, () =>
      db.query('SELECT public.delete_employee($1)', ['999996']),
    );
    const pendingGone = await db.query('SELECT * FROM roster_codes WHERE employee_code = $1', [
      '999996',
    ]);
    pendingGone.rows.length === 0
      ? ok('the same function cancels an unclaimed invitation (no profile to touch)')
      : bad('delete_employee on a pending code', JSON.stringify(pendingGone.rows));
  }

  console.log('\n\x1b[1m5b. Configurable submission window (migration 22)\x1b[0m');
  {
    await expectCount(
      'defaults match the old hardcoded values (Wed 19:00 close, Sat 20:00 open)',
      MANAGER,
      `SELECT 1 FROM scheduler_settings
        WHERE deadline_offset_days = 4 AND deadline_time = '19:00'
          AND open_offset_days = 8 AND open_time = '20:00'`,
      [],
      1,
    );
    await expectNoRowsAffected(
      'guard cannot change the submission window',
      GUARD_A,
      `UPDATE scheduler_settings SET deadline_time = '12:00' WHERE id`,
      [],
    );
    await expectError(
      'opening after the deadline is rejected (open_before_deadline)',
      MANAGER,
      `UPDATE scheduler_settings SET open_offset_days = 2 WHERE id`, // 2 < deadline's 4 -- later in time, not before
      [],
      /open_before_deadline|check constraint/i,
    );

    // Has to persist (COMMIT) so the NEXT statement -- a plain, unimpersonated
    // deadline_for_week() call -- can observe it actually changed.
    await withUserCommitted(MANAGER, () =>
      db.query(`UPDATE scheduler_settings SET deadline_time = '17:30' WHERE id`),
    );
    // Converted back to local time explicitly -- relying on the raw value's
    // string form would only work by accident of whatever timezone the
    // engine happens to render it in.
    const moved = await db.query(
      `SELECT (public.deadline_for_week('2026-08-16') AT TIME ZONE 'Asia/Jerusalem')::TEXT AS d`,
    );
    /17:30/.test(moved.rows[0].d)
      ? ok('deadline_for_week() reflects the new time immediately (STABLE, not IMMUTABLE)')
      : bad('deadline_for_week reflects setting', JSON.stringify(moved.rows[0]));

    // Restore -- nothing else in this file depends on scheduler_settings, but
    // leaving it changed would be a silent trap for the next thing that does.
    await db.exec(`UPDATE scheduler_settings SET deadline_time = '19:00' WHERE id`);
  }

  console.log('\n\x1b[1m5c. seed.sql does not revive a deleted employee\x1b[0m');
  {
    // This is the exact scenario that actually happened in production: a
    // manager deleted a badge code through the real feature, and the NEXT
    // `npm run db:apply` -- which reruns seed.sql unconditionally, on top of
    // a database that already has real data -- brought it back, because the
    // old seed used `ON CONFLICT (employee_code) DO NOTHING` and a deleted
    // row is no longer a conflict. Fixed by gating the whole seed on the
    // table being empty; this proves that gate actually holds.
    await withUserCommitted(MANAGER, () => db.query(`SELECT public.delete_employee('100007')`));
    const gone = await db.query(`SELECT * FROM roster_codes WHERE employee_code = '100007'`);
    if (gone.rows.length !== 0) bad('precondition', 'delete of ניתאי did not take');

    const seedSql = await readFile(join(SUPABASE_DIR, 'seed.sql'), 'utf8');
    await db.exec(seedSql);

    const stillGone = await db.query(`SELECT * FROM roster_codes WHERE employee_code = '100007'`);
    stillGone.rows.length === 0
      ? ok('re-running seed.sql does NOT resurrect a deleted employee')
      : bad('seed.sql revival', JSON.stringify(stillGone.rows));

    // Restore -- section 5's "8 seeded" count and anything counting
    // roster_codes from here on assumes the full original seed is intact.
    await db.exec(`INSERT INTO roster_codes (employee_code, display_name, initial_role)
                   VALUES ('100007', 'ניתאי', 'guard')`);
  }

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
     VALUES ('aaaaaaaa-0000-0000-0000-000000000002', $2, 'morning', $1)`,
    [GUARD_A, addDays(LOCKED_WEEK, 2)],
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
     VALUES ($1, $2, $3, 'morning')`,
    [GUARD_A, OPEN_WEEK, '2026-12-25'],
    /date_within_week/i,
  );
  await expectError(
    'a guard cannot be double-booked on one day (manual override guard-rail)',
    MANAGER,
    `INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001', $2, 'night', $1)`,
    [GUARD_A, addDays(OPEN_WEEK, 0)],
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
     VALUES ('2026-11-16', NOW() + INTERVAL '5 days')`,
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
