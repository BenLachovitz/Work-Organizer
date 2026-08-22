/**
 * GATE I -- self-service PIN reset via WhatsApp OTP (whatsapp-pin-reset).
 *
 * A real send to Meta's Cloud API costs money and must never fire inside a
 * repeatable test:cloud run -- same reasoning Gate G already documents for
 * never invoking send-notifications for a real push. So otp_verify/
 * otp_complete are exercised for real (seeding a pin_reset_otps row directly
 * via SQL with a known OTP's hash, standing in for a real ceremony -- same
 * approach Gate H uses for webauthn_credentials), and otp_request is only
 * exercised on the one path reachable without ever touching Meta: a claimed
 * guard with no phone_number on file, which the function rejects BEFORE it
 * ever checks whether WHATSAPP_* secrets are configured. A real send is
 * confirmed separately, once, by hand (see BACKLOG.md).
 *
 *   node supabase/tests/whatsapp-pin-reset.cloud.test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
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
const FN = `${env.VITE_SUPABASE_URL}/functions/v1/whatsapp-pin-reset`;

const CODE = '990801'; // the one guard under test
const CODE_NO_PHONE = '990802'; // claimed, but no phone_number on file
const OLD_PIN = 'Old-Pin-12345';
const NEW_PIN = '654321';
const OTP = '135790';

let passed = 0;
const failures = [];
const ok = (l) => { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${l}`); };
const bad = (l, d) => { failures.push(`${l} -- ${d}`); console.log(`  \x1b[31mFAIL\x1b[0m  ${l}\n        ${d}`); };

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

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
  DELETE FROM pin_reset_otps WHERE employee_code IN ('${CODE}', '${CODE_NO_PHONE}');
  DELETE FROM auth.users WHERE email LIKE '9908%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9908%';`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_codes (employee_code, display_name, initial_role, phone_number) VALUES
      ('${CODE}', 'בדיקת-וואטסאפ', 'guard', '+972500000801'),
      ('${CODE_NO_PHONE}', 'בדיקת-וואטסאפ-ללא-טלפון', 'guard', NULL);

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${OLD_PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${CODE}'), ('${CODE_NO_PHONE}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1)
             WHEN '${CODE}' THEN 'בדיקת-וואטסאפ' ELSE 'בדיקת-וואטסאפ-ללא-טלפון' END,
           'guard'::user_role, TRUE
      FROM auth.users u WHERE u.email LIKE '9908%@guards.local';

    UPDATE roster_codes SET is_claimed = TRUE WHERE employee_code LIKE '9908%';
  `);
}

function client() {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signedIn(code, pin) {
  const db = client();
  const { error } = await db.auth.signInWithPassword({ email: `${code}@guards.local`, password: pin });
  if (error) throw new Error(`sign-in ${code}: ${error.message}`);
  return db;
}

async function canSignIn(code, pin) {
  try {
    await signedIn(code, pin);
    return true;
  } catch {
    return false;
  }
}

async function call(action, body) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Seeds a fresh pin_reset_otps row for CODE with the given OTP, replacing any prior one. */
async function seedOtp(otp, { expired = false, attempts = 0 } = {}) {
  await sql(`DELETE FROM pin_reset_otps WHERE employee_code = '${CODE}'`);
  const expiresAt = expired ? `NOW() - INTERVAL '1 minute'` : `NOW() + INTERVAL '10 minutes'`;
  await sql(`
    INSERT INTO pin_reset_otps (employee_code, otp_hash, attempts, expires_at)
    VALUES ('${CODE}', '${sha256Hex(otp)}', ${attempts}, ${expiresAt})`);
}

