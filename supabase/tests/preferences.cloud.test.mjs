/**
 * GATE C -- preference persistence, through the same supabase-js path the
 * browser uses.
 *
 * The test that matters most here is atomicity. Saving a week is a DELETE plus
 * an INSERT; if the insert fails after the delete commits, a guard's filled-in
 * week silently becomes "unavailable all week" and they get no shifts. That is
 * the worst failure this app can have, so it is asserted directly.
 *
 *   node supabase/tests/preferences.cloud.test.mjs
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

const CODE = '990201';
const CODE2 = '990202';
const PIN = 'Pref-1234';
// Weeks this suite OWNS, so no assertion depends on today's date.
const OPEN_WEEK = '2026-10-18';
const LOCKED_WEEK = '2026-10-25';

/** week_start + n days, as YYYY-MM-DD. */
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};


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
  DELETE FROM auth.users WHERE email LIKE '9902%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9902%';
  DELETE FROM roster_weeks WHERE week_start IN ('${OPEN_WEEK}', '${LOCKED_WEEK}');`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status) VALUES
      ('${OPEN_WEEK}'::date,   2, NOW() + INTERVAL '30 days', 'open'),
      ('${LOCKED_WEEK}'::date, 2, NOW() - INTERVAL '2 days',  'locked')
    ON CONFLICT (week_start) DO NOTHING;

    INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
      ('${CODE}',  'בדיקת-העדפות', 'guard'),
      ('${CODE2}', 'בדיקת-שכן',    'guard');

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${CODE}'), ('${CODE2}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1) WHEN '${CODE}' THEN 'בדיקת-העדפות' ELSE 'בדיקת-שכן' END,
           'guard'::user_role, TRUE
      FROM auth.users u WHERE u.email LIKE '9902%@guards.local';

    UPDATE roster_codes SET is_claimed = TRUE WHERE employee_code LIKE '9902%';

    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
    SELECT '${OPEN_WEEK}'::date, id, 3 FROM profiles WHERE employee_code = '${CODE}';
  `);
}

