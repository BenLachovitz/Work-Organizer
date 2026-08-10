/**
 * GATE E (mock) -- runs every golden fixture through the TypeScript mock solver
 * and judges the result with the independent verifier.
 *
 * The same fixtures are run against the Python CP-SAT engine by
 * solver/tests/test_scheduler.py, and both are held to the same rules. That
 * shared set is what stops the two engines drifting apart.
 *
 *   node solver/tests/run-fixtures.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// Resolve the '@/...' alias that the app source uses.
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
const { solverInputSchema, solverOutputSchema } = await import('@/lib/solverContract.ts');

let passed = 0;
const failures = [];
const ok = (l) => { passed++; console.log(`    \x1b[32mPASS\x1b[0m  ${l}`); };
const bad = (l, d) => { failures.push(`${l} -- ${d}`); console.log(`    \x1b[31mFAIL\x1b[0m  ${l}\n          ${d}`); };

const dir = join(HERE, 'fixtures');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

console.log('\n\x1b[1mGATE E (mock) -- golden fixtures\x1b[0m\n');

for (const file of files) {
  const raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
  console.log(`\x1b[1m${file}\x1b[0m`);

  // Contract check first: a fixture that does not parse is a contract break.
  const parsed = solverInputSchema.safeParse(raw);
  if (!parsed.success) {
    bad(`${file} parses against the contract`, JSON.stringify(parsed.error.issues.slice(0, 2)));
    continue;
  }
  ok('input parses against the contract');

  const input = parsed.data;
  const started = Date.now();
  const output = mockSolve(input);
  const ms = Date.now() - started;

  const outParsed = solverOutputSchema.safeParse(output);
  outParsed.success
    ? ok('output parses against the contract')
    : bad('output parses', JSON.stringify(outParsed.error.issues.slice(0, 2)));

  // The verifier is the referee: it re-derives everything from the input.
  const verdict = verifySchedule(input, output);
  if (verdict.valid) {
    ok(`no hard-rule violations (${output.assignments.length} assignments, ${ms}ms)`);
  } else {
    bad('hard rules', verdict.violations.slice(0, 4).map((v) => `${v.rule}: ${v.message}`).join(' | '));
  }

  // The solver must not flatter itself: its self-reported report and score have
  // to match what the referee computes.
  JSON.stringify(output.coverage_report) === JSON.stringify(verdict.report)
    ? ok('self-reported coverage matches the verifier')
    : bad('coverage report', 'solver report disagrees with the verifier');

  output.objective_value === verdict.objective
    ? ok(`objective agrees (${verdict.objective})`)
    : bad('objective', `solver says ${output.objective_value}, verifier says ${verdict.objective}`);

  // --- fixture-specific expectations ---------------------------------------
  if (file.startsWith('02-')) {
    output.assignments.length === 0
      ? ok('empty week produces no assignments rather than inventing them')
      : bad('empty week', `${output.assignments.length} assignments from zero availability`);
    verdict.report.floor_breaches.length === 28
      ? ok('all 28 floor breaches reported (7 days x 4 segments)')
      : bad('empty week floors', `${verdict.report.floor_breaches.length} breaches`);
  }

  if (file.startsWith('03-')) {
    output.assignments.length <= 5
      ? ok(`5-shift ceiling respected (${output.assignments.length} shifts)`)
      : bad('ceiling', `${output.assignments.length} shifts for one guard`);
    const days = new Set(output.assignments.map((a) => a.day));
    days.size === output.assignments.length
      ? ok('no day double-booked')
      : bad('one shift per day', `${output.assignments.length} shifts across ${days.size} days`);
  }

  if (file.startsWith('04-')) {
    // This fixture runs at morning target 3. The raised target applies Mon-Fri
    // only, so Saturday (6) and Sunday (0) must still cap at 2 -- and a working
    // day must actually reach 3, or the rule is being applied everywhere.
    const s1 = (d) =>
      output.assignments.filter(
        (a) => a.day === d && (a.shift === 'morning' || a.shift === 'day12'),
      ).length;
    const weekendOver = [0, 6].filter((d) => s1(d) > 2);
    weekendOver.length === 0
      ? ok('weekend morning capped at 2 despite the week being set to 3')
      : bad('weekend cap', `days ${weekendOver.join(', ')} exceeded 2 in the morning`);

    const weekdaysAt3 = [1, 2, 3, 4, 5].filter((d) => s1(d) === 3);
    weekdaysAt3.length > 0
      ? ok(`weekdays do reach the raised target (${weekdaysAt3.length} of 5 at 3)`)
      : bad('weekday target', 'no working day reached 3 -- target 3 is not applied at all');
  }

  if (file.startsWith('05-')) {
    const byGuard = new Map();
    for (const a of output.assignments) {
      const list = byGuard.get(a.guard_id) ?? [];
      list.push(a);
      byGuard.set(a.guard_id, list);
    }
    let clopens = 0;
    for (const list of byGuard.values()) {
      const byDay = new Map(list.map((a) => [a.day, a.shift]));
      for (let d = 0; d < 6; d++) {
        const a = byDay.get(d);
        const b = byDay.get(d + 1);
        if ((a === 'night' || a === 'night12') && (b === 'morning' || b === 'day12')) clopens++;
      }
    }
    clopens === 0
      ? ok('no clopen produced even when only night+morning were offered')
      : bad('clopen trap', `${clopens} night -> next-morning pairs`);
  }

  if (file.startsWith('06-')) {
    const twelve = output.assignments.filter((a) => a.shift === 'day12' || a.shift === 'night12');
    twelve.length > 0
      ? ok(`12h shifts used where opted in (${twelve.length})`)
      : bad('12h', 'no extended shifts scheduled despite opt-ins');
  }

  if (file.startsWith('08-')) {
    // Everyone is available all week but will only extend on Monday and
    // Tuesday. An engine that still reads the opt-in as week-level would
    // schedule 12h shifts on other days and fail here.
    const extended = output.assignments.filter(
      (a) => a.shift === 'day12' || a.shift === 'night12',
    );
    const strays = extended.filter((a) => a.day !== 1 && a.day !== 2);
    strays.length === 0
      ? ok(`12h shifts confined to the opted-in days (${extended.length} on Mon/Tue)`)
      : bad('per-day opt-in', `${strays.length} extended shifts outside Mon/Tue`);
    extended.length > 0
      ? ok('12h shifts still used on the days that were opted in')
      : bad('per-day opt-in', 'no 12h shift scheduled at all -- opt-in ignored entirely');
  }

  if (file.startsWith('07-')) {
    const sunday = new Map(
      output.assignments.filter((a) => a.day === 0).map((a) => [a.guard_id, a.shift]),
    );
    const bad1 = ['g1', 'g2'].filter(
      (g) => sunday.get(g) === 'morning' || sunday.get(g) === 'day12',
    );
    bad1.length === 0
      ? ok('Saturday-night guards are not given Sunday morning (carry-in honoured)')
      : bad('carry-in', `${bad1.join(', ')} scheduled Sunday morning after a night shift`);
  }

  if (file.startsWith('09-')) {
    // Capacity is exactly one guard-shift short of full day-0 coverage, and
    // (verified by hand) leaving an 8h segment (S1/S4) short scores
    // identically to leaving a 4h one (S2/S3) under a flat per-slot count --
    // segmentWeight() is what breaks that tie correctly.
    const day0Gap = verdict.report.target_gaps.find((g) => g.day === 0)?.segment;
    day0Gap === 'S2' || day0Gap === 'S3'
      ? ok(`the unavoidable gap lands on the cheaper 4h segment (${day0Gap})`)
      : bad('segment weighting', `gap landed on ${JSON.stringify(day0Gap)}, expected S2 or S3`);
  }

  if (file.startsWith('10-')) {
    // morning and night are otherwise perfectly symmetric (same floor/target
    // closure, same kamut contribution, no rest neighbours) -- only the
    // עדיפות mark on night breaks the tie.
    const solo = output.assignments.find((a) => a.guard_id === 'solo')?.shift;
    solo === 'night'
      ? ok('preferred slot (night) wins an otherwise perfect coverage tie')
      : bad('preference tie-break', `solo assigned ${JSON.stringify(solo)}, expected 'night'`);
  }

  if (file.startsWith('11-')) {
    const assignedIds = new Set(output.assignments.map((a) => a.guard_id));

    // Day 1: decoy_s1_day1 always fills the floor (guaranteed, not the thing
    // under test) -- the CONTESTED slot is the remaining target-2 spot
    // between wants_more and at_kamut, same coverage value either way, only
    // the stretch bonus differs.
    assignedIds.has('wants_more') && !assignedIds.has('at_kamut')
      ? ok('stretch bonus wins a genuine tie for the extra slot (wants_more over at_kamut)')
      : bad(
          'stretch tie-break',
          `wants_more assigned=${assignedIds.has('wants_more')}, at_kamut assigned=${assignedIds.has('at_kamut')}`,
        );

    // Day 4: would_cost_rest could extend from 1 to 2 shifts, but only via an
    // 8h-penalised afternoon(day3)->morning(day4) transition; decoy_no_rest
    // contests the same last slot for free. stretch(1) must not outweigh
    // rest8(5).
    const worked = output.assignments.filter((a) => a.guard_id === 'would_cost_rest');
    worked.length === 1 && worked[0].day === 3
      ? ok('stretch bonus does not outweigh an 8h-rest penalty (would_cost_rest stays at 1 shift)')
      : bad(
          'stretch vs rest8',
          `would_cost_rest has ${worked.length} shift(s) on day(s) ${JSON.stringify(worked.map((a) => a.day))}`,
        );

    assignedIds.has('decoy_no_rest')
      ? ok('the rest-free alternative fills the slot instead')
      : bad('stretch vs rest8 alternative', 'decoy_no_rest was not assigned');
  }

  console.log(`    ${summarise(verdict.report).join(' · ')}\n`);
}

console.log(`\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
  (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\n\x1b[32mGATE E (mock) PASSED\x1b[0m\n');
