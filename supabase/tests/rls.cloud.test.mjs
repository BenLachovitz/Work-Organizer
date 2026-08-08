/**
 * GATE A (cloud) -- Row-Level Security verified against the live project.
 *
 * The PGlite suite proves the policy LOGIC. This proves the DEPLOYMENT: real
 * GoTrue JWTs, the real `authenticated` role, the real publishable key, and
 * PostgREST rather than raw SQL. Those layers can differ from a local engine,
 * and a policy that works in PGlite but not through PostgREST is still a hole.
 *
 * Creates throwaway users (codes 9000xx), attacks the API as each of them, then
 * deletes them. It never touches the seeded roster.
 *
 *   node supabase/tests/rls.cloud.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const env = {};
for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}

const URL_BASE = env.VITE_SUPABASE_URL;
const APIKEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const REF = URL_BASE.match(/https:\/\/([a-z0-9]+)\./)[1];

const MANAGER = { code: '900001', name: 'בדיקה-מנהל', role: 'manager', pin: 'Test-1234' };
const GUARD_A = { code: '900002', name: 'בדיקה-א', role: 'guard', pin: 'Test-1234' };
const GUARD_B = { code: '900003', name: 'בדיקה-ב', role: 'guard', pin: 'Test-1234' };

// Weeks this suite OWNS. Nothing here borrows whichever weeks the lifecycle
// happens to have produced: a test whose meaning depends on today's date
// reports a broken app on a date when nothing is actually broken.
const OPEN_WEEK = '2026-10-04';   // created open, deadline far in the future
const LOCKED_WEEK = '2026-10-11'; // created locked, deadline already past
const PAST_WEEK = '2026-07-26';   // before current_week_start(): the archive cut

/** week_start + n days, as YYYY-MM-DD. */
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};


let passed = 0;
const failures = [];

// ---------------------------------------------------------------------------

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body;
}

async function signIn(user) {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${user.code}@guards.local`, password: user.pin }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${user.code}: ${JSON.stringify(body)}`);
  return body.access_token;
}

/** Authenticated PostgREST call, exactly as the phone app makes it. */
async function rest(token, path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: APIKEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function ok(label) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
}
function bad(label, detail) {
  failures.push(`${label} -- ${detail}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}\n        ${detail}`);
}

async function expectRows(label, token, path, n) {
  const { status, body } = await rest(token, path);
  if (status !== 200) return bad(label, `HTTP ${status}: ${JSON.stringify(body)}`);
  if (Array.isArray(body) && body.length === n) ok(label);
  else bad(label, `expected ${n} row(s), got ${Array.isArray(body) ? body.length : '?'}`);
}

/** RLS denial through PostgREST is 401/403 on write, or an empty array on read. */
async function expectDenied(label, token, path, init) {
  const { status, body } = await rest(token, path, init);
  if (status === 401 || status === 403) return ok(label);
  if (status >= 400) return ok(label); // constraint/trigger rejection is also a denial
  if (Array.isArray(body) && body.length === 0) return ok(label);
  bad(label, `allowed with HTTP ${status}: ${JSON.stringify(body).slice(0, 160)}`);
}

async function expectAllowed(label, token, path, init) {
  const { status, body } = await rest(token, path, init);
  if (status >= 200 && status < 300) ok(label);
  else bad(label, `HTTP ${status}: ${JSON.stringify(body).slice(0, 160)}`);
}

// ---------------------------------------------------------------------------

