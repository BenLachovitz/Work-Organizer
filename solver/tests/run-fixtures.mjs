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

  if (file.startsWith('12-')) {
    // capped_guard explicitly requested fewer shifts than configured
    // (max_shifts: 1) and is the ONLY guard available on day 0 or day 1 --
    // assigning him both would trivially clear two S1 floor breaches (each
    // worth 1000), the strongest possible incentive to exceed the cap. The
    // hard per-guard H4 ceiling must win anyway: this is exactly the bug a
    // real guard hit in production (requested 1, was assigned 2).
    const worked = output.assignments.filter((a) => a.guard_id === 'capped_guard');
    worked.length <= 1
      ? ok(`guard-requested ceiling holds even when coverage would reward breaking it (${worked.length} shift(s))`)
      : bad('guard shift ceiling', `capped_guard assigned ${worked.length} shifts, requested max was 1`);

    const s1Breaches = verdict.report.floor_breaches.filter(
      (b) => b.day <= 1 && b.segment === 'S1',
    );
    s1Breaches.length === 1
      ? ok('the day the ceiling blocked him shows up as a genuine floor breach, not a silently absorbed cost')
      : bad('guard shift ceiling', `expected exactly 1 S1 floor breach across days 0-1, got ${s1Breaches.length}`);
  }

  if (file.startsWith('13-')) {
    // sixth_shift_guard is configured at 5 (the ordinary ceiling) and asked
    // for a 6th; they are also the ONLY guard available for S1 on days 0-5,
    // so all 6 floors can only close through them -- proves max_shifts=6
    // actually lets the solver reach 6 (the CP-SAT domain-bound class of bug
    // a naive per-guard H4 change could reintroduce).
    const sixth = output.assignments.filter((a) => a.guard_id === 'sixth_shift_guard');
    sixth.length === 6
      ? ok('a guard configured at 5 who explicitly asked for a 6th shift can actually reach it')
      : bad('sixth shift grant', `sixth_shift_guard assigned ${sixth.length} shifts, expected 6`);

    // capped_at_five requested 5 (not 6) and is under IDENTICAL temptation
    // (sole coverage for S4 on the same 6 days) -- not being configured at 5
    // means max_shifts stayed 5, so one night floor must go unfilled rather
    // than let them sneak past the ordinary ceiling too.
    const capped = output.assignments.filter((a) => a.guard_id === 'capped_at_five');
    capped.length <= 5
      ? ok(`the 6th-shift allowance stays exclusive to a guard configured at 5 (capped_at_five: ${capped.length} shift(s))`)
      : bad('sixth shift exclusivity', `capped_at_five assigned ${capped.length} shifts, ceiling was 5`);

    const s4Breaches = verdict.report.floor_breaches.filter(
      (b) => b.day <= 5 && b.segment === 'S4',
    );
    s4Breaches.length === 1
      ? ok('the un-eligible guard hitting their real ceiling shows up as a genuine floor breach')
      : bad('sixth shift exclusivity', `expected exactly 1 S4 floor breach across days 0-5, got ${s4Breaches.length}`);
  }

  if (file.startsWith('14-')) {
    // 3 guards, all morning-available Mon-Fri, kamut 5 each (maximum pressure
    // to work every marked day). Baseline target is 2; Thu/Fri (days 4,5) are
    // overridden to 3. Mon-Wed must never exceed 2 (H6 -- the override must
    // not leak outside its days), and Thu/Fri must actually reach 3.
    const s1Count = (d) => output.assignments.filter((a) => a.day === d && a.shift === 'morning').length;

    const overCap = [1, 2, 3].filter((d) => s1Count(d) > 2);
    overCap.length === 0
      ? ok("non-overridden weekdays (Mon-Wed) stay capped at the week's baseline target of 2")
      : bad('per-day override leak', `days ${overCap.join(', ')} exceeded 2 despite no override`);

    const raised = [4, 5].filter((d) => s1Count(d) === 3);
    raised.length === 2
      ? ok('both overridden days (Thu, Fri) actually reach the raised target of 3')
      : bad('per-day override', `only days ${JSON.stringify(raised)} of [4, 5] reached 3`);
  }

  if (file.startsWith('15-')) {
    // anchor_s1/anchor_s4 each guarantee one segment's floor; flexible could
    // close either segment's remaining target gap, and both segments are
    // otherwise perfectly symmetric -- only the morning_priority bonus (set
    // to 1 in this fixture's weights) should break the tie toward morning.
    const flexible = output.assignments.find((a) => a.guard_id === 'flexible')?.shift;
    flexible === 'morning'
      ? ok('morning_priority bonus wins an otherwise perfect S1-vs-S4 coverage tie')
      : bad('morning-priority tie-break', `flexible assigned ${JSON.stringify(flexible)}, expected 'morning'`);
  }

  console.log(`    ${summarise(verdict.report).join(' · ')}\n`);
}

// --- referee-only check: coverage-occupying placeholders (§12.9, migration 52) ---
//
// A placeholder (guard_id: null) is never produced by either engine -- it only
// ever exists as a manual edit -- so no golden fixture above can exercise it;
// every fixture's `output` comes straight from mockSolve(). This hand-builds
// a SolverOutput instead, reusing fixture 02's already-valid input (every
// guard at effective_kamut 0 with zero availability, morning_target_slots 2,
// so day 0 (Sunday)'s S1 floor is 1 and target is 2 -- see segmentFloors()).
{
  console.log('\x1b[1mreferee-only: placeholder marked occupies_slot\x1b[0m');
  const raw = JSON.parse(await readFile(join(dir, '02-all-empty.json'), 'utf8'));
  const input = solverInputSchema.parse(raw);
  const output = solverOutputSchema.parse({
    status: 'EDITED',
    objective_value: 0,
    assignments: [{ day: 0, date: input.week_start, shift: 'morning', guard_id: null }],
    coverage_report: { floor_breaches: [], target_gaps: [], unmet_kamut: [], rest_violations: [] },
  });
  const verdict = verifySchedule(input, output);

  verdict.violations.length === 0
    ? ok('a coverage-occupying placeholder triggers no H1-H7 violation')
    : bad('placeholder hard rules', verdict.violations.map((v) => `${v.rule}: ${v.message}`).join(' | '));

  // S1/day0's floor is 1 -- one placeholder should be enough to resolve it
  // outright, proving it counts as real coverage even with no guard behind it.
  const floorStillBreached = verdict.report.floor_breaches.some((b) => b.day === 0 && b.segment === 'S1');
  !floorStillBreached
    ? ok('the placeholder alone closes the S1/day0 floor breach (floor is 1)')
    : bad('placeholder floor resolution', 'S1/day0 still reported as a floor breach');

  // S1/day0's target is 2 -- still short by one, but assigned should now read
  // 1, not 0, showing the placeholder was actually counted rather than the
  // floor coincidentally clearing some other way.
  const s1Target = verdict.report.target_gaps.find((b) => b.day === 0 && b.segment === 'S1');
  s1Target && s1Target.assigned === 1
    ? ok(`the placeholder counts toward S1/day0 coverage (assigned: ${s1Target.assigned}, target: ${s1Target.target})`)
    : bad('placeholder coverage count', JSON.stringify(s1Target));

  verdict.report.unmet_kamut.length === 0
    ? ok('the placeholder is attributed to no guard, so no כמות is affected')
    : bad('placeholder kamut leak', JSON.stringify(verdict.report.unmet_kamut));
}

console.log(`\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
  (failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : '0 failed'));
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\n\x1b[32mGATE E (mock) PASSED\x1b[0m\n');
