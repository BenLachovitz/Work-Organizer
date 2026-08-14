/**
 * GATE G -- push notification storage, targeting, and idempotency (spec 12.10).
 *
 * Deliberately does NOT invoke the real send-notifications Edge Function --
 * that would push real notifications to Ben's phone on every test run.
 * Instead it exercises the SQL primitives the function relies on directly,
 * the same way edit.cloud.test.mjs tests save_run_assignments without going
 * through a UI. The push-send path itself (VAPID signing, actual delivery)
 * needs a manual on-device check -- see BACKLOG.md.
 *
 *   node supabase/tests/notifications.cloud.test.mjs
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

const MGR = '990501'; // manager role, but a real guard too -- see item 2 below
const A = '990502'; // active, submitted
const B = '990503'; // active, not submitted -- SHOULD be reminded
const C = '990504'; // active, not submitted, but is_demo -- excluded
const D = '990505'; // not submitted, but is_active = false -- excluded
const PIN = 'Notif-1234';
const WEEK = '2026-10-11'; // a Sunday clear of every other suite's dedicated week
const WEEK2 = '2026-10-18'; // a second week, for the two-open-weeks robustness test

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
  DELETE FROM roster_weeks WHERE week_start IN ('${WEEK}', '${WEEK2}');
  DELETE FROM auth.users WHERE email LIKE '9905%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9905%';`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
    VALUES ('${WEEK}', 2, NOW() + INTERVAL '10 days', 'open');

    INSERT INTO roster_codes (employee_code, display_name, initial_role, is_demo) VALUES
      ('${MGR}', 'בדיקת-מנהל', 'manager', FALSE),
      ('${A}',   'בדיקת-א',    'guard',   FALSE),
      ('${B}',   'בדיקת-ב',    'guard',   FALSE),
      ('${C}',   'בדיקת-ג',    'guard',   TRUE),
      ('${D}',   'בדיקת-ד',    'guard',   FALSE);

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${MGR}'), ('${A}'), ('${B}'), ('${C}'), ('${D}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active, is_demo)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'בדיקת-מנהל' WHEN '${A}' THEN 'בדיקת-א'
             WHEN '${B}' THEN 'בדיקת-ב' WHEN '${C}' THEN 'בדיקת-ג' ELSE 'בדיקת-ד' END,
           CASE split_part(u.email,'@',1)
             WHEN '${MGR}' THEN 'manager'::user_role ELSE 'guard'::user_role END,
           split_part(u.email,'@',1) <> '${D}',
           split_part(u.email,'@',1) = '${C}'
      FROM auth.users u WHERE u.email LIKE '9905%@guards.local';

    -- A submitted for the test week; B/C/D deliberately did not.
    INSERT INTO weekly_submissions (guard_id, week_start)
    SELECT id, '${WEEK}' FROM profiles WHERE employee_code = '${A}';
  `);
}

async function signedIn(code) {
  const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await db.auth.signInWithPassword({ email: `${code}@guards.local`, password: PIN });
  if (error) throw new Error(`sign-in ${code}: ${error.message}`);
  return db;
}

const idOf = async (code) => {
  const rows = await sql(`SELECT id FROM profiles WHERE employee_code = '${code}'`);
  return rows[0].id;
};

async function run() {
  await setup();

  const a = await signedIn(A);
  const b = await signedIn(B);
  const mgr = await signedIn(MGR);
  const aId = await idOf(A);
  const bId = await idOf(B);

  console.log('\n\x1b[1m1. RLS on push_subscriptions\x1b[0m');
  {
    const { error } = await a.from('push_subscriptions').upsert(
      { guard_id: aId, endpoint: 'https://example.com/ep-a', p256dh: 'x', auth: 'y' },
      { onConflict: 'endpoint' },
    );
    error ? bad('guard subscribes for themselves', error.message) : ok('guard subscribes for themselves');
  }
  {
    const { error } = await a.from('push_subscriptions').upsert(
      { guard_id: bId, endpoint: 'https://example.com/ep-forged', p256dh: 'x', auth: 'y' },
      { onConflict: 'endpoint' },
    );
    error ? ok('guard cannot subscribe on another guard\'s behalf') : bad('forged subscription', 'succeeded');
  }
  {
    const { data, error } = await b.from('push_subscriptions').select('*').eq('guard_id', aId);
    !error && data.length === 0
      ? ok('a guard cannot read another guard\'s subscription')
      : bad('cross-guard read', JSON.stringify({ data, error }));
  }
  {
    const { data, error } = await mgr.from('push_subscriptions').select('*').eq('guard_id', aId);
    !error && data.length === 1
      ? ok('manager can read a guard\'s subscription')
      : bad('manager read', JSON.stringify({ data, error }));
  }

  console.log('\n\x1b[1m2. unsubmitted_targets() -- no role filter (the bug this suite guards against)\x1b[0m');
  {
    const rows = await sql(`SELECT p.employee_code FROM public.unsubmitted_targets('${WEEK}') t JOIN profiles p ON p.id = t.guard_id WHERE p.employee_code LIKE '9905%' ORDER BY p.employee_code`);
    const codes = rows.map((r) => r.employee_code).sort();
    JSON.stringify(codes) === JSON.stringify([B, MGR].sort())
      ? ok(`unsubmitted_targets returns exactly {B, MGR} -- A submitted, C is demo, D is inactive, and MGR is correctly included despite role='manager' (${codes.join(',')})`)
      : bad('unsubmitted_targets', JSON.stringify(codes));
  }

  console.log('\n\x1b[1m3. broadcast_targets() -- ignores submission status entirely\x1b[0m');
  {
    const rows = await sql(`SELECT p.employee_code FROM public.broadcast_targets() t JOIN profiles p ON p.id = t.guard_id WHERE p.employee_code LIKE '9905%' ORDER BY p.employee_code`);
    const codes = rows.map((r) => r.employee_code).sort();
    JSON.stringify(codes) === JSON.stringify([A, B, MGR].sort())
      ? ok(`broadcast_targets returns {A, B, MGR} regardless of submission status (${codes.join(',')})`)
      : bad('broadcast_targets', JSON.stringify(codes));
  }

  console.log('\n\x1b[1m4. reminder_due() tolerance window\x1b[0m');
  {
    const rows = await sql(`SELECT public.reminder_due(NOW() + INTERVAL '24 hours' - INTERVAL '5 minutes', INTERVAL '24 hours') AS r`);
    rows[0].r === true ? ok('inside the +-20 minute window is due') : bad('inside window', JSON.stringify(rows));
  }
  {
    const rows = await sql(`SELECT public.reminder_due(NOW() + INTERVAL '24 hours' - INTERVAL '40 minutes', INTERVAL '24 hours') AS r`);
    rows[0].r === false ? ok('outside the window is not due') : bad('outside window', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m5. claim_notification_send() idempotency\x1b[0m');
  {
    const first = await sql(`SELECT public.claim_notification_send('reminder_24h', '${WEEK}', '${bId}'::uuid, NOW()) AS id`);
    const second = await sql(`SELECT public.claim_notification_send('reminder_24h', '${WEEK}', '${bId}'::uuid, NOW()) AS id`);
    first[0].id !== null && second[0].id === null
      ? ok('a repeat claim for the same (type, week, guard) is refused')
      : bad('idempotency', JSON.stringify({ first, second }));
  }
  {
    const other = await sql(`SELECT public.claim_notification_send('reminder_24h', '${WEEK}', '${aId}'::uuid, NOW()) AS id`);
    other[0].id !== null
      ? ok('a different guard can still claim the same (type, week) -- not globally blocked')
      : bad('scoped idempotency', JSON.stringify(other));
  }

  console.log('\n\x1b[1m6. Open-week lookup survives more than one open week\x1b[0m');
  {
    // Simulates a manager's manual status override leaving two weeks open at
    // once -- "exactly one open week" is a design intent, not a DB-enforced
    // invariant. send-notifications must pick the soonest-closing one, not error.
    await sql(`
      INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
      VALUES ('${WEEK2}', 2, NOW() + INTERVAL '17 days', 'open');`);
    const rows = await sql(`SELECT week_start::text FROM roster_weeks WHERE status = 'open' AND week_start IN ('${WEEK}', '${WEEK2}') ORDER BY week_start ASC LIMIT 1`);
    rows.length === 1 && rows[0].week_start === WEEK
      ? ok('with two weeks open, the earliest (soonest-closing) one is picked, not an error')
      : bad('two open weeks', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m7. roster_published (migration 43) -- is_week_published() + narrowed idempotency\x1b[0m');
  const RUN = 'ffffffff-0000-0000-0000-000000000001';
  {
    await sql(`INSERT INTO schedule_runs (id, week_start, version, solver_status, is_published)
               VALUES ('${RUN}', '${WEEK}', 1, 'OPTIMAL', TRUE);`);
    const rows = await sql(`SELECT public.is_week_published('${WEEK}') AS p, public.is_week_published('${WEEK2}') AS p2`);
    rows[0].p === true && rows[0].p2 === false
      ? ok('is_week_published() is true only for a week with a published run')
      : bad('is_week_published', JSON.stringify(rows));
  }
  {
    // roster_published is deliberately excluded from the once-ever dedup: two
    // 'sent' rows for the same (type, week, guard) must both be allowed.
    await sql(`INSERT INTO notification_log (notification_type, week_start, guard_id, status, sent_at)
               VALUES ('roster_published', '${WEEK}', '${bId}', 'sent', NOW());`);
    let secondFailed = false;
    try {
      await sql(`INSERT INTO notification_log (notification_type, week_start, guard_id, status, sent_at)
                 VALUES ('roster_published', '${WEEK}', '${bId}', 'sent', NOW());`);
    } catch { secondFailed = true; }
    !secondFailed
      ? ok('a second roster_published sent row for the same (week, guard) is allowed')
      : bad('roster_published repeat send', 'second insert was unexpectedly rejected');
  }
  {
    // Regression guard: the three original types keep their strict once-ever
    // guarantee -- this is the property migration 43 must NOT loosen.
    await sql(`INSERT INTO notification_log (notification_type, week_start, guard_id, status, sent_at)
               VALUES ('broadcast', '${WEEK}', '${bId}', 'sent', NOW());`);
    let secondFailed = false;
    try {
      await sql(`INSERT INTO notification_log (notification_type, week_start, guard_id, status, sent_at)
                 VALUES ('broadcast', '${WEEK}', '${bId}', 'sent', NOW());`);
    } catch { secondFailed = true; }
    secondFailed
      ? ok('broadcast still allows only one sent row per (week, guard), unchanged')
      : bad('broadcast dedup regression', 'second insert unexpectedly succeeded');
  }

  console.log('\n\x1b[1m8. send-notifications auth for roster_published -- safe paths only\x1b[0m');
  // Deliberately limited to paths that 403/400 before any targeting or send
  // happens (same reasoning as the file header: a "success" call here would
  // loop over broadcast_targets() -- every real active guard, including
  // Ben's own phone -- on every test run). The actual on-device delivery for
  // roster_published needs the same manual confirmation Step T's three
  // original types already got -- see BACKLOG.md.
  const FN_URL = `${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/send-notifications`;
  {
    const res = await fetch(FN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'roster_published', week_start: WEEK }),
    });
    res.status === 403 ? ok('no auth at all is rejected (403)') : bad('no auth', `status ${res.status}`);
  }
  {
    const { data: sess } = await b.auth.getSession();
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.session.access_token}` },
      body: JSON.stringify({ type: 'roster_published', week_start: WEEK }),
    });
    res.status === 403 ? ok('a non-manager guard JWT is rejected (403)') : bad('guard JWT', `status ${res.status}`);
  }
  {
    // A manager JWT must not unlock a CRON-ONLY type -- roster_published is
    // the only type a browser session may ever trigger.
    const { data: sess } = await mgr.auth.getSession();
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.session.access_token}` },
      body: JSON.stringify({ type: 'broadcast' }),
    });
    res.status === 403 ? ok('a manager JWT cannot trigger a cron-only type (403)') : bad('manager JWT on cron type', `status ${res.status}`);
  }
  {
    // A manager JWT for roster_published on a week with NO published run --
    // rejected by is_week_published() before any targeting/send happens.
    const { data: sess } = await mgr.auth.getSession();
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.session.access_token}` },
      body: JSON.stringify({ type: 'roster_published', week_start: WEEK2 }),
    });
    res.status === 400 ? ok('an unpublished week is rejected (400), before any send') : bad('unpublished week', `status ${res.status}`);
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) {
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n\x1b[32mGATE G PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
