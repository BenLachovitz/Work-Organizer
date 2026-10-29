/**
 * Yom Kippur detection for the Yom Kippur special-coverage feature
 * (src/lib/shifts.ts kippur_day1/kippur_day2, migration 56).
 *
 * Yom Kippur is the 10th of Tishrei on the Hebrew calendar, which drifts
 * across the Gregorian calendar every year -- this is exactly the kind of
 * date that must never be computed wrong, so it's delegated to @hebcal/hdate
 * (Dershowitz/Reingold's well-tested Rata Die conversion) rather than
 * hand-rolled.
 */

import { greg2abs, HDate, months } from '@hebcal/hdate';
import { addDays, type DateKey } from '@/lib/dates';

/** Yom Kippur itself is the 10th of Tishrei; "Kippur eve" is the 9th. */
const YOM_KIPPUR_TISHREI_DAY = 10;
/** getTishreiMonth(): 1 is Tishrei (see @hebcal/hdate's HDate docs). */
const TISHREI = 1;

export interface YomKippurWeekInfo {
  /** Kippur eve -- when the special block starts (early afternoon). */
  erevDate: DateKey;
  /** Yom Kippur itself -- when the special block ends (before night). */
  dayDate: DateKey;
}

/**
 * `date` (a DateKey, 'YYYY-MM-DD') as the Hebrew calendar sees it.
 *
 * Deliberately builds the Date via the LOCAL constructor (`new Date(y, m, d)`)
 * with plain numbers, not `parseDateKey` (UTC-midnight, used everywhere else
 * in this app for roster arithmetic): @hebcal/hdate's `greg2abs` reads a
 * Date's LOCAL year/month/day, so a UTC-midnight Date could read back as the
 * wrong calendar day for a runtime west of UTC. Constructing AND reading in
 * local time keeps the two consistent regardless of which timezone the code
 * happens to run in.
 */
function toHDate(date: DateKey): HDate {
  const [y, m, d] = date.split('-').map(Number);
  return new HDate(greg2abs(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/**
 * Whether the roster week starting `weekStart` (Sunday) contains Yom Kippur
 * eve and day.
 *
 * Checks each of the week's 7 Gregorian dates directly against the Hebrew
 * calendar, rather than computing Yom Kippur's date forward from a guessed
 * Hebrew year -- simpler, and correct regardless of which Hebrew year(s) the
 * week's dates happen to fall in (a roster week can span a Hebrew new year
 * only around Rosh Hashanah, which is also exactly when Yom Kippur falls).
 *
 * Returns null both when the week has nothing to do with Yom Kippur, AND
 * when Yom Kippur falls on a Sunday: "Kippur eve" (Saturday) would then be
 * in the PREVIOUS roster week (weeks are Sun-Sat), which breaks this
 * feature's same-week assumption -- the caller should not render the picker
 * for either week in that case rather than silently mis-assigning.
 */
export function getYomKippurWeekInfo(weekStart: DateKey): YomKippurWeekInfo | null {
  let erevDate: DateKey | null = null;
  let dayDate: DateKey | null = null;

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const hd = toHDate(date);
    if (hd.getTishreiMonth() !== TISHREI) continue;
    if (hd.getDate() === YOM_KIPPUR_TISHREI_DAY - 1) erevDate = date;
    if (hd.getDate() === YOM_KIPPUR_TISHREI_DAY) dayDate = date;
  }

  if (!erevDate || !dayDate) return null;
  return { erevDate, dayDate };
}

// ---------------------------------------------------------------------------
// Major holidays (estimated-salary feature -- src/lib/payroll.ts)
//
// Under the Hours of Work and Rest Law, working a "Yom Tov" (major
// biblical festival) day carries the same rest-day pay premium as Shabbat.
// Only these 8 days qualify -- NOT the intermediate Chol HaMoed days of
// Sukkot/Pesach (ordinary workdays), and NOT minor/modern holidays
// (Chanukah, Purim, Yom HaAtzmaut, etc.), which carry no premium at all.
// Dates are as observed in Israel: a single day for Sukkot/Pesach's last
// day, not the diaspora's extra day.
//
// IMPORTANT: uses getMonth() + the `months` FIXED constants (NISAN=1,
// SIVAN=3, TISHREI=7 -- always, regardless of leap year), NOT
// getTishreiMonth() above. getTishreiMonth() numbers months relative to
// Tishrei within the civil Hebrew year, which SHIFTS by one for Nisan/
// Sivan/etc. in a leap year (Adar I+II inserted before them) -- it only
// happens to work for Yom Kippur above because Tishrei is that scheme's
// own reference point. getMonth()'s fixed constants have no such issue.
// ---------------------------------------------------------------------------
const MAJOR_HOLIDAYS: ReadonlyArray<readonly [number, number]> = [
  [months.TISHREI, 1], // Rosh Hashanah day 1
  [months.TISHREI, 2], // Rosh Hashanah day 2
  [months.TISHREI, 10], // Yom Kippur (also handled specially above, for scheduling)
  [months.TISHREI, 15], // Sukkot day 1
  [months.TISHREI, 22], // Shmini Atzeret / Simchat Torah (combined, Israel)
  [months.NISAN, 15], // Pesach day 1
  [months.NISAN, 21], // Pesach day 7 (Israel)
  [months.SIVAN, 6], // Shavuot
];

/** Whether `date` is one of the 8 major Yom Tov days (see MAJOR_HOLIDAYS'
 *  own comment for exactly which, and which days are deliberately
 *  excluded). Used only for the estimated-salary rest-day premium -- the
 *  Yom Kippur scheduling feature above does not use this at all. */
export function isMajorJewishHoliday(date: DateKey): boolean {
  const hd = toHDate(date);
  const month = hd.getMonth();
  const day = hd.getDate();
  return MAJOR_HOLIDAYS.some(([m, d]) => m === month && d === day);
}
