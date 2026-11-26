/**
 * Hand-computed fixtures for buildShiftsIcs() (src/lib/exportIcs.ts) -- the
 * "add my shifts to calendar" home-screen button's one piece of new logic.
 * No Supabase dependency, no DOM -- pure function in, .ics text out.
 *
 *   node --experimental-strip-types src/lib/exportIcs.test.mjs
 *
 * Same "resolve extension-less relative TS imports" loader as
 * shifts.test.mjs/payroll.test.mjs.
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

const { buildShiftsIcs } = await import('./exportIcs.ts');
const { addDays, israelDateTime } = await import('./dates.ts');

let failures = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkIncludes(name, haystack, needle) {
  check(name, haystack.includes(needle), true);
}

/** Same RFC 5545 UTC basic-format conversion buildShiftsIcs() itself uses,
 *  reused here to compute EXPECTED strings from the same DST-safe
 *  israelDateTime() the implementation calls -- this test is checking that
 *  buildShiftsIcs() wires shift lookups/nominalHours/formatting together
 *  correctly, not re-proving israelDateTime()'s own DST correctness (that's
 *  dates.ts's concern, already exercised elsewhere). */
function expectedUtc(dateKey, hour) {
  return israelDateTime(dateKey, hour).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const SUNDAY = '2026-11-01';
const MONDAY = addDays(SUNDAY, 1);
const GUARD = 'g1';

// 1. A single plain shift (morning) produces one VEVENT with the correct
//    DTSTART/DTEND and Hebrew summary.
{
  const week = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a1', target_date: MONDAY, shift: 'morning', guard_id: GUARD }],
  };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  check('wraps in VCALENDAR/VERSION:2.0', ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0'), true);
  check('ends with END:VCALENDAR', ics.trimEnd().endsWith('END:VCALENDAR'), true);
  check('BEGIN:VEVENT / END:VEVENT counts balance', (ics.match(/BEGIN:VEVENT/g) ?? []).length === (ics.match(/END:VEVENT/g) ?? []).length, true);
  check('uses CRLF line endings', ics.includes('\r\n'), true);
  checkIncludes('plain shift UID uses the assignment id', ics, 'UID:a1@work-organizer.local');
  checkIncludes('plain shift DTSTART matches israelDateTime(startH)', ics, `DTSTART:${expectedUtc(MONDAY, 6.75)}`);
  checkIncludes('plain shift DTEND matches israelDateTime(endH)', ics, `DTEND:${expectedUtc(MONDAY, 14.75)}`);
  checkIncludes('plain shift SUMMARY is the Hebrew shift label', ics, 'SUMMARY:בוקר');
}

// 2. An overnight shift (night, 22:45 -> 06:45 the NEXT calendar day) -- the
//    real point of using israelDateTime()'s hour-may-exceed-24 convention
//    instead of hand-rolling date arithmetic here.
{
  const week = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a2', target_date: MONDAY, shift: 'night', guard_id: GUARD }],
  };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  checkIncludes('overnight shift DTSTART is still on target_date', ics, `DTSTART:${expectedUtc(MONDAY, 22.75)}`);
  checkIncludes('overnight shift DTEND rolls onto the next calendar day', ics, `DTEND:${expectedUtc(MONDAY, 30.75)}`);
}

// 3. day12 at doubleShiftHours=11 with another real guard covering S2 --
//    buildShiftsIcs() must pass the WHOLE week's assignments (not just this
//    guard's own) into nominalHours(), or the shortening would never trigger.
{
  const self = { id: 'a3', target_date: MONDAY, shift: 'day12', guard_id: GUARD };
  const other = { id: 'a4', target_date: MONDAY, shift: 'afternoon', guard_id: 'g2' };
  const week = { doubleShiftHours: 11, assignments: [self, other] };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  checkIncludes('day12 shortened DTEND is one hour earlier', ics, `DTEND:${expectedUtc(MONDAY, 17.75)}`);
}

// 4. day12 at doubleShiftHours=11 with NO other guard covering S2 -- stays
//    full length (same reasoning as shifts.test.mjs's own fixture 12).
{
  const self = { id: 'a5', target_date: MONDAY, shift: 'day12', guard_id: GUARD };
  const week = { doubleShiftHours: 11, assignments: [self] };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  checkIncludes('day12 with nobody else covering stays full length', ics, `DTEND:${expectedUtc(MONDAY, 18.75)}`);
}

// 5. A shift on a date before `today` is excluded -- this export is
//    upcoming-only.
{
  const week = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a6', target_date: addDays(SUNDAY, -1), shift: 'morning', guard_id: GUARD }],
  };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  check('a past shift produces no VEVENT', ics.includes('BEGIN:VEVENT'), false);
}

// 6. Another guard's shift on the same week is excluded -- this is "MY"
//    shifts only.
{
  const week = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a7', target_date: MONDAY, shift: 'morning', guard_id: 'someone-else' }],
  };
  const ics = buildShiftsIcs([week], GUARD, SUNDAY);
  check('another guard\'s shift produces no VEVENT', ics.includes('BEGIN:VEVENT'), false);
}

// 7. Zero shifts: still a valid, well-formed empty calendar, not an error.
{
  const ics = buildShiftsIcs([], GUARD, SUNDAY);
  check('empty input still wraps in VCALENDAR', ics.startsWith('BEGIN:VCALENDAR'), true);
  check('empty input has no VEVENT', ics.includes('BEGIN:VEVENT'), false);
  check('empty input still ends with END:VCALENDAR', ics.trimEnd().endsWith('END:VCALENDAR'), true);
}

// 8. A date clearly in Israel Standard Time (winter, UTC+2) versus one
//    clearly in Israel Daylight Time (summer, UTC+3) must produce DIFFERENT
//    UTC hour digits for the same local 06:45 start -- confirms the DST
//    offset computed by israelDateTime() actually flows through into the
//    exported text, not just that the two strings happen to match each other.
{
  const winterDate = '2026-01-12'; // IST, UTC+2
  const summerDate = '2026-07-13'; // IDT, UTC+3
  const winterWeek = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a8', target_date: winterDate, shift: 'morning', guard_id: GUARD }],
  };
  const summerWeek = {
    doubleShiftHours: 12,
    assignments: [{ id: 'a9', target_date: summerDate, shift: 'morning', guard_id: GUARD }],
  };
  const winterIcs = buildShiftsIcs([winterWeek], GUARD, winterDate);
  const summerIcs = buildShiftsIcs([summerWeek], GUARD, summerDate);
  checkIncludes('winter (IST) DTSTART matches israelDateTime for that date', winterIcs, `DTSTART:${expectedUtc(winterDate, 6.75)}`);
  checkIncludes('summer (IDT) DTSTART matches israelDateTime for that date', summerIcs, `DTSTART:${expectedUtc(summerDate, 6.75)}`);
  check(
    'winter and summer DTSTART UTC hour differs by the DST offset',
    expectedUtc(winterDate, 6.75).slice(9, 11) !== expectedUtc(summerDate, 6.75).slice(9, 11),
    true,
  );
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll exportIcs fixtures passed.\n');
