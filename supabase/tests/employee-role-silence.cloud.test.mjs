/**
 * GATE J -- employee role control (migration 71), the protected-account flag
 * (migration 71), and the silenced-guard flag (migration 72).
 *
 * Deliberately a NEW, standalone file rather than an extension of Gate D
 * (manager.cloud.test.mjs) or the notifications suite: both of those files'
 * own fixture weeks (2026-09-06/2026-07-19 and 2026-10-11) are, as of this
 * writing, REAL, PUBLISHED weeks with real guard data -- confirmed via
 * `npm run db:apply`'s roster-weeks listing before writing this file, per
 * this project's standing "no separate test database" caution. Running
 * either of those files' setup()/cleanup() right now would delete real,
 * live roster data (this already happened once for real, see docs/BACKLOG.md
 * Step AE). This file never touches roster_weeks at a date any other suite
 * uses, and its own WEEK constant below is chosen far enough in the future
 * that no `ensure_roster_weeks()` call could ever have created a real row
 * there.
 *
 * Deliberately NOT exercised here: the "cannot demote the last remaining
 * manager" failure path. set_employee_role()'s lockout count
 * (`profiles WHERE role IN ('manager','admin') AND id <> p_profile_id`) is
 * GLOBAL, not scoped to this file's test accounts -- the real production
 * project always has at least one real manager, so a test-account demotion
 * can never actually be the one that empties the count. Forcing that branch
 * for real would require temporarily changing a REAL manager's role, which
 * this suite will never do. The success path (demoting a test manager WHILE
 * other managers exist, which is always true in production) is exercised
 * instead, proving the demote path itself works; the lockout branch is
 * covered by code review, not live execution, same deliberate-scope
 * precedent as Gate G never invoking send-notifications for a real push.
 *
 *   node supabase/tests/employee-role-silence.cloud.test.mjs
 */

import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];

const MGR = '990601'; // test manager -- demoted during the run
const G1 = '990602'; // test guard -- promoted during the run
const PROT = '990603'; // test MANAGER -- flagged is_protected directly via SQL
const SIL = '990604'; // test guard -- flagged is_silenced during the run
// Random per run: this repo is public, so a fixed PIN here would be a working
// credential for any test account a crashed run failed to clean up.
const PIN = 'T-' + randomBytes(12).toString('hex');
// A Sunday (roster_weeks.week_start requires DOW = 0) far beyond any week
// ensure_roster_weeks() could ever have created relative to when this file
// is run -- never reused by any other suite.
const WEEK = '2031-06-01';

