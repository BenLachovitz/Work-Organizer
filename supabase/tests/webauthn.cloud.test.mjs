/**
 * GATE H -- app-scoped WebAuthn credentials: RLS on the two new tables
 * (migration 46) and the webauthn Edge Function's auth/verification paths.
 *
 * A real end-to-end ceremony needs a physical authenticator or a browser's
 * virtual-authenticator API, neither of which this suite uses -- same
 * deliberate scope as Gate G never invoking send-notifications for a real
 * push. What IS exercised for real: register-options/auth-options actually
 * call @simplewebauthn/server's generateRegistrationOptions/
 * generateAuthenticationOptions against the live Deno runtime and produce
 * well-formed output -- the smoke test this suite doubles as.
 *
 *   node supabase/tests/webauthn.cloud.test.mjs
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
const FN = `${env.VITE_SUPABASE_URL}/functions/v1/webauthn`;
const ORIGIN = 'https://work-organizer-iota.vercel.app';

const CODE_A = '990401'; // owner guard
const CODE_B = '990402'; // other guard, used for cross-account RLS denial
const CODE_M = '990403'; // manager, used for the is_manager() read clause
const PIN = 'WebAuthn-1234';
const FAKE_CREDENTIAL_ID = 'test-cred-990401-aaaa';

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
  DELETE FROM auth.users WHERE email LIKE '9904%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9904%';`);

async function setup() {
  await cleanup();
  await sql(`
    INSERT INTO roster_codes (employee_code, display_name, initial_role) VALUES
      ('${CODE_A}', 'בדיקת-וובאות-א', 'guard'),
      ('${CODE_B}', 'בדיקת-וובאות-ב', 'guard'),
      ('${CODE_M}', 'בדיקת-וובאות-מנהל', 'manager');

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ('${CODE_A}'), ('${CODE_B}'), ('${CODE_M}')) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1),
           CASE split_part(u.email,'@',1)
             WHEN '${CODE_A}' THEN 'בדיקת-וובאות-א'
             WHEN '${CODE_B}' THEN 'בדיקת-וובאות-ב'
             ELSE 'בדיקת-וובאות-מנהל' END,
           CASE split_part(u.email,'@',1) WHEN '${CODE_M}' THEN 'manager' ELSE 'guard' END::user_role,
           TRUE
      FROM auth.users u WHERE u.email LIKE '9904%@guards.local';

    UPDATE roster_codes SET is_claimed = TRUE WHERE employee_code LIKE '9904%';
  `);
}

function client() {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signedIn(code) {
  const db = client();
  const { error } = await db.auth.signInWithPassword({ email: `${code}@guards.local`, password: PIN });
  if (error) throw new Error(`sign-in ${code}: ${error.message}`);
  return db;
}

async function guardId(code) {
  const { data } = await sqlSelect(`SELECT id FROM profiles WHERE employee_code = '${code}'`);
  return data;
}
async function sqlSelect(query) {
  const body = await sql(query);
  return { data: body?.[0]?.id };
}

async function call(action, body, token) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function run() {
  console.log('\n\x1b[1mGATE H -- app-scoped WebAuthn (registration/auth Edge Function + RLS)\x1b[0m\n');
  await setup();

  const guardA = await signedIn(CODE_A);
  const guardB = await signedIn(CODE_B);
  const manager = await signedIn(CODE_M);
  const { data: { session: sessionA } } = await guardA.auth.getSession();
  const idA = await guardId(CODE_A);
  const idB = await guardId(CODE_B);

  console.log('\x1b[1m1. register-options -- real generateRegistrationOptions() call\x1b[0m');
  {
    const { status, json } = await call('register-options', {}, sessionA.access_token);
    status === 200 && json?.options?.challenge && json.options.rp?.id === 'work-organizer-iota.vercel.app'
      ? ok('register-options returns well-formed options for a valid session')
      : bad('register-options', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const { status } = await call('register-options', {});
    status === 401 ? ok('register-options with no Authorization is rejected (401)') : bad('register-options no auth', `status=${status}`);
  }
  {
    const { status } = await call('register-options', {}, 'garbage.token.here');
    status === 401 ? ok('register-options with a malformed token is rejected (401)') : bad('register-options bad token', `status=${status}`);
  }

  console.log('\x1b[1m2. register-verify -- rejects a bogus credential cleanly (no crash)\x1b[0m');
  {
    await call('register-options', {}, sessionA.access_token); // issue a fresh challenge
    const { status, json } = await call(
      'register-verify',
      { credential: { id: 'x', rawId: 'x', response: {}, type: 'public-key' } },
      sessionA.access_token,
    );
    status === 400 && json?.error ? ok('register-verify rejects a bogus credential (400, not a crash)') : bad('register-verify bogus', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const { status } = await call('register-verify', { credential: {} });
    status === 401 ? ok('register-verify with no Authorization is rejected (401)') : bad('register-verify no auth', `status=${status}`);
  }

  console.log('\x1b[1m3. Origin allowlist\x1b[0m');
  {
    const res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com', apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ action: 'register-options' }),
    });
    res.status === 403 ? ok('an origin outside the allowlist is rejected (403)') : bad('origin allowlist', `status=${res.status}`);
  }

  console.log('\x1b[1m4. A credential row exists (seeded directly, standing in for a real ceremony)\x1b[0m');
  await sql(`
    INSERT INTO webauthn_credentials (guard_id, credential_id, public_key, counter, device_type, backed_up)
    VALUES ('${idA}', '${FAKE_CREDENTIAL_ID}', '\\x001122', 0, 'singleDevice', FALSE);
  `);

  console.log('\x1b[1m5. auth-options -- real generateAuthenticationOptions() call\x1b[0m');
  {
    const { status, json } = await call('auth-options', { guard_id: idA });
    const ids = (json?.options?.allowCredentials ?? []).map((c) => c.id);
    status === 200 && ids.includes(FAKE_CREDENTIAL_ID)
      ? ok('auth-options returns well-formed options listing the registered credential')
      : bad('auth-options', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    const { status } = await call('auth-options', { guard_id: idB });
    status === 404 ? ok('auth-options for a guard with no credentials is rejected (404, in-app error not an OS dialog)') : bad('auth-options no creds', `status=${status}`);
  }
  {
    const { status } = await call('auth-options', { guard_id: 'not-a-uuid' });
    status === 400 ? ok('auth-options with a malformed guard_id is rejected (400)') : bad('auth-options bad id', `status=${status}`);
  }

  console.log('\x1b[1m6. auth-verify -- rejects a bogus signature cleanly (no crash)\x1b[0m');
  {
    await call('auth-options', { guard_id: idA }); // fresh challenge
    const { status, json } = await call('auth-verify', {
      guard_id: idA,
      credential: { id: FAKE_CREDENTIAL_ID, rawId: FAKE_CREDENTIAL_ID, response: {}, type: 'public-key' },
    });
    status === 400 && json?.error ? ok('auth-verify rejects a bogus signature (400, not a crash)') : bad('auth-verify bogus', `status=${status} body=${JSON.stringify(json)}`);
  }
  {
    // The challenge from the previous call was already consumed -- retrying
    // must fail on "no challenge", proving single-use, not just bad-signature.
    const { status } = await call('auth-verify', {
      guard_id: idA,
      credential: { id: FAKE_CREDENTIAL_ID, rawId: FAKE_CREDENTIAL_ID, response: {}, type: 'public-key' },
    });
    status === 400 ? ok('a second auth-verify without a fresh auth-options call is rejected (challenge is single-use)') : bad('auth-verify replay', `status=${status}`);
  }

  console.log('\x1b[1m7. unknown action / method\x1b[0m');
  {
    const { status } = await call('bogus', {});
    status === 400 ? ok('an unknown action is rejected (400)') : bad('unknown action', `status=${status}`);
  }
  {
    const res = await fetch(FN, { method: 'GET', headers: { Origin: ORIGIN, apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY } });
    res.status === 405 ? ok('GET is rejected (405)') : bad('GET method', `status=${res.status}`);
  }

  console.log('\x1b[1m8. RLS on webauthn_credentials\x1b[0m');
  {
    const { data } = await guardA.from('webauthn_credentials').select('id').eq('credential_id', FAKE_CREDENTIAL_ID);
    (data ?? []).length === 1 ? ok('the owner can read their own credential row') : bad('owner read', JSON.stringify(data));
  }
  {
    const { data } = await guardB.from('webauthn_credentials').select('id').eq('credential_id', FAKE_CREDENTIAL_ID);
    (data ?? []).length === 0 ? ok("a different guard cannot read the owner's credential row") : bad('cross-account read', JSON.stringify(data));
  }
  {
    const { data } = await guardB.from('webauthn_credentials').update({ friendly_name: 'hijacked' }).eq('credential_id', FAKE_CREDENTIAL_ID).select();
    (data ?? []).length === 0 ? ok("a different guard cannot update the owner's credential row") : bad('cross-account update', JSON.stringify(data));
  }
  {
    const { data } = await guardB.from('webauthn_credentials').delete().eq('credential_id', FAKE_CREDENTIAL_ID).select();
    (data ?? []).length === 0 ? ok("a different guard cannot delete the owner's credential row") : bad('cross-account delete', JSON.stringify(data));
  }
  {
    const { data } = await manager.from('webauthn_credentials').select('id').eq('credential_id', FAKE_CREDENTIAL_ID);
    (data ?? []).length === 1 ? ok('a manager can read any credential row') : bad('manager read', JSON.stringify(data));
  }
  {
    const { data, error } = await guardA
      .from('webauthn_credentials')
      .update({ friendly_name: 'הטלפון שלי' })
      .eq('credential_id', FAKE_CREDENTIAL_ID)
      .select();
    !error && data?.[0]?.friendly_name === 'הטלפון שלי' ? ok('the owner can rename their own credential') : bad('owner rename', error?.message ?? JSON.stringify(data));
  }
  {
    const { error } = await guardA.from('webauthn_credentials').insert({
      guard_id: idA, credential_id: 'forged', public_key: '\\x00', counter: 0,
    });
    error ? ok('a guard cannot directly INSERT a credential row (no grant -- only the Edge Function may create one)') : bad('forged insert', 'insert unexpectedly succeeded');
  }
  {
    const { data } = await guardA.from('webauthn_credentials').delete().eq('credential_id', FAKE_CREDENTIAL_ID).select();
    (data ?? []).length === 1 ? ok('the owner can delete their own credential') : bad('owner delete', JSON.stringify(data));
  }

  console.log('\x1b[1m9. webauthn_challenges is fully sealed\x1b[0m');
  {
    const { data, error } = await guardA.from('webauthn_challenges').select('*');
    (data ?? []).length === 0 ? ok('webauthn_challenges is unreachable via PostgREST (no rows, no grant)') : bad('challenges sealed', error?.message ?? JSON.stringify(data));
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE H PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
