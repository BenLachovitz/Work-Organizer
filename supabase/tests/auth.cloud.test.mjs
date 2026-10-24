/**
 * GATE B -- badge registration and login, against the live Edge Function.
 *
 * Uses temporary badge codes (99000x) inserted for the test and deleted after,
 * so the ten real seeded codes stay unclaimed and Ben can register 005396 with
 * his own PIN.
 *
 *   node supabase/tests/auth.cloud.test.mjs
 */

import { randomBytes } from 'node:crypto';
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

const FN = `${URL_BASE}/functions/v1/claim-code`;
const GUARD_CODE = '990001';
const MGR_CODE = '990002';
// Random per run: this repo is public, so a fixed PIN here would be a working
// credential for any test account a crashed run failed to clean up.
const PIN = 'T-' + randomBytes(12).toString('hex');

let passed = 0;
const failures = [];
const ok = (l) => { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${l}`); };
const bad = (l, d) => { failures.push(`${l} -- ${d}`); console.log(`  \x1b[31mFAIL\x1b[0m  ${l}\n        ${d}`); };

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

/** Calls the function the way the browser does: apikey, no session. */
async function callFn(body) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function signIn(code, pin) {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: APIKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${code}@guards.local`, password: pin }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const clearAttempts = () =>
  sql(`DELETE FROM claim_attempts WHERE employee_code IN ('${GUARD_CODE}','${MGR_CODE}','999999','000000')`);

/**
 * Snapshot of the real badge codes taken before the run.
 *
 * The invariant is that the tests do not DISTURB real codes -- not that no real
 * code is ever claimed. Ben has genuinely registered 005396, and asserting a
 * hard zero here would turn his real usage into a permanent test failure.
 */
let realCodeBaseline = '';

const realCodeState = async () => {
  const rows = await sql(
    `SELECT employee_code, is_claimed, claim_enabled FROM roster_codes
      WHERE employee_code NOT LIKE '99%' ORDER BY employee_code`);
  return JSON.stringify(rows);
};

async function setup() {
  await sql(`
    DELETE FROM auth.users WHERE email LIKE '9900%@guards.local';
    DELETE FROM roster_codes WHERE employee_code IN ('${GUARD_CODE}','${MGR_CODE}');
    DELETE FROM claim_attempts;
    INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
      ('${GUARD_CODE}', 'בדיקה-שומר', 'guard'),
      ('${MGR_CODE}',  'בדיקה-מנהל', 'manager');
  `);
}

async function teardown() {
  await sql(`
    DELETE FROM auth.users WHERE email LIKE '9900%@guards.local';
    DELETE FROM roster_codes WHERE employee_code IN ('${GUARD_CODE}','${MGR_CODE}');
    DELETE FROM claim_attempts;
  `);
}

async function run() {
  console.log('\n\x1b[1mGATE B -- badge registration + login (live Edge Function)\x1b[0m');
  console.log(`project: ${REF}\n`);
  realCodeBaseline = await realCodeState();
  await setup();

  console.log('\x1b[1m1. Code lookup\x1b[0m');
  {
    const { status, body } = await callFn({ action: 'status', employee_code: GUARD_CODE });
    if (status === 200 && body.exists === true && body.claimed === false && body.displayName === 'בדיקה-שומר')
      ok('valid unclaimed code returns name and unclaimed state');
    else bad('valid unclaimed code', `HTTP ${status} ${JSON.stringify(body)}`);
  }
  {
    const { body } = await callFn({ action: 'status', employee_code: '999999' });
    body?.exists === false
      ? ok('unknown code reports not-exists (no crash, no leak)')
      : bad('unknown code', JSON.stringify(body));
  }
  {
    const { status } = await callFn({ action: 'status', employee_code: '12' });
    status === 400 ? ok('malformed code rejected with 400') : bad('malformed code', `HTTP ${status}`);
  }
  {
    const { status } = await callFn({ action: 'wipe', employee_code: GUARD_CODE });
    status === 400 ? ok('unknown action rejected') : bad('unknown action', `HTTP ${status}`);
  }
  await clearAttempts();

  console.log('\n\x1b[1m2. First-login claim\x1b[0m');
  {
    const { status } = await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: '123' });
    status === 400 ? ok('short PIN rejected') : bad('short PIN', `HTTP ${status}`);
  }
  {
    const { status, body } = await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: PIN });
    status === 200 && body.ok ? ok('claim succeeds for an unclaimed code') : bad('claim', `HTTP ${status} ${JSON.stringify(body)}`);
  }
  {
    const rows = await sql(
      `SELECT p.role::text, p.display_name, p.is_active, c.is_claimed
         FROM profiles p JOIN roster_codes c ON c.employee_code = p.employee_code
        WHERE p.employee_code = '${GUARD_CODE}'`);
    const r = rows[0];
    r && r.role === 'guard' && r.display_name === 'בדיקה-שומר' && r.is_active === true && r.is_claimed === true
      ? ok('profile created with correct role, name, active flag; code marked claimed')
      : bad('profile after claim', JSON.stringify(rows));
  }
  {
    const { status } = await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: 'other1' });
    status === 409 ? ok('second claim on the same code rejected (409)') : bad('double claim', `HTTP ${status}`);
  }
  {
    const { body } = await callFn({ action: 'status', employee_code: GUARD_CODE });
    body?.claimed === true ? ok('status now reports claimed -> UI shows the PIN screen') : bad('status after claim', JSON.stringify(body));
  }
  await clearAttempts();

  console.log('\n\x1b[1m3. Sign-in\x1b[0m');
  {
    const { status, body } = await signIn(GUARD_CODE, PIN);
    status === 200 && body.access_token ? ok('sign-in with badge code + PIN returns a JWT') : bad('sign-in', `HTTP ${status}`);
  }
  {
    const { status } = await signIn(GUARD_CODE, 'wrong1');
    status >= 400 ? ok('wrong PIN rejected') : bad('wrong PIN accepted', `HTTP ${status}`);
  }
  {
    // The JWT must actually resolve to the right profile through RLS.
    const { body } = await signIn(GUARD_CODE, PIN);
    const res = await fetch(`${URL_BASE}/rest/v1/profiles?select=employee_code,role&employee_code=eq.${GUARD_CODE}`, {
      headers: { apikey: APIKEY, Authorization: `Bearer ${body.access_token}` },
    });
    const rows = await res.json();
    rows?.[0]?.role === 'guard' ? ok('JWT resolves to the guard profile via RLS') : bad('profile via JWT', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m4. Manager role propagates from the badge\x1b[0m');
  {
    await callFn({ action: 'claim', employee_code: MGR_CODE, pin: PIN });
    const { body } = await signIn(MGR_CODE, PIN);
    const res = await fetch(`${URL_BASE}/rest/v1/roster_codes?select=employee_code`, {
      headers: { apikey: APIKEY, Authorization: `Bearer ${body.access_token}` },
    });
    const rows = await res.json();
    Array.isArray(rows) && rows.length >= 10
      ? ok('manager badge yields manager role (can audit roster_codes)')
      : bad('manager role', JSON.stringify(rows).slice(0, 120));
  }
  await clearAttempts();

  console.log('\n\x1b[1m5. Rate limiting (the only public write path)\x1b[0m');
  {
    let saw429 = false;
    for (let i = 0; i < 13; i++) {
      const { status } = await callFn({ action: 'status', employee_code: GUARD_CODE });
      if (status === 429) { saw429 = true; break; }
    }
    saw429 ? ok('per-code throttle trips within 13 attempts (limit 10/15min)') : bad('per-code throttle', 'never returned 429');
  }
  await clearAttempts();
  {
    // A stranger must NOT be able to lock a guard out of registering. Junk
    // traffic may burn the rate-limit window, but never permanently disables.
    await sql(`UPDATE roster_codes SET is_claimed = FALSE, claim_enabled = TRUE WHERE employee_code = '${GUARD_CODE}';
               DELETE FROM auth.users WHERE email = '${GUARD_CODE}@guards.local';`);
    for (let i = 0; i < 6; i++) await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: '1' });
    const rows = await sql(`SELECT claim_enabled FROM roster_codes WHERE employee_code = '${GUARD_CODE}'`);
    rows[0]?.claim_enabled === true
      ? ok('junk traffic cannot permanently lock a guard out (no auto-disable)')
      : bad('lockout DoS', 'a stranger disabled a badge code');
  }
  await clearAttempts();
  {
    // The manual kill-switch must still work.
    await sql(`UPDATE roster_codes SET claim_enabled = FALSE WHERE employee_code = '${GUARD_CODE}'`);
    const { status } = await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: PIN });
    status === 403 ? ok('manager kill-switch blocks claiming') : bad('kill-switch', `HTTP ${status}`);
  }
  {
    await sql(`UPDATE roster_codes SET claim_enabled = TRUE WHERE employee_code = '${GUARD_CODE}'`);
    const { status } = await callFn({ action: 'claim', employee_code: GUARD_CODE, pin: PIN });
    status === 200 ? ok('re-enabling the code restores claiming') : bad('re-enable', `HTTP ${status}`);
  }

  console.log('\n\x1b[1m6. Real seeded codes remain untouched\x1b[0m');
  {
    const after = await realCodeState();
    after === realCodeBaseline
      ? ok('real badge codes are byte-for-byte unchanged by the test run')
      : bad('real codes', `state changed\n  before: ${realCodeBaseline}\n  after:  ${after}`);
  }

  await teardown();

  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE B PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await teardown(); } catch { /* best effort */ }
  process.exit(1);
});