let passed = 0;
const failures = [];
const ok = (l) => { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${l}`); };
const bad = (l, d) => { failures.push(`${l} -- ${d}`); console.log(`  \x1b[31mFAIL\x1b[0m  ${l}\n        ${d}`); };

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? res.status);
  return body;
}

const cleanup = () => sql(`
  DELETE FROM roster_weeks WHERE week_start = '${WEEK}';
  DELETE FROM auth.users WHERE email LIKE '9906%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9906%';`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
      ('${MGR}',  'בדיקת-מנהל-תפקיד', 'manager'),
      ('${G1}',   'בדיקת-עובד-תפקיד', 'guard'),
      ('${PROT}', 'בדיקת-מוגן',        'manager'),
      ('${SIL}',  'בדיקת-השתקה',       'guard');

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${MGR}'), ('${G1}'), ('${PROT}'), ('${SIL}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'בדיקת-מנהל-תפקיד'
             WHEN '${G1}' THEN 'בדיקת-עובד-תפקיד'
             WHEN '${PROT}' THEN 'בדיקת-מוגן'
             ELSE 'בדיקת-השתקה' END,
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'manager'::user_role
             WHEN '${PROT}' THEN 'manager'::user_role
             ELSE 'guard'::user_role END,
           TRUE
      FROM auth.users u WHERE u.email LIKE '9906%@guards.local';

    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
    VALUES ('${WEEK}', 2, NOW() + INTERVAL '10 days', 'open');

    UPDATE profiles SET is_protected = TRUE WHERE employee_code = '${PROT}';`);
}

async function signedIn(code) {
  const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await db.auth.signInWithPassword({
    email: `${code}@guards.local`, password: PIN,
  });
  if (error) throw new Error(`sign-in ${code}: ${error.message}`);
  return db;
}

const idOf = async (code) =>
  (await sql(`SELECT id FROM profiles WHERE employee_code = '${code}'`))[0].id;

const roleOf = async (id) =>
  (await sql(`SELECT role FROM profiles WHERE id = '${id}'`))[0].role;

async function run() {
  console.log('\n\x1b[1mGATE J -- employee role control, protected + silenced flags\x1b[0m\n');
  await setup();
  const mgr = await signedIn(MGR);
  const g1 = await signedIn(G1);
  const prot = await signedIn(PROT);
  const sil = await signedIn(SIL);
  const mgrId = await idOf(MGR);
  const g1Id = await idOf(G1);
  const protId = await idOf(PROT);
  const silId = await idOf(SIL);

  console.log('\x1b[1m1. set_employee_role -- promote / demote\x1b[0m');
  {
    const { error } = await mgr.rpc('set_employee_role', { p_profile_id: g1Id, p_role: 'manager' });
    !error && (await roleOf(g1Id)) === 'manager'
      ? ok('a manager promotes a guard to manager')
      : bad('promote', error?.message ?? 'role unchanged');
  }
  {
    const { error } = await mgr.rpc('set_employee_role', { p_profile_id: g1Id, p_role: 'guard' });
    !error && (await roleOf(g1Id)) === 'guard'
      ? ok('a manager demotes a manager back to guard (other managers still exist)')
      : bad('demote', error?.message ?? 'role unchanged');
  }
  {
    const { error } = await g1.rpc('set_employee_role', { p_profile_id: mgrId, p_role: 'guard' });
    error?.message?.includes('managers only')
      ? ok('a guard calling set_employee_role is rejected')
      : bad('guard calls set_employee_role', error?.message ?? 'was not rejected');
  }
  {
    const { error } = await mgr.rpc('set_employee_role', { p_profile_id: mgrId, p_role: 'guard' });
    !error && (await roleOf(mgrId)) === 'guard'
      ? ok('a manager demotes THEMSELVES while another manager still exists')
      : bad('self-demote', error?.message ?? 'role unchanged');
    // Restore for the rest of the run / cleanup symmetry.
    await sql(`UPDATE profiles SET role = 'manager' WHERE id = '${mgrId}'`);
  }

  console.log('\n\x1b[1m2. is_protected -- role is unchangeable, by anyone\x1b[0m');
  {
    const { error } = await mgr.rpc('set_employee_role', { p_profile_id: protId, p_role: 'manager' });
    error?.message?.includes('protected')
      ? ok('another manager cannot change a protected account\'s role')
      : bad('protected role change by another manager', error?.message ?? 'was not rejected');
  }
  {
    const { error } = await prot.rpc('set_employee_role', { p_profile_id: protId, p_role: 'manager' });
    error?.message?.includes('protected')
      ? ok('a protected account cannot change its own role either')
      : bad('protected self role change', error?.message ?? 'was not rejected');
  }
  {
    const { error } = await mgr.from('profiles').update({ is_silenced: true }).eq('id', protId);
    const row = (await sql(`SELECT is_silenced FROM profiles WHERE id = '${protId}'`))[0];
    !error && row.is_silenced === true
      ? ok('protection blocks role changes only -- the silence toggle still works on a protected row')
      : bad('silence a protected row', error?.message ?? JSON.stringify(row));
    await sql(`UPDATE profiles SET is_silenced = FALSE WHERE id = '${protId}'`);
  }
  {
    // RLS's profiles_self_update has no column restriction (it's row-scoped
    // only) -- guard_profile_columns() (migration 71/74) is what actually
    // blocks this, the same trigger mechanism as is_silenced below.
    const { error } = await g1.from('profiles').update({ is_protected: true }).eq('id', g1Id);
    const row = (await sql(`SELECT is_protected FROM profiles WHERE id = '${g1Id}'`))[0];
    error?.message?.includes('profiles.is_protected') && row.is_protected === false
      ? ok('a guard cannot grant themselves is_protected (trigger blocks the column)')
      : bad('guard sets is_protected on self', error?.message ?? `is_protected=${row.is_protected}`);
  }

  console.log('\n\x1b[1m3. is_silenced -- who may write it\x1b[0m');
  {
    const { error } = await mgr.from('profiles').update({ is_silenced: true }).eq('id', silId);
    const row = (await sql(`SELECT is_silenced FROM profiles WHERE id = '${silId}'`))[0];
    !error && row.is_silenced === true
      ? ok('a manager silences another guard')
      : bad('manager silences guard', error?.message ?? JSON.stringify(row));
  }
  {
    const { error } = await sil.from('profiles').update({ is_silenced: false }).eq('id', silId);
    error?.message?.includes('profiles.is_silenced')
      ? ok('a guard cannot un-silence themselves (trigger blocks the column)')
      : bad('guard self-writes is_silenced', error?.message ?? 'was not rejected');
  }

  console.log('\n\x1b[1m4. Notification targeting excludes a silenced guard\x1b[0m');
  {
    const rows = await sql(`SELECT * FROM unsubmitted_targets('${WEEK}') WHERE guard_id = '${silId}'`);
    rows.length === 0
      ? ok('a silenced guard is excluded from unsubmitted_targets()')
      : bad('unsubmitted_targets excludes silenced', 'silenced guard was still targeted');
  }
  {
    const rows = await sql(`SELECT * FROM broadcast_targets() WHERE guard_id = '${silId}'`);
    rows.length === 0
      ? ok('a silenced guard is excluded from broadcast_targets()')
      : bad('broadcast_targets excludes silenced', 'silenced guard was still targeted');
  }
  {
    // A silenced guard who is ALSO a manager stays in manager_targets() --
    // role-driven, orthogonal to silencing (migration 72 never touches it).
    await sql(`UPDATE profiles SET role = 'manager' WHERE id = '${silId}'`);
    const rows = await sql(`SELECT * FROM manager_targets() WHERE guard_id = '${silId}'`);
    rows.length === 1
      ? ok('a silenced guard who is also a manager still appears in manager_targets()')
      : bad('manager_targets includes silenced manager', JSON.stringify(rows));
    await sql(`UPDATE profiles SET role = 'guard' WHERE id = '${silId}'`);
  }
  {
    const rows = await sql(`SELECT * FROM unsubmitted_targets('${WEEK}') WHERE guard_id = '${g1Id}'`);
    rows.length === 1
      ? ok('an ordinary, non-silenced guard is still targeted (sanity check against false positives)')
      : bad('unsubmitted_targets sanity check', 'an unsilenced guard was not targeted');
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE J PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
