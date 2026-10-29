/**
 * Hand-computed fixtures for the estimated-salary engine (src/lib/payroll.ts).
 * No Supabase dependency -- pure function in, structured breakdown out.
 *
 *   node --experimental-strip-types src/lib/payroll.test.mjs
 *
 * Same "resolve extension-less relative TS imports" loader as
 * solver/tests/compare-engines.mjs, PLUS that same file's `@/` -> `src/`
 * alias resolution -- payroll.ts imports './dates'/'./holidays' without an
 * extension (required by the app's own tsconfig; allowImportingTsExtensions
 * is false there), and holidays.ts in turn imports '@/lib/dates'.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

register(
  `data:text/javascript,
   const SRC = ${JSON.stringify(SRC)};
   export function resolve(spec, ctx, next) {
     if (spec.startsWith('@/')) {
       return next('file:///' + SRC + '/' + spec.slice(2) + '.ts', ctx);
     }
     if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[a-zA-Z]+$/.test(spec)) {
       return next(spec + '.ts', ctx);
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);

const { computePayroll, quarterlyLeaveDayValue, consecutiveSickDayCount, sickPayPercent } =
  await import('./payroll.ts');
const { addDays, israelDateTime } = await import('./dates.ts');

// An arbitrary Sunday -- every other date below is derived from it with
// addDays, so "Monday"/"Friday"/"Saturday" are guaranteed correct relative
// to each other regardless of which real-world week this actually is.
const SUNDAY = '2026-11-01';
const MONDAY = addDays(SUNDAY, 1);
const THURSDAY = addDays(SUNDAY, 4);
const FRIDAY = addDays(SUNDAY, 5);
const SATURDAY = addDays(SUNDAY, 6);

// Real Gregorian dates for Rosh Hashanah 5786 (confirmed via hebcal's own
// hebrew2abs/abs2greg): day 1 is Tue 2025-09-23, day 2 is Wed 2025-09-24 --
// both ordinary weekdays, so these fixtures test the HOLIDAY logic in
// isolation from the already-tested Friday/Saturday weekend logic.
const RH_EVE = '2025-09-22'; // Monday -- the day before RH day 1
const RH_DAY_2 = '2025-09-24'; // Wednesday -- RH day 2 itself

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
    Math.abs(actual.hours100 - expected.hours100) <= tolerance &&
    Math.abs(actual.hours125 - expected.hours125) <= tolerance &&
    Math.abs(actual.hours150 - expected.hours150) <= tolerance &&
    Math.abs(actual.hours175 - expected.hours175) <= tolerance &&
    Math.abs(actual.hours200 - expected.hours200) <= tolerance &&
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

// 1. Plain 8h weekday: all at 100%, no OT, no rest-day premium.
check(
  'plain 8h weekday',
  computePayroll([entry(MONDAY, 6.75, 14.75)], FLAT_HISTORY),
  { hours100: 8, hours125: 0, hours150: 0, hours175: 0, hours200: 0, grossEstimate: 8 * RATE },
);

// 2. 12h weekday (day12-shaped): 8 @100% + 2 @125% + 2 @150%.
check(
  '12h weekday (day12 split)',
  computePayroll([entry(MONDAY, 6.75, 18.75)], FLAT_HISTORY),
  {
    hours100: 8,
    hours125: 2,
    hours150: 2,
    hours175: 0,
    hours200: 0,
    grossEstimate: (8 + 1.25 * 2 + 1.5 * 2) * RATE,
  },
);

// 3. Overnight shift (Thursday 22:45 -> Friday 06:45): 7.25h of it falls
//    inside 22:00-06:00, so this IS a night shift (7h standard day, not 8)
//    even though it's a plain weekday -- 7h @100% + 1h @125%, still no
//    rest-day premium (well before the Friday 16:00 cutoff).
check(
  'overnight weekday shift is a NIGHT shift (7h day, not 8h)',
  computePayroll([entry(THURSDAY, 22.75, 30.75)], FLAT_HISTORY),
  { hours100: 7, hours125: 1, hours150: 0, hours175: 0, hours200: 0, grossEstimate: (7 + 1.25) * RATE },
);

// 4. Friday night -> Saturday morning: a night shift (7h day) AND fully
//    inside the Fri16:00-Sun00:00 rest-day window. 7h @150% (the rest-day
//    base, same bucket a weekday's own 2nd OT tier would use) + 1h @175%
//    (150%+25pp, additive -- not 150%x1.25=187.5%).
check(
  'Friday night into Saturday (night shift + Shabbat, additive stacking)',
  computePayroll([entry(FRIDAY, 22.75, 30.75)], FLAT_HISTORY),
  {
    hours100: 0,
    hours125: 0,
    hours150: 7,
    hours175: 1,
    hours200: 0,
    grossEstimate: (1.5 * 7 + 1.75 * 1) * RATE,
  },
);

// 5. 10h Saturday shift (daytime, not a night shift -- no overlap with
//    22:00-06:00): 8h @150% (rest-day base) + 2h @175% (150%+25pp).
check(
  '10h Saturday shift (day shift, OT stacks ADDITIVELY with Shabbat)',
  computePayroll([entry(SATURDAY, 6.75, 16.75)], FLAT_HISTORY),
  {
    hours100: 0,
    hours125: 0,
    hours150: 8,
    hours175: 2,
    hours200: 0,
    grossEstimate: (1.5 * 8 + 1.75 * 2) * RATE,
  },
);

// 5b. The user's own example: a 12h night shift on an ordinary weekday
//     (Monday 18:45 -> Tuesday 06:45) -- 7h @100%, hours 8-9 @125%,
//     hours 10-12 @150%. No rest day involved at all.
check(
  '12h Monday night shift (7h/2h/3h split, the reported-law example)',
  computePayroll([entry(MONDAY, 18.75, 30.75)], FLAT_HISTORY),
  {
    hours100: 7,
    hours125: 2,
    hours150: 3,
    hours175: 0,
    hours200: 0,
    grossEstimate: (7 + 1.25 * 2 + 1.5 * 3) * RATE,
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
    {
      hours100: 16,
      hours125: 0,
      hours150: 0,
      hours175: 0,
      hours200: 0,
      grossEstimate: 8 * 40 + 8 * 50,
    },
  );
}

// 7. A major holiday (Rosh Hashanah day 2, an ordinary Wednesday) carries
//    the same rest-day premium as Shabbat even though it is NOT a
//    Friday/Saturday: a plain 8h day shift lands entirely at 150%.
check(
  'major holiday (Rosh Hashanah day 2) gets the rest-day premium',
  computePayroll([entry(RH_DAY_2, 6.75, 14.75)], FLAT_HISTORY),
  { hours100: 0, hours125: 0, hours150: 8, hours175: 0, hours200: 0, grossEstimate: 1.5 * 8 * RATE },
);

// 8. The EVE of a major holiday, from 16:00, also carries the premium --
//    same "starts the evening before" shape as Shabbat. A 4h evening
//    shift the day before Rosh Hashanah (18:00-22:00, entirely after the
//    16:00 cutoff) is fully at 150%, even though that calendar day itself
//    is an ordinary Monday.
check(
  'the evening before a major holiday (erev) also gets the premium',
  computePayroll([entry(RH_EVE, 18, 22)], FLAT_HISTORY),
  { hours100: 0, hours125: 0, hours150: 4, hours175: 0, hours200: 0, grossEstimate: 1.5 * 4 * RATE },
);

// 9. sickPayPercent: Israeli Sick Pay Law's 0% / 50% / 100% tiers.
{
  const cases = [[1, 0], [2, 0.5], [3, 0.5], [4, 1], [5, 1]];
  let ok = true;
  for (const [day, expected] of cases) {
    if (sickPayPercent(day) !== expected) {
      ok = false;
      console.log(`       sickPayPercent(${day}) = ${sickPayPercent(day)}, expected ${expected}`);
    }
  }
  if (ok) console.log('  \x1b[32mok\x1b[0m   sickPayPercent day-tier mapping (1/2/3/4/5 -> 0/.5/.5/1/1)');
  else {
    failures++;
    console.log('  \x1b[31mFAIL\x1b[0m sickPayPercent day-tier mapping');
  }
}

// 10. consecutiveSickDayCount: counts backward through a run, stops at a
//     gap -- a guard sick Mon-Wed, back at work Thu, sick again Fri should
//     NOT see Friday as day 4 of the earlier run.
{
  const sickDates = new Set([MONDAY, addDays(MONDAY, 1), addDays(MONDAY, 2), addDays(MONDAY, 4)]);
  const cases = [
    [MONDAY, 1],
    [addDays(MONDAY, 1), 2],
    [addDays(MONDAY, 2), 3],
    [addDays(MONDAY, 3), 0], // Thursday: not sick, gap
    [addDays(MONDAY, 4), 1], // Friday: sick again, but the run restarts
  ];
  let ok = true;
  for (const [date, expected] of cases) {
    const actual = consecutiveSickDayCount(sickDates, date);
    if (actual !== expected) {
      ok = false;
      console.log(`       consecutiveSickDayCount(${date}) = ${actual}, expected ${expected}`);
    }
  }
  if (ok) console.log('  \x1b[32mok\x1b[0m   consecutiveSickDayCount stops at a gap and restarts after it');
  else {
    failures++;
    console.log('  \x1b[31mFAIL\x1b[0m consecutiveSickDayCount');
  }
}

function checkValue(name, actual, expected, tolerance = 0.01) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: expected ${expected}, got ${actual}`);
  }
}

// 11. quarterlyLeaveDayValue: Israeli Annual Leave Law's hourly/daily-
//     worker formula -- total gross earnings / a FIXED 75 (3 months x 25
//     standard workdays, 6-day work week), never divided by how many days
//     were actually worked. A single plain 8h day (gross 320) divided by
//     the fixed 75, NOT by 1 worked day -- this is the whole point of the
//     fixed divisor: it comes out much lower than "320 per worked day".
checkValue(
  'quarterlyLeaveDayValue divides by the FIXED 75, not by days worked',
  quarterlyLeaveDayValue([entry(MONDAY, 6.75, 14.75)], FLAT_HISTORY),
  (8 * RATE) / 75,
);

// 12. Multiple worked days SUM their gross first -- three plain 8h days
//     (960 total) / 75, not an average of the three days' own values.
checkValue(
  'quarterlyLeaveDayValue sums every worked day before dividing',
  quarterlyLeaveDayValue(
    [entry(MONDAY, 6.75, 14.75), entry(THURSDAY, 6.75, 14.75), entry(SATURDAY, 6.75, 14.75)],
    FLAT_HISTORY,
  ),
  (8 * RATE + 8 * RATE + 1.5 * 8 * RATE) / 75, // Saturday's 8h is at the 150% rest-day base
);

// 13. Unlike the two earlier (superseded) attempts, overtime and Shabbat
//     premiums ARE included in the total here -- this is real total
//     earnings per the legal formula, not a "regular wage only" figure.
//     A 12h Saturday shift (8h@150% + 2h@175% + 2h@200% = 780 gross, from
//     the already-tested overtime engine) contributes its full 780, not a
//     capped-at-8h, no-premium figure.
checkValue(
  'quarterlyLeaveDayValue includes real overtime/Shabbat premiums in the total',
  quarterlyLeaveDayValue([entry(SATURDAY, 6.75, 18.75)], FLAT_HISTORY),
  ((8 * 1.5 + 2 * 1.75 + 2 * 2.0) * RATE) / 75, // 780 / 75 = 10.4
);

// 14. quarterlyLeaveDayValue with no entries at all returns 0 (nothing to
//     value an absence against yet), rather than NaN or throwing.
{
  const value = quarterlyLeaveDayValue([], FLAT_HISTORY);
  if (value === 0) {
    console.log('  \x1b[32mok\x1b[0m   quarterlyLeaveDayValue([]) is 0, not NaN');
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m quarterlyLeaveDayValue([]) expected 0, got ${value}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll payroll fixtures passed.\n');
