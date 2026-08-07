/**
 * READ-ONLY preview of what "צור סידור" would produce for a week.
 *
 * Reads the real rows, builds the solver input exactly as the dashboard does,
 * solves and verifies -- and writes nothing. Useful for seeing the outcome
 * before committing a draft, and for checking that the data loaded correctly.
 *
 *   node --experimental-strip-types supabase/tests/preview-week.mjs [week_start]
 */

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
const { verifySchedule, summarise } = await import('@/lib/validate.ts');
const { solverInputSchema } = await import('@/lib/solverContract.ts');
const { effectiveKamut } = await import('@/lib/shifts.ts');
const { dayIndexInWeek } = await import('@/lib/dates.ts');

const env = {};
for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];
const WEEK = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-08-09';

const sql = async (query) => {
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
};

const HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const week = (await sql(`SELECT morning_target_slots t FROM roster_weeks WHERE week_start='${WEEK}'`))[0];
const guards = await sql(`SELECT id, display_name FROM profiles WHERE is_active ORDER BY employee_code`);
const prefs = await sql(`SELECT guard_id, target_date::text, shift::text, allows_12h FROM weekly_wish_preferences WHERE week_start='${WEEK}'`);
const targets = await sql(`SELECT guard_id, configured_kamut FROM weekly_guard_targets WHERE week_start='${WEEK}'`);

const input = solverInputSchema.parse({
  week_start: WEEK,
  morning_target_slots: week.t,
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
      id: g.id,
      display_name: g.display_name,
      effective_kamut: effectiveKamut(configured, days),
      availability,
      twelve_hour_day: d12,
      twelve_hour_night: n12,
    };
  }),
});

const out = mockSolve(input);
const v = verifySchedule(input, out);
const nameOf = (id) => guards.find((g) => g.id === id)?.display_name ?? '?';
const on = (d) => out.assignments.filter((a) => a.day === d);

const cell = (d, block) => {
  const day = on(d);
  if (block === 'm')
    return day.filter((a) => a.shift === 'morning' || a.shift === 'day12')
      .map((a) => nameOf(a.guard_id) + (a.shift === 'day12' ? ' עד18:45' : '')).join(', ') || '—';
  if (block === 'n')
    return day.filter((a) => a.shift === 'night' || a.shift === 'night12')
      .map((a) => nameOf(a.guard_id) + (a.shift === 'night12' ? ' מ18:45' : '')).join(', ') || '—';
  const full = day.filter((a) => a.shift === 'afternoon');
  const early = day.filter((a) => a.shift === 'day12');
  const late = day.filter((a) => a.shift === 'night12');
  const rows = full.map((a) => nameOf(a.guard_id));
  for (let i = 0; i < Math.max(early.length, late.length); i++)
    rows.push(`${early[i] ? nameOf(early[i].guard_id) : '(ריק)'}/${late[i] ? nameOf(late[i].guard_id) : '(ריק)'}`);
  return rows.join(', ') || '—';
};

console.log(`\nPREVIEW -- week ${WEEK}, morning target ${week.t} (nothing was written)\n`);
const w = 26;
console.log('          ' + HE.map((h) => h.padEnd(w)).join(''));
for (const [k, label] of [['m', 'בוקר     '], ['a', 'צהריים   '], ['n', 'לילה     ']])
  console.log(label + ' ' + [0, 1, 2, 3, 4, 5, 6].map((d) => cell(d, k).padEnd(w)).join(''));

console.log('\nshifts per guard:');
const worked = new Map();
for (const a of out.assignments) worked.set(a.guard_id, (worked.get(a.guard_id) ?? 0) + 1);
for (const g of input.guards) {
  const n = worked.get(g.id) ?? 0;
  const mark = n < g.effective_kamut ? `  <- short of ${g.effective_kamut}` : '';
  console.log(`  ${(g.display_name ?? '?').padEnd(10)} ${n} / ${g.effective_kamut}${mark}`);
}

console.log(`\nassignments: ${out.assignments.length}   objective: ${v.objective}   hard-rule violations: ${v.violations.length}`);
console.log('report: ' + summarise(v.report).join(' · '));
if (v.report.floor_breaches.length) {
  console.log('\nfloor breaches (nobody can cover these):');
  for (const b of v.report.floor_breaches)
    console.log(`  ${HE[b.day]} · ${b.segment} — ${b.assigned}/${b.required}`);
}
