/**
 * Hand-computed fixtures for isShiftActiveAt() (src/lib/shifts.ts) -- the
 * "who's on shift right now" homepage card's one piece of new time logic.
 * No Supabase dependency -- pure function in, boolean out.
 *
 *   node --experimental-strip-types src/lib/shifts.test.mjs
 *
 * Same "resolve extension-less relative TS imports" loader as
 * payroll.test.mjs -- shifts.ts imports './dates' without an extension
 * (required by the app's own tsconfig; allowImportingTsExtensions is false
 * there).
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

const { isShiftActiveAt } = await import('./shifts.ts');
const { addDays, israelDateTime } = await import('./dates.ts');

// An arbitrary Sunday -- every other date below is derived from it with
// addDays, so "Monday"/"Tuesday" are guaranteed correct relative to each
// other regardless of which real-world week this actually is.
const SUNDAY = '2026-11-01';
const MONDAY = addDays(SUNDAY, 1);
const TUESDAY = addDays(SUNDAY, 2);

let failures = 0;

function checkValue(name, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} -- expected ${expected}, got ${actual}`);
  }
}

/** A real instant on `date` at `hour` hours-from-midnight (may exceed 24),
 *  the same DST-safe conversion the app itself uses. */
function at(date, hour) {
  return israelDateTime(date, hour);
}

// 1. Plain daytime shift (morning, 06:45-14:45): a moment inside its window
//    is active.
checkValue(
  'morning shift is active mid-shift',
  isShiftActiveAt(MONDAY, 'morning', at(MONDAY, 10)),
  true,
);

// 2. Plain daytime shift: a moment well before it starts is not active.
checkValue(
  'morning shift is not active before it starts',
  isShiftActiveAt(MONDAY, 'morning', at(MONDAY, 6)),
  false,
);

// 3. Plain daytime shift: a moment well after it ends is not active.
checkValue(
  'morning shift is not active after it ends',
  isShiftActiveAt(MONDAY, 'morning', at(MONDAY, 16)),
  false,
);

// 4. Start boundary is inclusive: the exact start instant counts as active.
checkValue(
  'morning shift is active AT its own start instant',
  isShiftActiveAt(MONDAY, 'morning', at(MONDAY, 6.75)),
  true,
);

// 5. End boundary is exclusive: the exact end instant no longer counts (the
//    next shift, e.g. afternoon, owns that same instant instead).
checkValue(
  'morning shift is NOT active at its own end instant',
  isShiftActiveAt(MONDAY, 'morning', at(MONDAY, 14.75)),
  false,
);

// 6. Overnight shift (night, 22:45-06:45): a moment BEFORE midnight, still
//    on the shift's own target_date, is active.
checkValue(
  'night shift is active before midnight, same calendar day as target_date',
  isShiftActiveAt(MONDAY, 'night', at(MONDAY, 23)),
  true,
);

// 7. Overnight shift: a moment AFTER midnight, on the NEXT calendar day, is
//    still active -- this is the whole point of israelDateTime()'s
//    hour-may-exceed-24 rollover.
checkValue(
  'night shift is active after midnight, next calendar day',
  isShiftActiveAt(MONDAY, 'night', at(TUESDAY, 2)),
  true,
);

// 8. Overnight shift: a moment after it has actually ended (06:45 the next
//    morning) is not active.
checkValue(
  'night shift is not active once it has ended the next morning',
  isShiftActiveAt(MONDAY, 'night', at(TUESDAY, 7)),
  false,
);

// 9. A shift scheduled on a DIFFERENT target_date than the one being
//    checked, at a time of day that would otherwise match, is not active --
//    confirms the function checks the real instant, not just the
//    hour-of-day.
checkValue(
  "a shift on MONDAY is not active when checked against TUESDAY's same clock time",
  isShiftActiveAt(MONDAY, 'morning', at(TUESDAY, 10)),
  false,
);

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll shifts fixtures passed.\n');
