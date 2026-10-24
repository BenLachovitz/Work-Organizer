/**
 * GATE B (client) -- exercises the exact supabase-js path AuthContext uses.
 *
 * Gate B tested the Edge Function over raw fetch. This tests the SDK layer the
 * browser actually runs: functions.invoke, signInWithPassword, and the profile
 * read through RLS -- including that a non-2xx surfaces the function's Hebrew
 * message rather than supabase-js's generic "non-2xx status code".
 *
 *   node supabase/tests/client.cloud.test.mjs
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

const CODE = '990009';
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
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error((await res.json())?.message ?? res.status);
  return res.json();
}

const cleanup = () => sql(`
  DELETE FROM auth.users WHERE email = '${CODE}@guards.local';
  DELETE FROM roster_codes WHERE employee_code = '${CODE}';
  DELETE FROM claim_attempts WHERE employee_code = '${CODE}';`);

// --- mirror of AuthContext.invokeClaimCode ---------------------------------
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function invokeClaimCode(body) {
  const { data, error } = await supabase.functions.invoke('claim-code', { body });
  if (!error) return data;
  const ctx = error.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = await ctx.json();
      if (parsed?.error) throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e;
    }
  }
  throw new Error('שגיאת תקשורת. נסה שוב.');
}

async function run() {
  console.log('\n\x1b[1mGATE B (client) -- supabase-js path used by the browser\x1b[0m\n');
  await cleanup();
  await sql(`INSERT INTO roster_codes (employee_code, display_name, initial_role)
             VALUES ('${CODE}', 'בדיקת-לקוח', 'guard')`);

  {
    const s = await invokeClaimCode({ action: 'status', employee_code: CODE });
    s.exists && !s.claimed && s.displayName === 'בדיקת-לקוח'
      ? ok('functions.invoke status -> {exists, claimed:false, displayName}')
      : bad('status via SDK', JSON.stringify(s));
  }
  {
    await invokeClaimCode({ action: 'claim', employee_code: CODE, pin: PIN });
    ok('functions.invoke claim succeeds');
  }
  {
    // The critical check: a 409 must surface the function's Hebrew text, not
    // supabase-js's generic message.
    try {
      await invokeClaimCode({ action: 'claim', employee_code: CODE, pin: PIN });
      bad('error surfacing', 'second claim did not throw');
    } catch (e) {
      /non-2xx/i.test(e.message)
        ? bad('error surfacing', `leaked generic SDK message: "${e.message}"`)
        : e.message.includes('כבר רשום')
          ? ok(`non-2xx surfaces the server message: "${e.message}"`)
          : bad('error surfacing', `unexpected: "${e.message}"`);
    }
  }
  {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: `${CODE}@guards.local`, password: PIN,
    });
    if (error || !data.session) bad('signInWithPassword', error?.message ?? 'no session');
    else {
      ok('signInWithPassword returns a session');
      const { data: profile, error: pErr } = await supabase
        .from('profiles').select('*').eq('id', data.user.id).single();
      profile && profile.employee_code === CODE && profile.role === 'guard'
        ? ok('profile loads through RLS with the session JWT')
        : bad('profile load', pErr?.message ?? JSON.stringify(profile));

      const { data: codes } = await supabase.from('roster_codes').select('employee_code');
      Array.isArray(codes) && codes.length === 0
        ? ok('signed-in guard still reads 0 badge codes')
        : bad('roster_codes leak', JSON.stringify(codes)?.slice(0, 120));

      await supabase.auth.signOut();
      ok('signOut clears the session');
    }
  }
  {
    const s = await invokeClaimCode({ action: 'status', employee_code: CODE });
    s.claimed === true ? ok('status reports claimed -> login shows the PIN step') : bad('claimed state', JSON.stringify(s));
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE B (client) PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
