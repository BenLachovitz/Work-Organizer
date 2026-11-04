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

const { isShiftActiveAt, nominalHours } = await import('./shifts.ts');
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

// ---------------------------------------------------------------------------
// nominalHours() -- the work log's own "what did this shift really run" look-
// up (src/hooks/useWorkLog.ts's nominalWindow()), which must match the
// double-shift display-hours shortening the roster grid/guard's own shift
// list already render via doubleShiftSuffix()/doubleShiftLabel().
// ---------------------------------------------------------------------------

function checkHours(name, actual, expected) {
  checkValue(`${name} (startH)`, actual.startH, expected.startH);
  checkValue(`${name} (endH)`, actual.endH, expected.endH);
}

const DAY12_FULL = { startH: 6.75, endH: 18.75 };
const DAY12_SHORT = { startH: 6.75, endH: 17.75 };
const NIGHT12_FULL = { startH: 18.75, endH: 30.75 };
const NIGHT12_SHORT = { startH: 19.75, endH: 30.75 };

// 10. A plain (non-day12/night12) shift is never affected by the setting.
checkHours(
  'a plain morning shift ignores doubleShiftHours entirely',
  nominalHours('morning', { shift: 'morning', guard_id: 'g1' }, [], 11),
  { startH: 6.75, endH: 14.75 },
);

// 11. The setting itself at 12 (the default): day12 always reads full,
//     regardless of who else is on the roster that day.
{
  const self = { shift: 'day12', guard_id: 'g1' };
  const other = { shift: 'afternoon', guard_id: 'g2' };
  checkHours(
    'day12 stays full at doubleShiftHours=12 even with real S2 coverage',
    nominalHours('day12', self, [self, other], 12),
    DAY12_FULL,
  );
}

// 12. At 11, with NO other real guard covering day12's edge segment (S2):
//     shortening would imply an hour with nobody there, so it stays full.
{
  const self = { shift: 'day12', guard_id: 'g1' };
  checkHours(
    'day12 stays full at doubleShiftHours=11 when nobody else covers S2',
    nominalHours('day12', self, [self], 11),
    DAY12_FULL,
  );
}

// 13. At 11, with another REAL (non-placeholder) guard covering S2 (e.g. the
//     full afternoon shift, which covers both S2 and S3): this is the actual
//     reported bug -- the guard's own real last hour is someone else's, so
//     the work log must seed the shortened 06:45-17:45 window, not the full
//     12h one.
{
  const self = { shift: 'day12', guard_id: 'g1' };
  const other = { shift: 'afternoon', guard_id: 'g2' };
  checkHours(
    'day12 shortens to 06:45-17:45 at doubleShiftHours=11 when another guard covers S2',
    nominalHours('day12', self, [self, other], 11),
    DAY12_SHORT,
  );
}

// 14. A PLACEHOLDER (guard_id null) "covering" S2 does not count as real
//     coverage -- same reasoning isDoubleShiftShortened() itself documents.
{
  const self = { shift: 'day12', guard_id: 'g1' };
  const placeholder = { shift: 'afternoon_early', guard_id: null };
  checkHours(
    'day12 stays full at doubleShiftHours=11 when only a placeholder covers S2',
    nominalHours('day12', self, [self, placeholder], 11),
    DAY12_FULL,
  );
}

// 15. night12's edge segment is S3, and its shortening moves the START an
//     hour LATER instead of the end an hour earlier.
{
  const self = { shift: 'night12', guard_id: 'g1' };
  const other = { shift: 'afternoon_late', guard_id: 'g2' };
  checkHours(
    'night12 shortens to start an hour later at doubleShiftHours=11 when another guard covers S3',
    nominalHours('night12', self, [self, other], 11),
    NIGHT12_SHORT,
  );
}

// 16. night12 with no real S3 coverage from anyone else stays full, same
//     reasoning as fixture 12.
{
  const self = { shift: 'night12', guard_id: 'g1' };
  checkHours(
    'night12 stays full at doubleShiftHours=11 when nobody else covers S3',
    nominalHours('night12', self, [self], 11),
    NIGHT12_FULL,
  );
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll shifts fixtures passed.\n');
