/**
 * Loads a week of guard availability for hands-on testing through the UI.
 *
 * Creates profiles for the placeholder badge codes (they have no auth.users row
 * until someone registers, and a profile cannot exist without one), then writes
 * their preferences, submissions and כמות for the target week.
 *
 * Idempotent for the guards it manages: it clears and rewrites their rows each
 * run. It never touches 005396, so Ben's own submitted preferences survive.
 *
 *   node supabase/tests/seed-testweek.mjs            # load
 *   node supabase/tests/seed-testweek.mjs --wipe     # remove the mock guards
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
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];

const WEEK = '2026-08-09';
const PIN = '123456'; // set anyway; costs nothing and saves a round trip later

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body;
}

// day 0 = Sunday 09/08 ... day 6 = Saturday 15/08
// 'm' morning, 'a' afternoon, 'n' night; a trailing 12 means that shift extends.
const M = 'morning', A = 'afternoon', N = 'night';

// "פתוח" -- all three shifts AND willing to extend at both ends, so the day is
// eligible for day12 (06:45-18:45) and night12 (18:45-06:45) as well. Confirmed
// by Ben; his manual roster has עידן on "עד 18:45" for a פתוח Saturday.
const OPEN = [[M, 12], [A], [N, 12]];

const GUARDS = [
  { code: '100001', name: 'יובל', kamut: 5, days: [
    [[A]],                       // א  צהריים
    [[M, 12]],                   // ב  בוקר+12
    [[M], [A]],                  // ג  בוקר, צהריים
    [[A]],                       // ד  צהריים
    [[M], [A]],                  // ה  בוקר, צהריים
    [[M, 12]],                   // ו  בוקר+12
    [[M], [N, 12]],              // ש  בוקר, לילה+12
  ]},
  { code: '100002', name: 'לוק', kamut: 5, days: [
    OPEN,                        // א  פתוח
    [[M], [A]],                  // ב
    [[N]],                       // ג
    OPEN, OPEN, OPEN, OPEN,      // ד ה ו ש
  ]},
  { code: '100003', name: 'הודיה', kamut: 3, days: [
    [[N]],                       // א
    [[A], [N]],                  // ב
    [[M], [A]],                  // ג
    [],                          // ד  -
    [[N]],                       // ה
    [[M]],                       // ו
    [],                          // ש  -
  ]},
  { code: '100004', name: 'שלי', kamut: 5, days: [
    [[N, 12]],                   // א  לילה+12
    [[A], [N]],                  // ב
    [[A]],                       // ג
    [],                          // ד  -
    [[A], [N]],                  // ה
    [[N]],                       // ו
    [[A], [N]],                  // ש
  ]},
  // "צהריים+12" was dropped at Ben's instruction: an afternoon shift has no 12h
  // form (only morning extends to day12, only night to night12), so those days
  // are a plain afternoon.
  { code: '100005', name: 'ים', kamut: 5, days: [
    [[M], [A]],                  // א
    [[M]],                       // ב
    [[A]],                       // ג
    [[M], [A]],                  // ד
    [[M, 12]],                   // ה  בוקר+12
    [[M]],                       // ו
    [],                          // ש  -
  ]},
  { code: '100006', name: 'עידן', kamut: 4, days: [
    [[A], [N]],                  // א
    OPEN,                        // ב  פתוח
    [[M], [A]],                  // ג
    [],                          // ד  -
    [],                          // ה  -
    [[N, 12]],                   // ו  לילה+12
    OPEN,                        // ש  פתוח
  ]},
  { code: '100007', name: 'ניתאי', kamut: 2, days: [
    [[M]],                       // א
    [],                          // ב  -
    [[A]],                       // ג
    [[M]],                       // ד
    [], [], [],                  // ה ו ש  -
  ]},
];

const CODES = GUARDS.map((g) => `'${g.code}'`).join(', ');

async function wipe() {
  await sql(`
    DELETE FROM auth.users WHERE email IN (${GUARDS.map((g) => `'${g.code}@guards.local'`).join(', ')});
    UPDATE roster_codes SET is_claimed = FALSE, claimed_at = NULL
     WHERE employee_code IN (${CODES});`);
  console.log('mock guards removed; badge codes are claimable again');
}

async function load() {
  // Profiles first. A profile needs an auth.users row, so the mock guards get
  // real auth records -- which also means the badge codes must be marked
  // claimed, or the real claim flow would later collide on the email.
  await sql(`
    DELETE FROM auth.users WHERE email IN (${GUARDS.map((g) => `'${g.code}@guards.local'`).join(', ')});

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ${GUARDS.map((g) => `('${g.code}')`).join(', ')}) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1), rc.display_name, 'guard'::user_role, TRUE
      FROM auth.users u
      JOIN roster_codes rc ON rc.employee_code = split_part(u.email,'@',1)
     WHERE u.email IN (${GUARDS.map((g) => `'${g.code}@guards.local'`).join(', ')});

    UPDATE roster_codes SET is_claimed = TRUE, claimed_at = NOW()
     WHERE employee_code IN (${CODES});
  `);

  // Preferences, submissions and כמות for the managed guards only.
  const prefRows = [];
  const subRows = [];
  const targetRows = [];

  for (const g of GUARDS) {
    subRows.push(`((SELECT id FROM profiles WHERE employee_code='${g.code}'), '${WEEK}'::date)`);
    targetRows.push(
      `('${WEEK}'::date, (SELECT id FROM profiles WHERE employee_code='${g.code}'), ${g.kamut})`,
    );
    g.days.forEach((slots, dayIdx) => {
      for (const [shift, ext] of slots) {
        prefRows.push(
          `((SELECT id FROM profiles WHERE employee_code='${g.code}'), '${WEEK}'::date, ` +
            `('${WEEK}'::date + ${dayIdx}), '${shift}'::base_shift, ${ext === 12})`,
        );
      }
    });
  }

  await sql(`
    DELETE FROM weekly_wish_preferences WHERE week_start='${WEEK}'
      AND guard_id IN (SELECT id FROM profiles WHERE employee_code IN (${CODES}));
    DELETE FROM weekly_submissions WHERE week_start='${WEEK}'
      AND guard_id IN (SELECT id FROM profiles WHERE employee_code IN (${CODES}));
    DELETE FROM weekly_guard_targets WHERE week_start='${WEEK}'
      AND guard_id IN (SELECT id FROM profiles WHERE employee_code IN (${CODES}));

    INSERT INTO weekly_submissions (guard_id, week_start) VALUES ${subRows.join(', ')};
    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut) VALUES ${targetRows.join(', ')};
    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift, allows_12h)
      VALUES ${prefRows.join(', ')};
  `);

  const summary = await sql(`
    SELECT p.display_name AS name,
           g.configured_kamut AS kamut,
           COUNT(w.id)::int AS slots,
           COUNT(DISTINCT w.target_date)::int AS days,
           COUNT(*) FILTER (WHERE w.allows_12h)::int AS twelve
      FROM profiles p
      LEFT JOIN weekly_guard_targets g ON g.guard_id = p.id AND g.week_start = '${WEEK}'
      LEFT JOIN weekly_wish_preferences w ON w.guard_id = p.id AND w.week_start = '${WEEK}'
     WHERE p.is_active
     GROUP BY p.display_name, g.configured_kamut, p.employee_code
     ORDER BY p.employee_code`);

  console.log('\nname       כמות  slots  days  12h   effective כמות = min(כמות, days, 5)');
  console.log('---------- ----- ------ ----- ----  --------------------------------');
  for (const r of summary) {
    const eff = Math.min(r.kamut ?? 0, r.days ?? 0, 5);
    const flag = eff < (r.kamut ?? 0) ? `  <- lowered from ${r.kamut}` : '';
    console.log(
      `${(r.name ?? '?').padEnd(11)}${String(r.kamut ?? 0).padStart(4)}${String(r.slots).padStart(7)}` +
        `${String(r.days).padStart(6)}${String(r.twelve).padStart(6)}    ${eff}${flag}`,
    );
  }
  const tot = summary.reduce((s, r) => s + Math.min(r.kamut ?? 0, r.days ?? 0, 5), 0);
  console.log(`\ntotal effective כמות: ${tot}  (supply ceiling: ${summary.length} guards x 5 = ${summary.length * 5})`);
}

if (process.argv.includes('--wipe')) await wipe();
else await load();
