/**
 * Hand-computed fixtures for the estimated-salary engine (src/lib/payroll.ts).
 * No Supabase dependency -- pure function in, structured breakdown out.
 *
 *   node --experimental-strip-types src/lib/payroll.test.mjs
 *
 * Same "resolve extension-less relative TS imports" loader as
 * solver/tests/compare-engines.mjs, since payroll.ts imports './dates' and
 * '../types/database' without an extension (required by the app's own
 * tsconfig -- allowImportingTsExtensions is false there).
 */
import { register } from 'node:module';

register(
  `data:text/javascript,
   export function resolve(spec, ctx, next) {
     if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[a-zA-Z]+$/.test(spec)) {
       return next(spec + '.ts', ctx);
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);

const { computePayroll } = await import('./payroll.ts');
const { addDays, israelDateTime } = await import('./dates.ts');

// An arbitrary Sunday -- every other date below is derived from it with
// addDays, so "Monday"/"Friday"/"Saturday" are guaranteed correct relative
// to each other regardless of which real-world week this actually is.
const SUNDAY = '2026-11-01';
const MONDAY = addDays(SUNDAY, 1);
const THURSDAY = addDays(SUNDAY, 4);
const FRIDAY = addDays(SUNDAY, 5);
const SATURDAY = addDays(SUNDAY, 6);

let nextId = 1;
/** A minimal WorkLogEntry -- target_date plus a real start/end instant built
 *  from israelDateTime(date, hour), the same helper the app itself uses to
 *  seed entries, so this is immune to DST/UTC-offset guesswork. `startHour`/
 *  `endHour` are hours-from-midnight on `date`, may exceed 24 (overnight). */
function entry(date, startHour, endHour) {
  const startIso = israelDateTime(date, startHour).toISOString();
  return {
    id: String(nextId++),
    guard_id: 'guard-1',
    target_date: date,
    shift: null,
    source: 'manual',
    source_assignment_id: null,
    scheduled_start: null,
    scheduled_end: null,
    actual_start: startIso,
    actual_end: israelDateTime(date, endHour).toISOString(),
    note: null,
    created_at: startIso,
    updated_at: startIso,
  };
}

const RATE = 40;
// A flat history (one rate, effective from well before any fixture date) --
// enough for every check except the rate-history-specific one below.
const FLAT_HISTORY = [{ effective_from: '2000-01-01', hourly_rate: RATE }];
let failures = 0;

function check(name, actual, expected, tolerance = 0.01) {
  const ok =
    Math.abs(actual.regularHours - expected.regularHours) <= tolerance &&
    Math.abs(actual.ot125Hours - expected.ot125Hours) <= tolerance &&
    Math.abs(actual.ot150Hours - expected.ot150Hours) <= tolerance &&
    Math.abs(actual.shabbatHours - expected.shabbatHours) <= tolerance &&
    Math.abs(actual.grossEstimate - expected.grossEstimate) <= tolerance * RATE;
  if (ok) {
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log('       expected', expected);
    console.log('       actual  ', actual);
  }
}

// 1. Plain 8h weekday: all regular, no OT, no weekend.
check(
  'plain 8h weekday',
  computePayroll([entry(MONDAY, 6.75, 14.75)], FLAT_HISTORY),
  { regularHours: 8, ot125Hours: 0, ot150Hours: 0, shabbatHours: 0, grossEstimate: 8 * RATE },
);

// 2. 12h weekday (day12-shaped): 8 regular + 2 @125% + 2 @150%.
check(
  '12h weekday (day12 split)',
  computePayroll([entry(MONDAY, 6.75, 18.75)], FLAT_HISTORY),
  {
    regularHours: 8,
    ot125Hours: 2,
    ot150Hours: 2,
    shabbatHours: 0,
    grossEstimate: (8 + 1.25 * 2 + 1.5 * 2) * RATE,
  },
);

// 3. Overnight weekday (Thursday night -> Friday morning, both well before
//    the Friday 16:00 Shabbat cutoff): attributed wholly to Thursday, 8h
//    regular, no weekend premium even though it crosses midnight.
check(
  'overnight weekday shift (Thu night -> Fri morning)',
  computePayroll([entry(THURSDAY, 22.75, 30.75)], FLAT_HISTORY),
  { regularHours: 8, ot125Hours: 0, ot150Hours: 0, shabbatHours: 0, grossEstimate: 8 * RATE },
);

// 4. Friday night -> Saturday morning: fully inside the Fri16:00-Sun00:00
//    weekend window, so all 8h move to shabbatHours at the flat 150%.
check(
  'Friday night into Saturday (full Shabbat shift)',
  computePayroll([entry(FRIDAY, 22.75, 30.75)], FLAT_HISTORY),
  { regularHours: 0, ot125Hours: 0, ot150Hours: 0, shabbatHours: 8, grossEstimate: 1.5 * 8 * RATE },
);

// 5. 10h Saturday shift: daily OT tiers (8 regular + 2 @125%) both fall
//    entirely inside the weekend window, so BOTH stack with the 150%
//    Shabbat premium -- regular/ot125 end up at 0 (reclassified into
//    shabbatHours), and the gross reflects the stacked 1.5x/1.875x rates.
check(
  '10h Saturday shift (OT stacks with Shabbat premium)',
  computePayroll([entry(SATURDAY, 6.75, 16.75)], FLAT_HISTORY),
  {
    regularHours: 0,
    ot125Hours: 0,
    ot150Hours: 0,
    shabbatHours: 10.5, // 8h*1 + 2h*1.25, pre-weighted
    grossEstimate: 1.5 * 10.5 * RATE, // = (1.5*8 + 1.875*2) * RATE = 15.75 * RATE
  },
);

// 6. Rate history: a raise effective THURSDAY must not change what MONDAY
//    (earlier in the same multi-week input) is worth -- the whole point of
//    an append-only history instead of a single current-rate setting.
{
  const RAISE_HISTORY = [
    { effective_from: '2000-01-01', hourly_rate: 40 },
    { effective_from: THURSDAY, hourly_rate: 50 },
  ];
  const result = computePayroll(
    [entry(MONDAY, 6.75, 14.75), entry(THURSDAY, 6.75, 14.75)],
    RAISE_HISTORY,
  );
  check(
    'rate change takes effect only from its date forward',
    result,
    { regularHours: 16, ot125Hours: 0, ot150Hours: 0, shabbatHours: 0, grossEstimate: 8 * 40 + 8 * 50 },
  );
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll payroll fixtures passed.\n');