function client() {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signedIn(code) {
  const db = client();
  const { error } = await db.auth.signInWithPassword({
    email: `${code}@guards.local`, password: PIN,
  });
  if (error) throw new Error(`sign-in ${code}: ${error.message}`);
  return db;
}

const savePrefs = (db, week, slots, notes, requestedShifts) =>
  db.rpc('save_week_preferences', {
    p_week_start: week,
    p_slots: slots,
    p_notes: notes ?? null,
    p_requested_shifts: requestedShifts ?? null,
  });

const readNotes = async (db, week) => {
  const { data } = await db.from('weekly_submissions').select('notes').eq('week_start', week).maybeSingle();
  return data?.notes ?? null;
};

const readRequestedShifts = async (db, week) => {
  const { data } = await db
    .from('weekly_submissions')
    .select('requested_shifts')
    .eq('week_start', week)
    .maybeSingle();
  return data?.requested_shifts ?? null;
};

const readPrefs = async (db, week) => {
  const { data } = await db
    .from('weekly_wish_preferences')
    .select('target_date,shift,allows_12h')
    .eq('week_start', week)
    .order('target_date');
  return data ?? [];
};

async function run() {
  console.log('\n\x1b[1mGATE C -- preference persistence\x1b[0m\n');
  await setup();
  const guard = await signedIn(CODE);

  console.log('\x1b[1m1. Save and reload\x1b[0m');
  {
    const { error } = await savePrefs(guard, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 0), shift: 'morning', allows12h: true },
      { date: addDays(OPEN_WEEK, 1), shift: 'night', allows12h: false },
      { date: addDays(OPEN_WEEK, 3), shift: 'afternoon', allows12h: false },
    ]);
    error ? bad('save 3 slots', error.message) : ok('save 3 slots succeeds');
  }
  {
    const rows = await readPrefs(guard, OPEN_WEEK);
    rows.length === 3 && rows[0].shift === 'morning' && rows[1].shift === 'night'
      ? ok('all 3 slots persisted with correct dates and shifts')
      : bad('reload', JSON.stringify(rows));
  }
  {
    // The 12h opt-in is per slot now, so it has to land on the right row and
    // only that row.
    const rows = await readPrefs(guard, OPEN_WEEK);
    const morning = rows.find((r) => r.shift === 'morning');
    const night = rows.find((r) => r.shift === 'night');
    morning?.allows_12h === true && night?.allows_12h === false
      ? ok('12h opt-in persisted on the specific slot, not the whole week')
      : bad('per-slot 12h', JSON.stringify(rows));
  }
  {
    // An afternoon shift cannot extend; the flag must be dropped, not stored.
    await savePrefs(guard, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 0), shift: 'afternoon', allows12h: true },
    ]);
    const rows = await readPrefs(guard, OPEN_WEEK);
    rows.length === 1 && rows[0].allows_12h === false
      ? ok('12h flag on an afternoon slot is discarded rather than rejected')
      : bad('afternoon 12h', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m2. Re-saving replaces rather than appends\x1b[0m');
  {
    await savePrefs(guard, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 4), shift: 'morning', allows12h: false },
    ]);
    const rows = await readPrefs(guard, OPEN_WEEK);
    rows.length === 1 && rows[0].target_date === addDays(OPEN_WEEK, 4)
      ? ok('second save replaces the previous set (1 row, not 4)')
      : bad('replace semantics', JSON.stringify(rows));
  }
  {
    // Clearing the 12h flag must actually clear it, not leave a stale true.
    const rows = await readPrefs(guard, OPEN_WEEK);
    rows[0]?.allows_12h === false
      ? ok('12h opt-in cleared on re-save rather than persisting')
      : bad('12h clear', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m3. Atomicity -- a failed save must not wipe the week\x1b[0m');
  {
    // A date outside the week trips the date_within_week CHECK during INSERT,
    // AFTER the DELETE has already run inside the transaction. If the function
    // were not atomic, the guard's week would now be empty.
    const { error } = await savePrefs(guard, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 5), shift: 'morning', allows12h: false },
      { date: '2026-12-25', shift: 'night', allows12h: false }, // outside the week
    ]);
    if (!error) bad('atomicity', 'invalid slot was accepted');
    else {
      const rows = await readPrefs(guard, OPEN_WEEK);
      rows.length === 1 && rows[0].target_date === addDays(OPEN_WEEK, 4)
        ? ok('failed save rolled back; previous week intact (not wiped)')
        : bad('atomicity', `week left as ${JSON.stringify(rows)}`);
    }
  }

  console.log('\n\x1b[1m4. Empty submission is a real state\x1b[0m');
  {
    const { error } = await savePrefs(guard, OPEN_WEEK, []);
    if (error) bad('empty submission', error.message);
    else {
      const rows = await readPrefs(guard, OPEN_WEEK);
      const { data: sub } = await guard.from('weekly_submissions')
        .select('id').eq('week_start', OPEN_WEEK).maybeSingle();
      rows.length === 0 && sub
        ? ok('empty submission stores 0 preferences but keeps the submission row')
        : bad('empty submission', `prefs=${rows.length} sub=${Boolean(sub)}`);
    }
  }

  console.log('\n\x1b[1m5. Deadline enforcement\x1b[0m');
  {
    const { error } = await savePrefs(guard, LOCKED_WEEK, [{ date: addDays(LOCKED_WEEK, 1), shift: 'morning', allows12h: false }]);
    error && (error.code === '42501' || /closed/i.test(error.message))
      ? ok('save to a locked week rejected with a clean error')
      : bad('locked week', error ? `${error.code}: ${error.message}` : 'save succeeded');
  }
  {
    const rows = await readPrefs(guard, LOCKED_WEEK);
    rows.length === 0 ? ok('nothing was written to the locked week') : bad('locked write', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m6. Isolation between guards\x1b[0m');
  {
    const neighbour = await signedIn(CODE2);
    await savePrefs(neighbour, OPEN_WEEK, [{ date: addDays(OPEN_WEEK, 2), shift: 'night', allows12h: false }]);
    const mine = await readPrefs(guard, OPEN_WEEK);
    const theirs = await readPrefs(neighbour, OPEN_WEEK);
    mine.length === 0 && theirs.length === 1
      ? ok("a neighbour's save lands on their own row set, not the caller's")
      : bad('isolation', `mine=${JSON.stringify(mine)} theirs=${JSON.stringify(theirs)}`);

    const ids = await sql(`SELECT p.employee_code, COUNT(w.id)::int AS n
                             FROM profiles p
                             LEFT JOIN weekly_wish_preferences w ON w.guard_id = p.id
                            WHERE p.employee_code LIKE '9902%'
                            GROUP BY p.employee_code ORDER BY p.employee_code`);
    JSON.stringify(ids) === JSON.stringify([{ employee_code: CODE, n: 0 }, { employee_code: CODE2, n: 1 }])
      ? ok('rows are attributed to the correct guard in the database')
      : bad('attribution', JSON.stringify(ids));
  }

  console.log('\n\x1b[1m7. The כמות target is readable by its owner only\x1b[0m');
  {
    const { data } = await guard.from('weekly_guard_targets')
      .select('configured_kamut').eq('week_start', OPEN_WEEK);
    data?.length === 1 && data[0].configured_kamut === 3
      ? ok('guard reads their own configured כמות (3)')
      : bad('own kamut', JSON.stringify(data));
  }

  console.log('\n\x1b[1m8. Free-text notes\x1b[0m');
  {
    const { error } = await savePrefs(
      guard, OPEN_WEEK,
      [{ date: addDays(OPEN_WEEK, 0), shift: 'morning', allows12h: false }],
      'עדיפות למשמרות לילה',
    );
    const note = await readNotes(guard, OPEN_WEEK);
    !error && note === 'עדיפות למשמרות לילה'
      ? ok('note saved and read back verbatim')
      : bad('note round-trip', error ? error.message : `got ${JSON.stringify(note)}`);
  }
  {
    // Whitespace-only is "no note", same treatment as an empty slot array is
    // "no availability" -- normalised to a clean NULL rather than a stray string.
    await savePrefs(guard, OPEN_WEEK, [], '   ');
    const note = await readNotes(guard, OPEN_WEEK);
    note === null
      ? ok('whitespace-only note normalises to NULL')
      : bad('whitespace note', JSON.stringify(note));
  }
  {
    // The notes_length CHECK is the actual backstop; the client's maxLength is
    // just UX. A 501-character note must be rejected at the database, not
    // silently truncated.
    const { error } = await savePrefs(guard, OPEN_WEEK, [], 'א'.repeat(501));
    error
      ? ok('a note over 500 characters is rejected by the database')
      : bad('notes_length CHECK', 'oversized note was accepted');
  }
  {
    // Same isolation guarantee as the preference rows: one guard's note is
    // invisible through another guard's client.
    const neighbour = await signedIn(CODE2);
    await savePrefs(neighbour, OPEN_WEEK, [], 'עד 4 משמרות');
    const mine = await readNotes(guard, OPEN_WEEK);
    const theirs = await readNotes(neighbour, OPEN_WEEK);
    mine !== 'עד 4 משמרות' && theirs === 'עד 4 משמרות'
      ? ok("a neighbour's note lands on their own row, not the caller's")
      : bad('note isolation', `mine=${JSON.stringify(mine)} theirs=${JSON.stringify(theirs)}`);
  }

  console.log('\n\x1b[1m9. Guard-requested shift count\x1b[0m');
  {
    const { error } = await savePrefs(
      guard, OPEN_WEEK,
      [{ date: addDays(OPEN_WEEK, 0), shift: 'morning', allows12h: false }],
      null,
      2,
    );
    const requested = await readRequestedShifts(guard, OPEN_WEEK);
    !error && requested === 2
      ? ok('requested shift count saved and read back verbatim')
      : bad('requested round-trip', error ? error.message : `got ${JSON.stringify(requested)}`);
  }
  {
    // A value outside 0-6 is rejected by the requested_shifts CHECK, the same
    // way notes_length backstops the notes column -- the client's own bounds
    // (the stepper's min/max) are UX only.
    const { error } = await savePrefs(guard, OPEN_WEEK, [], null, 7);
    error
      ? ok('a requested count above 6 is rejected by the database')
      : bad('requested_shifts CHECK', 'out-of-range value was accepted');
  }
  {
    // Re-saving with requested_shifts omitted (undefined -> null) clears a
    // previously-saved value rather than leaving it stale -- same "always a
    // full replace, never a partial patch" contract the RPC already has for
    // slots and notes.
    await savePrefs(guard, OPEN_WEEK, [], null, null);
    const requested = await readRequestedShifts(guard, OPEN_WEEK);
    requested === null
      ? ok('omitting the requested count on a later save clears it back to NULL')
      : bad('requested clear', JSON.stringify(requested));
  }
  {
    // Same isolation guarantee as notes and preference rows: one guard's
    // requested count is invisible through another guard's client.
    const neighbour = await signedIn(CODE2);
    await savePrefs(neighbour, OPEN_WEEK, [], null, 4);
    await savePrefs(guard, OPEN_WEEK, [], null, 1);
    const mine = await readRequestedShifts(guard, OPEN_WEEK);
    const theirs = await readRequestedShifts(neighbour, OPEN_WEEK);
    mine === 1 && theirs === 4
      ? ok("a neighbour's requested count lands on their own row, not the caller's")
      : bad('requested isolation', `mine=${JSON.stringify(mine)} theirs=${JSON.stringify(theirs)}`);
  }

  console.log('\n\x1b[1m10. Cancelling a submission outright (delete_week_submission)\x1b[0m');
  {
    // Fresh, known state to cancel: a real submission with slots and a note,
    // not the leftover empty-but-submitted state section 8 left behind.
    await savePrefs(
      guard, OPEN_WEEK,
      [
        { date: addDays(OPEN_WEEK, 0), shift: 'morning', allows12h: false },
        { date: addDays(OPEN_WEEK, 1), shift: 'night', allows12h: false },
      ],
      'הערה לפני ביטול',
    );
    const before = await readPrefs(guard, OPEN_WEEK);
    before.length === 2
      ? ok('precondition: 2 slots saved before cancelling')
      : bad('precondition', JSON.stringify(before));
  }
  {
    const { error } = await guard.rpc('delete_week_submission', { p_week_start: OPEN_WEEK });
    error ? bad('cancel submission', error.message) : ok('cancel submission succeeds');
  }
  {
    const rows = await readPrefs(guard, OPEN_WEEK);
    const { data: sub } = await guard.from('weekly_submissions')
      .select('id').eq('week_start', OPEN_WEEK).maybeSingle();
    rows.length === 0 && !sub
      ? ok('both preferences and the submission row itself are gone -- genuinely "never submitted"')
      : bad('cancel result', `prefs=${rows.length} sub=${Boolean(sub)}`);
  }
  {
    // The guard might double-tap, or the UI might be a beat stale -- cancelling
    // with nothing left to cancel must not surface as an error.
    const { error } = await guard.rpc('delete_week_submission', { p_week_start: OPEN_WEEK });
    !error
      ? ok('cancelling again with nothing to cancel is a harmless no-op')
      : bad('idempotent cancel', error.message);
  }
  {
    const { error } = await guard.rpc('delete_week_submission', { p_week_start: LOCKED_WEEK });
    error && (error.code === '42501' || /closed/i.test(error.message))
      ? ok('cancelling a locked week is rejected with a clean error')
      : bad('locked week cancel', error ? `${error.code}: ${error.message}` : 'cancel succeeded');
  }
  {
    // Isolation, same guarantee as saving: cancelling my own submission must
    // never touch a neighbour's.
    const neighbour = await signedIn(CODE2);
    await savePrefs(neighbour, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 2), shift: 'afternoon', allows12h: false },
    ]);
    await savePrefs(guard, OPEN_WEEK, [
      { date: addDays(OPEN_WEEK, 3), shift: 'morning', allows12h: false },
    ]);
    await guard.rpc('delete_week_submission', { p_week_start: OPEN_WEEK });
    const mine = await readPrefs(guard, OPEN_WEEK);
    const theirs = await readPrefs(neighbour, OPEN_WEEK);
    mine.length === 0 && theirs.length === 1
      ? ok("cancelling my own submission leaves a neighbour's untouched")
      : bad('cancel isolation', `mine=${JSON.stringify(mine)} theirs=${JSON.stringify(theirs)}`);
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE C PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
