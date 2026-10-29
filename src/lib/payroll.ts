/**
 * Estimated GROSS salary from a personal work log -- the self-service
 * feature's calculation engine. Pure, no Supabase import, so it is directly
 * unit-testable (payroll.test.ts) and runnable with a plain
 * `node --experimental-strip-types` the same way the solver's own fixture
 * tests are -- hence the relative imports below rather than the `@/...`
 * aliases the rest of the app uses (those only resolve under Vite).
 *
 * This is explicitly an ESTIMATE, not a legally-binding payroll calculation
 * -- see the feature plan for the specific simplification: a fixed 16:00
 * "erev" cutoff for both Shabbat and holidays (real start/end follows
 * sunset, which this repo has no data for).
 */
import { addDays, dayIndex, israelDateTime, type DateKey } from './dates';
import { isMajorJewishHoliday } from './holidays';
import type { WorkLogEntry } from '../types/database';

export interface PayrollBreakdown {
  /**
   * All five buckets are RAW, actual elapsed hours -- never pay-weighted
   * -- and sum exactly to the total hours in the input, each hour counted
   * in exactly one bucket by the RATE IT IS ACTUALLY PAID AT. There is no
   * separate "Shabbat hours" category: a rest-day's (Shabbat or major
   * holiday) base rate is 150%, so its own un-worked-overtime hours land
   * in `hours150` together with an ordinary weekday's SECOND overtime
   * tier -- they are paid identically, so they are counted identically.
   * Only grossEstimate applies rates; these are for display and for
   * cross-checking against another time-tracking source, which is
   * exactly what surfaced a bug in an earlier version (it exposed a pay-
   * WEIGHTED number under a plain "hours" label, inflating it beyond real
   * elapsed time).
   */
  hours100: number;
  hours125: number;
  hours150: number;
  hours175: number;
  hours200: number;
  grossEstimate: number;
}

/**
 * Daily overtime tiers (Israeli law): the first OT_TIER_1_WIDTH_HOURS
 * beyond the standard day are +25 percentage points over the base rate,
 * everything beyond that is +50pp more (so +75pp total over the weekday
 * base). The standard day itself is shorter for a NIGHT shift -- 7h
 * instead of 8 -- because Israeli law entitles a night-shift employee (at
 * least 2h of the shift inside the 22:00-06:00 window) to a shorter
 * standard day; overtime simply starts one hour earlier as a result. The
 * +25pp/+50pp SIZE is the same either way.
 *
 * Critically, these increments are ADDED to the base rate, never
 * multiplied onto it: a weekday's base is 100%, so its tiers read as the
 * familiar 100/125/150%. A rest-day's (Shabbat or major holiday) base is
 * already 150% (see restDayOverlapHours() below) BEFORE any daily
 * overtime is even considered, so the SAME +25/+50pp increments land at
 * 150/175/200% there -- not 150%x1.25 / 150%x1.5 (187.5%/225%). Stacking
 * in Israeli law is additive on top of whichever base rate applies, not
 * multiplicative.
 */
const DAY_SHIFT_REGULAR_HOURS = 8;
const NIGHT_SHIFT_REGULAR_HOURS = 7;
const OT_TIER_1_WIDTH_HOURS = 2;
const OT_TIER_1_INCREMENT = 0.25;
const OT_TIER_2_INCREMENT = 0.5;
const REST_DAY_BASE = 1.5;

/** A shift counts as a "night shift" for the 7h-day entitlement once at
 *  least this many hours of it fall inside 22:00-06:00 (standard Israeli
 *  definition) -- checked against the day's ACTUAL logged hours, not a
 *  shift-type label, so a manually edited or free-form entry is classified
 *  correctly too. */
const NIGHT_SHIFT_MIN_HOURS = 2;

/** Weekly reconciliation: total NON-rest-day regular hours (after the
 *  daily split above) beyond 42/week are reclassified into the +25pp
 *  bucket -- catches a guard stacking many short days that never
 *  individually trigger daily OT. Rest-day hours are a separate
 *  accounting entirely (see restDayOverlapHours()) and are not part of
 *  this reconciliation. */
const WEEKLY_REGULAR_HOURS = 42;

const MS_PER_HOUR = 3_600_000;

/** `erevCutoffHour` the evening BEFORE `restDate`, to midnight after
 *  `restDate` itself -- the shared "a rest day starts the evening before,
 *  and lasts until the day after it ends" shape used for both Shabbat
 *  (restDate = Saturday, so this spans Friday 16:00 -> Sunday 00:00) and a
 *  major holiday's own eve-to-end. */