async function run() {
  console.log('\n\x1b[1mGATE I -- self-service PIN reset via WhatsApp OTP\x1b[0m\n');
  await setup();

  console.log('\x1b[1m1. otp_request -- the one path reachable without ever touching Meta\x1b[0m');
  {
    const { status, json } = await call('otp_request', { employee_code: CODE_NO_PHONE });
    status === 404 && json?.error
      ? ok('a claimed guard with no phone_number on file gets a clean 404 -- checked BEFORE the WhatsApp config, never reaches Meta')
      : bad('no phone on file', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const { status } = await call('otp_request', { employee_code: '000000' });
    status === 404 ? ok('an unknown employee_code is rejected (404)') : bad('unknown code', `status=${status}`);
  }
  {
    const { status } = await call('otp_request', { employee_code: 'abc' });
    status === 400 ? ok('a malformed employee_code is rejected (400)') : bad('malformed code', `status=${status}`);
  }

  console.log('\n\x1b[1m2. otp_verify -- seeded row, standing in for a real WhatsApp send\x1b[0m');
  {
    await seedOtp(OTP);
    const { status, json } = await call('otp_verify', { employee_code: CODE, otp: '000000' });
    status === 400 && !json?.verify_token ? ok('a wrong OTP is rejected (400, no token)') : bad('wrong otp', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const rows = await sql(`SELECT attempts FROM pin_reset_otps WHERE employee_code = '${CODE}'`);
    rows[0]?.attempts === 1 ? ok('the wrong guess incremented attempts') : bad('attempts increment', JSON.stringify(rows));
  }
  {
    // 4 more wrong guesses (5 total) exhausts the row -- the 6th call, even
    // with the CORRECT code, must still be rejected.
    for (let i = 0; i < 4; i++) await call('otp_verify', { employee_code: CODE, otp: '000000' });
    const { status } = await call('otp_verify', { employee_code: CODE, otp: OTP });
    status === 400 ? ok('5 wrong guesses locks the code out, even a correct guess after that is rejected') : bad('lockout', `status=${status}`);
  }
  {
    await seedOtp(OTP, { expired: true });
    const { status } = await call('otp_verify', { employee_code: CODE, otp: OTP });
    status === 400 ? ok('an expired OTP is rejected') : bad('expired otp', `status=${status}`);
  }
  let verifyToken;
  {
    await seedOtp(OTP);
    const { status, json } = await call('otp_verify', { employee_code: CODE, otp: OTP });
    verifyToken = json?.verify_token;
    status === 200 && verifyToken
      ? ok('the correct OTP is accepted and mints a verify_token')
      : bad('correct otp', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const rows = await sql(`SELECT verified_at FROM pin_reset_otps WHERE employee_code = '${CODE}'`);
    rows[0]?.verified_at ? ok('verified_at is stamped on the row') : bad('verified_at stamped', JSON.stringify(rows));
  }

  console.log('\n\x1b[1m3. otp_complete -- resets the password, single-use\x1b[0m');
  {
    const { status } = await call('otp_complete', {
      employee_code: CODE, verify_token: 'not-the-real-token', new_pin: NEW_PIN,
    });
    status === 400 ? ok('a wrong verify_token is rejected') : bad('wrong token', `status=${status}`);
  }
  {
    const { status } = await call('otp_complete', {
      employee_code: CODE, verify_token: verifyToken, new_pin: '123',
    });
    status === 400 ? ok('a too-short new PIN is rejected') : bad('short pin', `status=${status}`);
  }
  {
    const { status, json } = await call('otp_complete', {
      employee_code: CODE, verify_token: verifyToken, new_pin: NEW_PIN,
    });
    status === 200 && json?.ok ? ok('otp_complete resets the password (200)') : bad('otp_complete', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const oldStillWorks = await canSignIn(CODE, OLD_PIN);
    !oldStillWorks ? ok('the OLD PIN no longer signs in') : bad('old pin dead', 'old PIN still signs in');
  }
  {
    const newWorks = await canSignIn(CODE, NEW_PIN);
    newWorks ? ok('the NEW PIN signs in') : bad('new pin works', 'new PIN does not sign in');
  }
  {
    const rows = await sql(`SELECT id FROM profiles WHERE employee_code = '${CODE}'`);
    rows.length === 1 ? ok('the profile row is untouched (same employee_code, still resolves)') : bad('profile untouched', JSON.stringify(rows));
  }
  {
    // The OTP row was deleted on consumption -- replaying the same token must fail.
    const { status } = await call('otp_complete', {
      employee_code: CODE, verify_token: verifyToken, new_pin: '111111',
    });
    status === 400 ? ok('replaying the same (now-consumed) verify_token is rejected') : bad('replay', `status=${status}`);
  }

  console.log('\n\x1b[1m4. RLS -- pin_reset_otps is fully sealed\x1b[0m');
  {
    // REVOKE ALL means there's no grant to even evaluate RLS against -- a
    // permission-denied error (not just an empty result) IS the sealed state.
    const guard = await signedIn(CODE, NEW_PIN);
    const { data, error } = await guard.from('pin_reset_otps').select('*');
    (data ?? []).length === 0 && error?.code === '42501'
      ? ok('pin_reset_otps is unreachable via PostgREST (permission denied, no grant)')
      : bad('otps sealed', error?.message ?? JSON.stringify(data));
  }

  console.log('\n\x1b[1m5. claim_attempts widened for otp_request\x1b[0m');
  {
    const before = await sql(`SELECT COUNT(*)::int AS n FROM claim_attempts WHERE employee_code = '${CODE_NO_PHONE}' AND action = 'otp_request'`);
    before[0].n > 0 ? ok("otp_request attempts are recorded under the 'otp_request' action") : bad('otp_request logged', JSON.stringify(before));
  }
  {
    try {
      await sql(`INSERT INTO claim_attempts (employee_code, action) VALUES ('999999', 'otp_request')`);
      ok("claim_attempts.action's CHECK constraint accepts 'otp_request'");
    } catch (e) {
      bad('otp_request action accepted', e.message);
    }
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE I PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
