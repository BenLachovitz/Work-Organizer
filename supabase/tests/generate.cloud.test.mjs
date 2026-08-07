/**
 * GATE E (cloud) -- generate, verify, publish, end to end.
 *
 * Builds a throwaway week with real guards and real preferences, drives the
 * same code path the dashboard uses (buildSolverInput -> mockSolve ->
 * verifySchedule), writes the run through PostgREST as a manager, publishes it,
 * and then checks what guards can and cannot see.
 *
 * The point is to verify what was ACTUALLY STORED, not what the solver returned
 * in memory: the referee is re-run against rows read back out of the database.
 *
 *   node --experimental-strip-types supabase/tests/generate.cloud.test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

register(
  `data:text/javascript,
   const SRC = ${JSON.stringify(join(ROOT, 'src').replace(/\\\\/g, '/'))};
   export function resolve(spec, ctx, next) {
     if (spec.startsWith('@/')) {
       let p = 'file:///' + SRC + '/' + spec.slice(2);
       if (!p.endsWith('.ts') && !p.endsWith('.js')) p += '.ts';
       return next(p, ctx);
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);

const { mockSolve } = await import('@/lib/mockSolver.ts');
const { verifySchedule } = await import('@/lib/validate.ts');
const { solverInputSchema } = await import('@/lib/solverContract.ts');
const { effectiveKamut } = await import('@/lib/shifts.ts');
const { dayIndexInWeek, addDays } = await import('@/lib/dates.ts');

const env = {};
for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];

const MGR = '990401';
const GUARDS = ['990402', '990403', '990404', '990405', '990406', '990407'];
const PIN = 'Gen-12345';
const WEEK = '2026-09-13'; // a Sunday, well clear of the live weeks

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

const ALL_CODES = [MGR, ...GUARDS];

const cleanup = () => sql(`
  DELETE FROM roster_weeks WHERE week_start = '${WEEK}';
  DELETE FROM auth.users WHERE email LIKE '9904%@guards.local';
  DELETE FROM roster_codes WHERE employee_code LIKE '9904%';`);

async function setup() {
  await cleanup();
  const values = ALL_CODES.map((c) => `('${c}')`).join(', ');
  await sql(`
    INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
    VALUES ('${WEEK}', 2, NOW() + INTERVAL '20 days', 'open');

    INSERT INTO roster_codes (employee_code, display_name, initial_role)
    SELECT c.code, 'בדיקה-' || c.code,
           CASE WHEN c.code = '${MGR}' THEN 'manager'::user_role ELSE 'guard'::user_role END
      FROM (VALUES ${values}) AS c(code);

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    SELECT '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
           'authenticated', c.code || '@guards.local',
           extensions.crypt('${PIN}', extensions.gen_salt('bf')), NOW(),
           '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, NOW(), NOW(),
           '', '', '', ''
      FROM (VALUES ${values}) AS c(code);

    INSERT INTO profiles (id, employee_code, display_name, role, is_active)
    SELECT u.id, split_part(u.email,'@',1), 'בדיקה-' || split_part(u.email,'@',1),
           CASE WHEN split_part(u.email,'@',1) = '${MGR}'
                THEN 'manager'::user_role ELSE 'guard'::user_role END,
           TRUE
      FROM auth.users u WHERE u.email LIKE '9904%@guards.local';

    -- Everyone available every day on all three shifts, extending 12h on
    -- Monday and Tuesday only.
    INSERT INTO weekly_wish_preferences (guard_id, week_start, target_date, shift, allows_12h)
    SELECT p.id, '${WEEK}'::date, ('${WEEK}'::date + d), s::base_shift,
           (s IN ('morning','night') AND d IN (1,2))
      FROM profiles p
      CROSS JOIN generate_series(0,6) AS d
      CROSS JOIN unnest(ARRAY['morning','afternoon','night']) AS s
     WHERE p.employee_code LIKE '9904%';

    INSERT INTO weekly_submissions (guard_id, week_start)
    SELECT id, '${WEEK}'::date FROM profiles WHERE employee_code LIKE '9904%';

    INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
    SELECT '${WEEK}'::date, id, 4 FROM profiles WHERE employee_code LIKE '9904%';
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

async function run() {
  console.log('\n\x1b[1mGATE E (cloud) -- generate / verify / publish\x1b[0m\n');
  await setup();
  const mgr = await signedIn(MGR);

  // --- gather exactly as the dashboard does ---------------------------------
  const [{ data: guards }, { data: prefs }, { data: targets }] = await Promise.all([
    mgr.from('profiles').select('*').eq('is_active', true).like('employee_code', '9904%'),
    mgr.from('weekly_wish_preferences').select('*').eq('week_start', WEEK),
    mgr.from('weekly_guard_targets').select('*').eq('week_start', WEEK),
  ]);
  console.log(`  gathered ${guards.length} guards, ${prefs.length} preference rows\n`);

  console.log('\x1b[1m1. Build the solver input\x1b[0m');
  const input = solverInputSchema.parse({
    week_start: WEEK,
    morning_target_slots: 2,
    carry_in: {},
    guards: guards.map((g) => {
      const mine = prefs.filter((p) => p.guard_id === g.id);
      const availability = {};
      const d12 = [], n12 = [];
      for (const p of mine) {
        const d = dayIndexInWeek(WEEK, p.target_date);
        (availability[String(d)] ??= []).push(p.shift);
        if (p.allows_12h && p.shift === 'morning') d12.push(d);
        if (p.allows_12h && p.shift === 'night') n12.push(d);
      }
      const configured = targets.find((t) => t.guard_id === g.id)?.configured_kamut ?? 0;
      const days = new Set(mine.map((p) => p.target_date)).size;
      return {
        id: g.id, effective_kamut: effectiveKamut(configured, days),
        availability, twelve_hour_day: d12, twelve_hour_night: n12,
      };
    }),
  });
  // 7, not 6: the manager is an active guard too and is scheduled on the grid
  // like everyone else. role and is_active are orthogonal (spec 2.1).
  input.guards.length === ALL_CODES.length
    ? ok(`input built for all ${ALL_CODES.length} active profiles, manager included`)
    : bad('input', `${input.guards.length} guards, expected ${ALL_CODES.length}`);

  console.log('\n\x1b[1m2. Solve and verify\x1b[0m');
  const output = mockSolve(input);
  const verdict = verifySchedule(input, output);
  verdict.valid
    ? ok(`solver output is legal (${output.assignments.length} assignments)`)
    : bad('solve', verdict.violations.slice(0, 3).map((v) => v.message).join(' | '));

  console.log('\n\x1b[1m3. Persist as a draft run\x1b[0m');
  const { data: version } = await mgr.rpc('next_run_version', { p_week_start: WEEK });
  const { data: runRow, error: runErr } = await mgr.from('schedule_runs').insert({
    week_start: WEEK, version, solver_status: output.status,
    objective_value: verdict.objective, coverage_report: verdict.report,
  }).select().single();
  runErr ? bad('insert run', runErr.message) : ok(`run stored as version ${runRow.version}`);

  const { error: aErr } = await mgr.from('schedule_assignments').insert(
    output.assignments.map((a) => ({
      run_id: runRow.id, target_date: a.date, shift: a.shift, guard_id: a.guard_id,
    })),
  );
  aErr ? bad('insert assignments', aErr.message) : ok(`${output.assignments.length} assignments stored`);

  console.log('\n\x1b[1m4. Re-verify what was actually STORED\x1b[0m');
  {
    // The whole point: read the rows back and judge them again. An in-memory
    // pass proves nothing about what survived the round trip.
    const { data: stored } = await mgr
      .from('schedule_assignments').select('*').eq('run_id', runRow.id);
    const rebuilt = stored.map((a) => ({
      day: dayIndexInWeek(WEEK, a.target_date),
      date: a.target_date, shift: a.shift, guard_id: a.guard_id,
    }));
    const reVerdict = verifySchedule(input, {
      status: 'STORED', objective_value: 0, assignments: rebuilt,
      coverage_report: { floor_breaches: [], target_gaps: [], unmet_kamut: [], rest_violations: [] },
    });
    reVerdict.valid
      ? ok('rows read back from the database still satisfy every hard rule')
      : bad('stored roster', reVerdict.violations.slice(0, 3).map((v) => v.message).join(' | '));

    stored.length === output.assignments.length
      ? ok(`all ${stored.length} assignments survived the round trip`)
      : bad('round trip', `${stored.length} stored vs ${output.assignments.length} generated`);

    const clopens = reVerdict.violations.filter((v) => v.rule === 'H5' || v.rule === 'H7');
    clopens.length === 0 ? ok('no clopen in the stored roster') : bad('clopen', `${clopens.length}`);
  }

  console.log('\n\x1b[1m5. Guard visibility before publication\x1b[0m');
  const g1 = await signedIn(GUARDS[0]);
  {
    const { data } = await g1.from('schedule_runs').select('id').eq('week_start', WEEK);
    data?.length === 0 ? ok('guard cannot see the unpublished draft') : bad('draft leak', JSON.stringify(data));
  }
  {
    const { data } = await g1.from('schedule_assignments').select('id').eq('run_id', runRow.id);
    data?.length === 0 ? ok('guard cannot see draft assignments') : bad('draft assignment leak', `${data?.length}`);
  }
  {
    const { data } = await g1.from('schedule_runs')
      .update({ is_published: true }).eq('id', runRow.id).select();
    (!data || data.length === 0) ? ok('guard cannot publish the draft') : bad('guard publish', 'succeeded');
  }

  console.log('\n\x1b[1m6. Publish\x1b[0m');
  {
    const { error } = await mgr.from('schedule_runs')
      .update({ is_published: true }).eq('id', runRow.id);
    error ? bad('publish', error.message) : ok('manager publishes the roster');
  }
  {
    const { data } = await g1.from('schedule_runs').select('id,is_published').eq('week_start', WEEK);
    data?.length === 1 && data[0].is_published
      ? ok('guard now sees the published roster')
      : bad('post-publish visibility', JSON.stringify(data));
  }
  {
    const guardId = guards.find((g) => g.employee_code === GUARDS[0]).id;
    const { data } = await g1.from('schedule_assignments')
      .select('id,guard_id').eq('run_id', runRow.id);
    const mine = (data ?? []).filter((a) => a.guard_id === guardId);
    (data ?? []).length > 0 && mine.length > 0
      ? ok(`guard sees the published roster including their own ${mine.length} shifts`)
      : bad('published assignments', `${data?.length} rows, ${mine.length} own`);
  }
  {
    // Publication is per week: a second published run must be refused by the
    // partial unique index rather than quietly producing two live rosters.
    const { error } = await sql(`
      INSERT INTO schedule_runs (week_start, version, solver_status, is_published)
      VALUES ('${WEEK}', 99, 'TEST', TRUE)`).then(() => ({ error: null })).catch((e) => ({ error: e }));
    error ? ok('a second published roster for the week is rejected') : bad('double publish', 'accepted');
  }

  console.log('\n\x1b[1m7. Effective כמות was applied\x1b[0m');
  {
    // Everyone is available all 7 days with configured 4, so nothing should be
    // lowered -- and the 5-shift ceiling still caps the roster.
    const overCeiling = input.guards.filter((g) => g.effective_kamut > 5);
    const worked = new Map();
    for (const a of output.assignments) worked.set(a.guard_id, (worked.get(a.guard_id) ?? 0) + 1);
    const over = [...worked.values()].filter((n) => n > 5);
    overCeiling.length === 0 && over.length === 0
      ? ok('no guard exceeds the 5-shift weekly ceiling')
      : bad('ceiling', `${over.length} guards over 5`);
  }

  await cleanup();
  console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
    (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log('\n\x1b[32mGATE E (cloud) PASSED\x1b[0m\n');
}

run().catch(async (e) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', e.message);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