function erevWindow(restDate: DateKey, erevCutoffHour: number): { start: Date; end: Date } {
  return {
    start: israelDateTime(addDays(restDate, -1), erevCutoffHour),
    end: israelDateTime(addDays(restDate, 1), 0),
  };
}

/**
 * Every rest-day window touching `date` -- the week's Friday/Saturday,
 * PLUS one per major holiday whose own window could overlap an entry that
 * starts on `date`: `date` itself being the holiday (window runs from
 * the evening before), OR `date + 1` being the holiday (so `date`'s own
 * evening, from 16:00, is that holiday's "erev"). An entry logged on
 * `date` can run into the following calendar day but never further --
 * the UI caps a single entry at 18h -- so no other date ever needs
 * checking. Overlapping windows (e.g. a 2-day Rosh Hashanah landing
 * against a Friday/Saturday, same as the owner's own example) are merged
 * so a segment spanning more than one is never double-counted.
 */
function restDayWindows(date: DateKey): { start: number; end: number }[] {
  const weekStart = addDays(date, -dayIndex(date));
  const saturday = addDays(weekStart, 6);
  const windows = [erevWindow(saturday, 16)];

  for (const d of [date, addDays(date, 1)]) {
    if (isMajorJewishHoliday(d)) windows.push(erevWindow(d, 16));
  }

  const sorted = windows.map((w) => ({ start: w.start.getTime(), end: w.end.getTime() })).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Total overlap, in hours, between [segStartMs, segEndMs) and ANY of
 *  date's rest-day windows (already merged, so no double counting). */
function restDayOverlapHours(segStartMs: number, segEndMs: number, date: DateKey): number {
  let total = 0;
  for (const w of restDayWindows(date)) {
    total += overlapMs(segStartMs, segEndMs, w.start, w.end) / MS_PER_HOUR;
  }
  return Math.min(total, (segEndMs - segStartMs) / MS_PER_HOUR);
}

/** 22:00 on `date` to 06:00 the following day, Asia/Jerusalem -- the
 *  standard Israeli definition of the night window used to decide whether
 *  a day's work counts as a night shift (NIGHT_SHIFT_MIN_HOURS inside it). */
function nightWindow(date: DateKey): { start: Date; end: Date } {
  return { start: israelDateTime(date, 22), end: israelDateTime(addDays(date, 1), 6) };
}

/** One entry in an append-only rate history: "from this date onward, the
 *  rate was X" -- never edited or deleted when a new rate is added, which
 *  is what keeps a later raise from recalculating already-passed months.
 *  See PayrollRateSettings.tsx / migration 62. */
export interface RateHistoryEntry {
  effective_from: DateKey;
  hourly_rate: number;
}

/** The rate in effect ON `date` -- the latest history entry whose
 *  `effective_from` is on or before it. NULL if `date` is earlier than any
 *  recorded rate (nothing to charge against yet). */
export function rateForDate(history: RateHistoryEntry[], date: DateKey): number | null {
  let best: RateHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.effective_from <= date && (!best || entry.effective_from > best.effective_from)) {
      best = entry;
    }
  }
  return best?.hourly_rate ?? null;
}

/**
 * Five RAW, mutually-exclusive percentage buckets per day -- h100/h125/
 * h150 for a weekday (base 1.0), h150/h175/h200 for a rest day (base 1.5).
 * The weekday's own second-OT-tier and a rest day's own zero-OT tier both
 * land in h150 -- same pay, same bucket. Every logged hour lands in
 * exactly one of the five; weeklyRegular only ever moves hours between
 * h100 and h125 (both non-rest-day).
 */
interface DayBuckets {
  h100: number;
  h125: number;
  h150: number;
  h175: number;
  h200: number;
}

const EMPTY_BUCKETS = (): DayBuckets => ({ h100: 0, h125: 0, h150: 0, h175: 0, h200: 0 });

/** Which bucket a given (restDay, tier) combination pays at -- tier 0/1/2
 *  meaning "within the standard day" / "+25pp" / "+50pp". */
function bucketFor(isRestDay: boolean, tier: 0 | 1 | 2): keyof DayBuckets {
  if (!isRestDay) return (['h100', 'h125', 'h150'] as const)[tier];
  return (['h150', 'h175', 'h200'] as const)[tier];
}