async function setup() {
  // pgcrypto lives in the `extensions` schema on Supabase.
  await sql(`
    DELETE FROM auth.users WHERE email LIKE '9000%@guards.local';

    -- Weeks owned by this suite, deadlines set explicitly rather than derived,
    -- so every assertion holds on any calendar date.
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
      ('${OPEN_WEEK}'::date,   2, NOW() + INTERVAL '30 days', 'open'),
      ('${LOCKED_WEEK}'::date, 2, NOW() - INTERVAL '2 days',  'locked'),
      ('${PAST_WEEK}'::date,   2, NOW() - INTERVAL '60 days', 'published')
    ON CONFLICT (week_start) DO NOTHING;

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
      'authenticated', c.code || '@guards.local',
      extensions.crypt('Test-1234', extensions.gen_salt('bf')), NOW(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
      '', '', '', ''
    FROM (VALUES ('900001'), ('900002'), ('900003')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email, '@', 1),
           CASE split_part(u.email,'@',1) WHEN '900001' THEN 'בדיקה-מנהל'
                                          WHEN '900002' THEN 'בדיקה-א' ELSE 'בדיקה-ב' END,
           CASE split_part(u.email,'@',1) WHEN '900001' THEN 'manager'::user_role
                                          ELSE 'guard'::user_role END,
           TRUE
      FROM auth.users u WHERE u.email LIKE '9000%@guards.local';

    -- Fixtures owned by the two test guards.
    INSERT INTO weekly_submissions (guard_id, week_start)
    SELECT id, '${OPEN_WEEK}'::date FROM profiles WHERE employee_code IN ('900002','900003');

    -- Casts are required: across UNION branches Postgres infers text for bare
    -- literals and will not implicitly coerce them to date / base_shift.
    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift)
    SELECT id, '${OPEN_WEEK}'::date, '${OPEN_WEEK}'::date, 'morning'::base_shift
      FROM profiles WHERE employee_code = '900002'
    UNION ALL
    SELECT id, '${OPEN_WEEK}'::date, ('${OPEN_WEEK}'::date + 1), 'night'::base_shift
      FROM profiles WHERE employee_code = '900002'
    UNION ALL
    SELECT id, '${OPEN_WEEK}'::date, '${OPEN_WEEK}'::date, 'afternoon'::base_shift
      FROM profiles WHERE employee_code = '900003';

    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
    SELECT '${OPEN_WEEK}'::date, id, 3 FROM profiles WHERE employee_code = '900002'
    UNION ALL
    SELECT '${OPEN_WEEK}'::date, id, 4 FROM profiles WHERE employee_code = '900003';

    INSERT INTO schedule_runs (id, week_start, version, solver_status, is_published) VALUES
      ('cccccccc-0000-0000-0000-000000000001', '${OPEN_WEEK}'::date,   99, 'TEST', FALSE),
      ('cccccccc-0000-0000-0000-000000000002', '${LOCKED_WEEK}'::date, 99, 'TEST', TRUE),
      ('cccccccc-0000-0000-0000-000000000003', '${PAST_WEEK}'::date,   99, 'TEST', TRUE);

    INSERT INTO schedule_assignments (run_id, target_date, shift, guard_id)
    SELECT 'cccccccc-0000-0000-0000-000000000001'::uuid, '${OPEN_WEEK}'::date,
           'morning'::shift_type, id
      FROM profiles WHERE employee_code = '900002'
    UNION ALL
    -- The guard's OWN shift in a finished week. The archive cut is absolute,
    -- so they must not see even this.
    SELECT 'cccccccc-0000-0000-0000-000000000003'::uuid, ('${PAST_WEEK}'::date + 1),
           'morning'::shift_type, id
      FROM profiles WHERE employee_code = '900002';
  `);
}

