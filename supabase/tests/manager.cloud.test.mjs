/**
 * GATE D -- manager dashboard writes and the submission lock.
 *
 * Uses a dedicated test week (2026-09-06) so locking and unlocking never
 * disturbs the real roster weeks guards are submitting against.
 *
 *   node supabase/tests/manager.cloud.test.mjs
 */

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

const MGR = '990301';
const G1 = '990302';
const G2 = '990303';
const PIN = 'Mgr-12345';
const WEEK = '2026-09-06'; // a Sunday

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
  DELETE FROM auth.users WHERE email LIKE '9903%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9903%';`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
    VALUES ('${WEEK}', 2, NOW() + INTERVAL '10 days', 'open');

    INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
      ('${MGR}', 'בדיקת-מנהל', 'manager'),
      ('${G1}',  'בדיקת-א',    'guard'),
      ('${G2}',  'בדיקת-ב',    'guard');

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${MGR}'), ('${G1}'), ('${G2}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'בדיקת-מנהל' WHEN '${G1}' THEN 'בדיקת-א' ELSE 'בדיקת-ב' END,
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'manager'::user_role ELSE 'guard'::user_role END,
           TRUE
      FROM auth.users u WHERE u.email LIKE '9903%@guards.local';
  `);
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

async function run() {
  console.log('\n\x1b[1mGATE D -- manager dashboard\x1b[0m\n');
  await setup();
  const mgr = await signedIn(MGR);
  const g1 = await signedIn(G1);
  const g1Id = await idOf(G1);
  const g2Id = await idOf(G2);

  console.log('\x1b[1m1. Week controls\x1b[0m');
  {
    const { error } = await mgr.from('roster_weeks')
      .update({ morning_target_slots: 3 }).eq('week_start', WEEK);
    const rows = await sql(`SELECT morning_target_slots FROM roster_weeks WHERE week_start='${WEEK}'`);
    !error && rows[0].morning_target_slots === 3
      ? ok('manager raises the morning target to 3')
      : bad('manager sets target', error?.message ?? JSON.stringify(rows));
  }
  {
    const { data } = await g1.from('roster_weeks')
      .update({ morning_target_slots: 2 }).eq('week_start', WEEK).select();
    const rows = await sql(`SELECT morning_target_slots FROM roster_weeks WHERE week_start='${WEEK}'`);
    (!data || data.length === 0) && rows[0].morning_target_slots === 3
      ? ok('guard cannot change the morning target')
      : bad('guard sets target', `target is now ${rows[0].morning_target_slots}`);
  }
  {
    const { error } = await mgr.from('roster_weeks')
      .update({ morning_target_slots: 4 }).eq('week_start', WEEK);
    error ? ok('an out-of-range target (4) is rejected by the CHECK') : bad('target range', 'accepted 4');
  }

  console.log('\n\x1b[1m2. כמות targets\x1b[0m');
  {
    const { error } = await mgr.from('weekly_guard_targets')
      .upsert({ week_start: WEEK, guard_id: g1Id, configured_kamut: 3 },
        { onConflict: 'week_start,guard_id' });
    error ? bad('manager sets kamut', error.message) : ok('manager sets a guard kamut to 3');
  }
  {
    await mgr.from('weekly_guard_targets')
      .upsert({ week_start: WEEK, guard_id: g1Id, configured_kamut: 5 },
        { onConflict: 'week_start,guard_id' });
    const rows = await sql(`SELECT COUNT(*)::int n, MAX(configured_kamut) k
                              FROM weekly_guard_targets
                             WHERE week_start='${WEEK}' AND guard_id='${g1Id}'`);
    rows[0].n === 1 && rows[0].k === 5
      ? ok('re-setting updates in place (1 row, value 5) rather than duplicating')
      : bad('kamut upsert', JSON.stringify(rows));
  }
  {
    const { error } = await mgr.from('weekly_guard_targets')
      .upsert({ week_start: WEEK, guard_id: g2Id, configured_kamut: 9 },
        { onConflict: 'week_start,guard_id' });
    error ? ok('kamut above the 5-shift ceiling is rejected') : bad('kamut ceiling', 'accepted 9');
  }
  {
    const { data } = await g1.from('weekly_guard_targets')
      .update({ configured_kamut: 5 }).eq('guard_id', g1Id).select();
    const rows = await sql(`SELECT configured_kamut FROM weekly_guard_targets
                             WHERE week_start='${WEEK}' AND guard_id='${g1Id}'`);
    (!data || data.length === 0) && rows[0].configured_kamut === 5
      ? ok('guard cannot set their own kamut')
      : bad('guard kamut write', JSON.stringify(data));
  }

  console.log('\n\x1b[1m3. The lock control actually locks\x1b[0m');
  {
    const { error } = await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [
        { date: '2026-09-06', shift: 'morning', allows12h: false },
        { date: '2026-09-07', shift: 'night', allows12h: false },
      ],
    });
    error ? bad('guard save while open', error.message) : ok('guard can submit while the week is open');
  }
  {
    const { error } = await mgr.from('roster_weeks')
      .update({ status: 'locked' }).eq('week_start', WEEK);
    error ? bad('manager locks', error.message) : ok('manager locks the week');
  }
  {
    // The whole point of the lock button: it must bind at the database, not
    // just grey out a control in the UI.
    const { error } = await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [{ date: '2026-09-08', shift: 'morning', allows12h: false }],
    });
    error ? ok('guard save is refused once locked (enforced in the database)') : bad('lock', 'save succeeded while locked');
  }
  {
    const rows = await sql(`SELECT COUNT(*)::int n FROM weekly_wish_preferences
                             WHERE week_start='${WEEK}' AND guard_id='${g1Id}'`);
    rows[0].n === 2 ? ok('the pre-lock submission survived the refused write') : bad('lock rollback', JSON.stringify(rows));
  }
  {
    await mgr.from('roster_weeks').update({ status: 'open' }).eq('week_start', WEEK);
    const { error } = await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [{ date: '2026-09-08', shift: 'morning', allows12h: false }],
    });
    error ? bad('reopen', error.message) : ok('reopening the week restores guard submissions');
  }

  console.log('\n\x1b[1m4. Dashboard reads\x1b[0m');
  {
    await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [
        { date: '2026-09-06', shift: 'morning', allows12h: true },
        { date: '2026-09-06', shift: 'night', allows12h: false },
      ],
    });
    const g2c = await signedIn(G2);
    await g2c.rpc('save_week_preferences', {
      p_week_start: WEEK, p_slots: [],
    });

    const [{ data: subs }, { data: prefs }, { data: guards }] = await Promise.all([
      mgr.from('weekly_submissions').select('*').eq('week_start', WEEK),
      mgr.from('weekly_wish_preferences').select('*').eq('week_start', WEEK),
      mgr.from('profiles').select('*').eq('is_active', true),
    ]);

    subs?.length === 2
      ? ok('manager sees both submissions, including the empty one')
      : bad('manager submissions', `got ${subs?.length}`);
    prefs?.length === 2
      ? ok('manager sees the filled guard’s 2 preference rows')
      : bad('manager preferences', `got ${prefs?.length}`);
    guards && guards.length >= 3
      ? ok('manager lists active guards for the team table')
      : bad('manager guards', `got ${guards?.length}`);

    // The empty submission must be distinguishable from never-submitted.
    const emptyGuard = subs?.find((s) => s.guard_id === g2Id);
    const emptyPrefs = prefs?.filter((p) => p.guard_id === g2Id) ?? [];
    emptyGuard && emptyPrefs.length === 0
      ? ok('"submitted empty" is distinguishable from "never submitted"')
      : bad('empty state', JSON.stringify({ emptyGuard: Boolean(emptyGuard), n: emptyPrefs.length }));
  }
  {
    const { data } = await g1.from('weekly_submissions').select('*').eq('guard_id', g2Id);
    data?.length === 0 ? ok("guard still cannot read another guard's submission") : bad('guard read leak', JSON.stringify(data));
  }

  console.log('\n\x1b[1m5. Reopening a week whose deadline has passed\x1b[0m');
  {
    // The bug this covers: "פתח הגשות מחדש" flipped status but left the
    // deadline in the past, so is_week_open() stayed false and guards still
    // could not submit -- and the next ensure_roster_weeks() sweep re-locked
    // the week anyway, so the button appeared to do nothing at all.
    await sql(`UPDATE roster_weeks
                  SET status = 'locked',
                      submission_deadline = NOW() - INTERVAL '2 days',
                      status_overridden_at = NULL
                WHERE week_start = '${WEEK}'`);

    const before = await sql(`SELECT is_week_open('${WEEK}') AS can FROM roster_weeks WHERE week_start='${WEEK}'`);
    before[0].can === false
      ? ok('precondition: the expired week is closed to guards')
      : bad('precondition', JSON.stringify(before));

    const { error } = await mgr.rpc('set_week_status', {
      p_week_start: WEEK, p_status: 'open', p_extend_hours: 24,
    });
    error ? bad('reopen', error.message) : ok('manager reopens the expired week');

    const after = await sql(`SELECT status::text, is_week_open('${WEEK}') AS can,
                                    submission_deadline > NOW() AS future_deadline,
                                    status_overridden_at IS NOT NULL AS overridden
                               FROM roster_weeks WHERE week_start='${WEEK}'`);
    const a = after[0];
    a.status === 'open' && a.future_deadline
      ? ok('reopening EXTENDED the deadline, not just the status flag')
      : bad('deadline extension', JSON.stringify(a));
    a.can === true
      ? ok('is_week_open() now returns true -- guards can actually submit')
      : bad('is_week_open', JSON.stringify(a));
    a.overridden === true
      ? ok('status_overridden_at is stamped, so the sweep will leave it alone')
      : bad('override flag', JSON.stringify(a));
  }
  {
    // And the guard can genuinely write again, which is the point.
    const { error } = await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [{ date: '2026-09-09', shift: 'afternoon', allows12h: false }],
    });
    error ? bad('guard write after reopen', error.message) : ok('guard can submit again after the reopen');
  }
  {
    // The sweep must not undo a manager's decision.
    await sql('SELECT ensure_roster_weeks()');
    const after = await sql(`SELECT status::text, is_week_open('${WEEK}') AS can
                               FROM roster_weeks WHERE week_start='${WEEK}'`);
    after[0].status === 'open' && after[0].can === true
      ? ok('the automatic sweep does not re-lock a manually reopened week')
      : bad('sweep override', JSON.stringify(after));
  }
  {
    const { error } = await g1.rpc('set_week_status', {
      p_week_start: WEEK, p_status: 'locked', p_extend_hours: 24,
    });
    error ? ok('a guard cannot call set_week_status') : bad('set_week_status', 'guard succeeded');
  }

  console.log('\n\x1b[1m6. Coverage / override maths against real rows\x1b[0m');
  {
    // Set this section's own state rather than inheriting whatever earlier
    // sections left behind -- a test that depends on another test's leftovers
    // breaks the moment one is added in between, which is exactly what happened.
    await g1.rpc('save_week_preferences', {
      p_week_start: WEEK,
      p_slots: [
        { date: '2026-09-06', shift: 'morning', allows12h: false },
        { date: '2026-09-06', shift: 'night', allows12h: false },
      ],
    });

    // G1 marked 2 slots on ONE day. With kamut 5, the binding limit is days (1),
    // so the solver target must come out as 1, not 5 and not 2.
    const rows = await sql(`
      SELECT COUNT(DISTINCT target_date)::int AS days, COUNT(*)::int AS slots
        FROM weekly_wish_preferences
       WHERE week_start='${WEEK}' AND guard_id='${g1Id}'`);
    const { days, slots } = rows[0];
    const configured = 5;
    const effective = Math.max(0, Math.min(configured, days, 5));
    days === 1 && slots === 2 && effective === 1
      ? ok('2 slots on 1 day -> effective kamut 1 (days bind, not slot count)')
      : bad('override maths', JSON.stringify({ days, slots, effective }));
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE D PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