/**
 * Computes the estimated gross-pay breakdown for one set of work-log
 * entries (a roster week, or several for the monthly rollup -- the weekly
 * reconciliation below resets at each week's own boundary either way), at
 * whatever rate was actually in effect on EACH day -- never the rate that
 * happens to be current now, so a later rate change never recalculates a
 * month that has already passed.
 */
export function computePayroll(
  entries: WorkLogEntry[],
  rateHistory: RateHistoryEntry[],
): PayrollBreakdown {
  const byDate = new Map<DateKey, WorkLogEntry[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.target_date);
    if (list) list.push(entry);
    else byDate.set(entry.target_date, [entry]);
  }

  const perDay = new Map<DateKey, DayBuckets>();
  const sortedDates = [...byDate.keys()].sort();

  for (const date of sortedDates) {
    const dayEntries = [...byDate.get(date)!].sort(
      (a, b) => new Date(a.actual_start).getTime() - new Date(b.actual_start).getTime(),
    );
    const { start: nightStart, end: nightEnd } = nightWindow(date);
    const nightStartMs = nightStart.getTime();
    const nightEndMs = nightEnd.getTime();

    // Classify the whole day FIRST, from all its entries combined -- a
    // night shift's 7h entitlement depends on actual hours worked inside
    // 22:00-06:00, not on which entry individually crosses that threshold.
    let nightOverlapHours = 0;
    for (const entry of dayEntries) {
      nightOverlapHours +=
        overlapMs(
          new Date(entry.actual_start).getTime(),
          new Date(entry.actual_end).getTime(),
          nightStartMs,
          nightEndMs,
        ) / MS_PER_HOUR;
    }
    const regularThreshold =
      nightOverlapHours >= NIGHT_SHIFT_MIN_HOURS ? NIGHT_SHIFT_REGULAR_HOURS : DAY_SHIFT_REGULAR_HOURS;

    const tiers: { from: number; to: number; tier: 0 | 1 | 2 }[] = [
      { from: 0, to: regularThreshold, tier: 0 },
      { from: regularThreshold, to: regularThreshold + OT_TIER_1_WIDTH_HOURS, tier: 1 },
      { from: regularThreshold + OT_TIER_1_WIDTH_HOURS, to: Infinity, tier: 2 },
    ];

    const buckets = EMPTY_BUCKETS();
    let cumHoursToday = 0;

    for (const entry of dayEntries) {
      const startMs = new Date(entry.actual_start).getTime();
      const durationHours = (new Date(entry.actual_end).getTime() - startMs) / MS_PER_HOUR;

      for (const tier of tiers) {
        const segFromHour = Math.max(cumHoursToday, tier.from);
        const segToHour = Math.min(cumHoursToday + durationHours, tier.to);
        const segHours = segToHour - segFromHour;
        if (segHours <= 0) continue;

        // This cumulative-hour segment's real clock-time range, so it can
        // be tested against the rest-day windows.
        const segStartMs = startMs + (segFromHour - cumHoursToday) * MS_PER_HOUR;
        const segEndMs = startMs + (segToHour - cumHoursToday) * MS_PER_HOUR;
        const restHours = restDayOverlapHours(segStartMs, segEndMs, date);
        const plainHours = segHours - restHours;

        buckets[bucketFor(false, tier.tier)] += plainHours;
        buckets[bucketFor(true, tier.tier)] += restHours;
      }

      cumHoursToday += durationHours;
    }

    perDay.set(date, buckets);
  }

  // Resets at each roster week's own Sunday boundary -- so a multi-week
  // input (the monthly rollup) reconciles 42h independently per week
  // rather than treating the whole month as one continuous accumulation.
  // Only h100 participates -- rest-day hours are already at their own
  // 150%+ base and are not folded into this weekday-hours cap.
  let cumulativeRegular = 0;
  let currentWeekStart: DateKey | null = null;
  for (const date of sortedDates) {
    const weekStart = addDays(date, -dayIndex(date));
    if (weekStart !== currentWeekStart) {
      currentWeekStart = weekStart;
      cumulativeRegular = 0;
    }
    const buckets = perDay.get(date)!;
    const before = cumulativeRegular;
    cumulativeRegular += buckets.h100;
    const excess =
      Math.max(0, cumulativeRegular - WEEKLY_REGULAR_HOURS) - Math.max(0, before - WEEKLY_REGULAR_HOURS);
    buckets.h100 -= excess;
    buckets.h125 += excess;
  }

  // Gross is accumulated PER DAY, each at whatever rate was effective on
  // that specific date -- a day earlier than any recorded rate contributes
  // its hours to the totals below but nothing to grossEstimate.
  let hours100 = 0;
  let hours125 = 0;
  let hours150 = 0;
  let hours175 = 0;
  let hours200 = 0;
  let grossEstimate = 0;
  for (const date of sortedDates) {
    const b = perDay.get(date)!;
    hours100 += b.h100;
    hours125 += b.h125;
    hours150 += b.h150;
    hours175 += b.h175;
    hours200 += b.h200;

    const rate = rateForDate(rateHistory, date);
    if (rate != null) {
      grossEstimate +=
        rate *
        (b.h100 +
          (1 + OT_TIER_1_INCREMENT) * b.h125 +
          (1 + OT_TIER_2_INCREMENT) * b.h150 +
          (REST_DAY_BASE + OT_TIER_1_INCREMENT) * b.h175 +
          (REST_DAY_BASE + OT_TIER_2_INCREMENT) * b.h200);
      // b.h150 covers BOTH a weekday's own 2nd OT tier (1+0.5) and a rest
      // day's zero-OT hours (REST_DAY_BASE=1.5) -- same numeric value by
      // design, see bucketFor()'s own comment.
    }
  }

  return { hours100, hours125, hours150, hours175, hours200, grossEstimate };
}