async function teardown() {
  await sql(`
    DELETE FROM schedule_runs WHERE version = 99;
    DELETE FROM auth.users WHERE email LIKE '9000%@guards.local';
    -- Only the throwaway archive week; leaves the real lifecycle weeks alone.
    DELETE FROM roster_weeks WHERE week_start IN ('${OPEN_WEEK}', '${LOCKED_WEEK}', '${PAST_WEEK}');
  `);
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('\n\x1b[1mGATE A (cloud) -- live RLS over PostgREST\x1b[0m');
  console.log(`project: ${REF}\n`);

  await setup();
  const [mgr, a, b] = await Promise.all([signIn(MANAGER), signIn(GUARD_A), signIn(GUARD_B)]);
  console.log('  signed in 3 users with real GoTrue JWTs\n');

  const ids = await sql(
    `SELECT employee_code, id FROM profiles WHERE employee_code IN ('900002','900003')`);
  const idOf = (code) => ids.find((r) => r.employee_code === code).id;

  console.log('\x1b[1m1. Preference isolation\x1b[0m');
  await expectRows('guard reads only their own preferences', a,
    `weekly_wish_preferences?select=id&week_start=eq.${OPEN_WEEK}&guard_id=eq.${idOf('900002')}`, 2);
  await expectRows("guard reads ZERO of another guard's preferences", a,
    `weekly_wish_preferences?select=id&guard_id=eq.${idOf('900003')}`, 0);
  await expectRows('manager reads both guards', mgr,
    `weekly_wish_preferences?select=id&week_start=eq.${OPEN_WEEK}&guard_id=in.(${idOf('900002')},${idOf('900003')})`, 3);
  await expectDenied("guard cannot insert under another guard's id", a, 'weekly_wish_preferences', {
    method: 'POST',
    body: JSON.stringify({
      guard_id: idOf('900003'), week_start: OPEN_WEEK,
      target_date: addDays(OPEN_WEEK, 2), shift: 'morning',
    }),
  });

  console.log('\n\x1b[1m2. Submission deadline\x1b[0m');
  await expectAllowed('guard CAN submit while the week is open', a, 'weekly_wish_preferences', {
    method: 'POST',
    body: JSON.stringify({
      guard_id: idOf('900002'), week_start: OPEN_WEEK,
      target_date: addDays(OPEN_WEEK, 3), shift: 'afternoon',
    }),
  });
  await expectDenied('guard CANNOT submit for the locked week', a, 'weekly_wish_preferences', {
    method: 'POST',
    body: JSON.stringify({
      guard_id: idOf('900002'), week_start: LOCKED_WEEK,
      target_date: addDays(LOCKED_WEEK, 1), shift: 'morning',
    }),
  });
  await expectDenied('guard cannot move the deadline to reopen a week', a,
    `roster_weeks?week_start=eq.${LOCKED_WEEK}`, {
      method: 'PATCH',
      body: JSON.stringify({ submission_deadline: '2027-01-01T00:00:00Z' }),
    });

  console.log('\n\x1b[1m3. Privilege escalation\x1b[0m');
  await expectDenied('guard cannot promote themselves to manager', a,
    `profiles?id=eq.${idOf('900002')}`, {
      method: 'PATCH', body: JSON.stringify({ role: 'manager' }),
    });
  await expectDenied('guard cannot deactivate themselves', a,
    `profiles?id=eq.${idOf('900002')}`, {
      method: 'PATCH', body: JSON.stringify({ is_active: false }),
    });
  await expectDenied('guard cannot rewrite their badge code', a,
    `profiles?id=eq.${idOf('900002')}`, {
      method: 'PATCH', body: JSON.stringify({ employee_code: '005396' }),
    });
  await expectAllowed('guard CAN edit their own display name', a,
    `profiles?id=eq.${idOf('900002')}`, {
      method: 'PATCH', body: JSON.stringify({ display_name: 'בדיקה-א2' }),
    });

  console.log('\n\x1b[1m4. Manager-only tables\x1b[0m');
  await expectDenied('guard cannot raise their own כמות', a,
    `weekly_guard_targets?guard_id=eq.${idOf('900002')}`, {
      method: 'PATCH', body: JSON.stringify({ configured_kamut: 5 }),
    });
  await expectRows('guard reads only their own כמות', a,
    `weekly_guard_targets?select=id&week_start=eq.${OPEN_WEEK}&guard_id=eq.${idOf('900003')}`, 0);
  await expectDenied('guard cannot create a roster week', a, 'roster_weeks', {
    method: 'POST',
    body: JSON.stringify({ week_start: '2026-11-15', submission_deadline: '2026-11-11T17:00:00Z' }),
  });

  console.log('\n\x1b[1m5. Badge codes -- manager CRUD, guard sealed out (migration 20)\x1b[0m');
  await expectRows('guard cannot enumerate badge codes', a, 'roster_codes?select=employee_code', 0);
  await expectRows('manager can audit all 10 badge codes', mgr, 'roster_codes?select=employee_code', 10);
  await expectDenied('guard cannot INSERT a badge code (adding an employee is manager-only)', a, 'roster_codes', {
    method: 'POST', body: JSON.stringify({ employee_code: '999999', display_name: 'שתול' }),
  });
  await expectAllowed('manager CAN add a new employee, with a default כמות', mgr, 'roster_codes', {
    method: 'POST',
    body: JSON.stringify({ employee_code: '999999', display_name: 'שתול', default_kamut: 3 }),
  });
  await expectDenied('guard cannot DELETE a badge code', a, 'roster_codes?employee_code=eq.999999', {
    method: 'DELETE',
  });
  await expectAllowed('manager can cancel an unclaimed invitation', mgr, 'roster_codes?employee_code=eq.999999', {
    method: 'DELETE',
  });

  console.log('\n\x1b[1m6. Draft rosters do not leak\x1b[0m');
  await expectRows('guard sees only the published run', a, 'schedule_runs?select=id&version=eq.99', 1);
  await expectRows(
    'manager sees draft + published + archived',
    mgr,
    'schedule_runs?select=id&version=eq.99',
    3,
  );
  await expectRows('guard sees no assignment from a draft run', a,
    'schedule_assignments?select=id&run_id=eq.cccccccc-0000-0000-0000-000000000001', 0);
  await expectDenied('guard cannot assign themselves a shift', a, 'schedule_assignments', {
    method: 'POST',
    body: JSON.stringify({
      run_id: 'cccccccc-0000-0000-0000-000000000002',
      target_date: '2026-08-11', shift: 'morning', guard_id: idOf('900002'),
    }),
  });
  await expectDenied('guard cannot publish a draft', a,
    'schedule_runs?id=eq.cccccccc-0000-0000-0000-000000000001', {
      method: 'PATCH', body: JSON.stringify({ is_published: true }),
    });

  console.log('\n\x1b[1m7. Unauthenticated access (publishable key alone)\x1b[0m');
  for (const t of ['profiles', 'weekly_wish_preferences', 'roster_codes', 'schedule_assignments']) {
    const res = await fetch(`${URL_BASE}/rest/v1/${t}?select=*`, { headers: { apikey: APIKEY } });
    const body = await res.json().catch(() => null);
    const empty = Array.isArray(body) && body.length === 0;
    if (res.status === 401 || res.status === 403 || empty) ok(`anon blocked on ${t}`);
    else bad(`anon blocked on ${t}`, `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 120)}`);
  }

  console.log('\n\x1b[1m8. Manager-only archive (past weeks)\x1b[0m');
  await expectRows(
    'guard cannot see a published roster from a finished week',
    a,
    `schedule_runs?select=id&week_start=eq.${PAST_WEEK}`,
    0,
  );
  // The cut is absolute by decision: a guard sees nothing from a past week,
  // not even a shift they personally worked.
  await expectRows(
    'guard cannot see even their OWN shift in a finished week',
    a,
    'schedule_assignments?select=id&run_id=eq.cccccccc-0000-0000-0000-000000000003',
    0,
  );
  await expectRows(
    'MANAGER can read the archived roster',
    mgr,
    `schedule_runs?select=id&week_start=eq.${PAST_WEEK}`,
    1,
  );
  await expectRows(
    'MANAGER can read archived assignments',
    mgr,
    'schedule_assignments?select=id&run_id=eq.cccccccc-0000-0000-0000-000000000003',
    1,
  );
  await expectRows(
    'guard still sees the current/future published roster',
    a,
    `schedule_runs?select=id&week_start=eq.${LOCKED_WEEK}&version=eq.99`,
    1,
  );

  await teardown();

  console.log(
    `\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
      (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) {
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n\x1b[32mGATE A (cloud) PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try {
    await teardown();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