// ---------------------------------------------------------------------------
// Sick/vacation absences (migration 64) -- NOT worked time, never touches
// the overtime engine above. A completely separate, much simpler
// calculation: a guard's average REGULAR daily wage, times a percentage
// (100% for vacation; 0/50/100% for sick, by Israeli law, depending on
// which day of a consecutive run of sick days this one is). There is no
// balance/ledger here by deliberate choice -- see the feature plan.
// ---------------------------------------------------------------------------

/**
 * A guard's average REGULAR wage per worked day -- average(hours worked
 * that day) x the rate in effect on that day, deliberately EXCLUDING any
 * overtime or rest-day premium. This matches Israeli law directly:
 * vacation/sick pay is based on the regular wage a day would normally earn,
 * not on whatever premium a guard happened to earn on days they actually
 * worked. An earlier version of this function ran every historical day
 * through the full overtime engine (computePayroll) and averaged THAT --
 * which skewed heavily toward whatever a guard who often works 12h/
 * weekend shifts actually earns, nowhere near a plain 8h day's value (a
 * guard who mostly works 12h shifts saw a ~570 estimate for a vacation day
 * they expected to be ~300-330, i.e. roughly an 8h day's regular wage).
 *
 * Callers are expected to pass only entries dated ON OR BEFORE the absence
 * being valued -- see rateForDate's own "never recalculate the past"
 * principle, which this mirrors. Returns 0 if there is no day with both
 * logged hours and a known rate to average from yet.
 */
export function averageDailyBaseWage(entries: WorkLogEntry[], rateHistory: RateHistoryEntry[]): number {
  const hoursByDate = new Map<DateKey, number>();
  for (const entry of entries) {
    const hours = (new Date(entry.actual_end).getTime() - new Date(entry.actual_start).getTime()) / MS_PER_HOUR;
    hoursByDate.set(entry.target_date, (hoursByDate.get(entry.target_date) ?? 0) + hours);
  }

  let total = 0;
  let countedDays = 0;
  for (const [date, hours] of hoursByDate) {
    const rate = rateForDate(rateHistory, date);
    if (rate == null) continue; // no known rate that far back -- exclude, don't count as 0
    total += hours * rate;
    countedDays++;
  }
  return countedDays === 0 ? 0 : total / countedDays;
}

/**
 * Which day, counting backward, `date` is within a consecutive run of sick
 * days -- 1 if `date` itself is the first (nothing the day before it is
 * also sick), 2 if the day before was also sick, etc. `sickDates` need only
 * contain dates within a few days of `date`; anything further back is
 * irrelevant once a gap is found.
 */
export function consecutiveSickDayCount(sickDates: ReadonlySet<DateKey>, date: DateKey): number {
  let count = 0;
  let d = date;
  while (sickDates.has(d)) {
    count++;
    d = addDays(d, -1);
  }
  return count;
}

/** Israeli Sick Pay Law: day 1 unpaid, days 2-3 at 50%, day 4+ at 100%. */
export function sickPayPercent(consecutiveDayNumber: number): number {
  if (consecutiveDayNumber <= 1) return 0;
  if (consecutiveDayNumber <= 3) return 0.5;
  return 1;
}
