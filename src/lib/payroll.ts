/**
 * Estimated GROSS salary from a personal work log -- the self-service
 * feature's calculation engine. Pure, no Supabase import, so it is directly
 * unit-testable (payroll.test.ts) and runnable with a plain
 * `node --experimental-strip-types` the same way the solver's own fixture
 * tests are -- hence the relative imports below rather than the `@/...`
 * aliases the rest of the app uses (those only resolve under Vite).
 *
 * This is explicitly an ESTIMATE, not a legally-binding payroll calculation
 * -- see the feature plan for the specific simplifications: a fixed Friday
 * 16:00 - Sunday 00:00 Shabbat window (no sunset/candle-lighting data
 * exists in this repo) and no OTHER Jewish holidays in v1 (src/lib/
 * holidays.ts only knows Yom Kippur today).
 */
import { addDays, dayIndex, israelDateTime, type DateKey } from './dates';
import type { WorkLogEntry } from '../types/database';

export interface PayrollBreakdown {
  /** All four hour buckets below are RAW, actual elapsed hours -- never
   *  pay-weighted. They sum exactly to the total hours in the input, each
   *  hour counted in exactly one bucket. Only grossEstimate applies rates/
   *  multipliers; these are for display and for cross-checking against
   *  another time-tracking source, which is exactly what surfaced the
   *  previous version's bug (it exposed a pay-WEIGHTED shabbatHours under a
   *  plain "hours" label, inflating it beyond real elapsed time). */
  regularHours: number;
  ot125Hours: number;
  ot150Hours: number;
  /** Raw hours that overlapped the weekend/Shabbat window, regardless of
   *  which overtime tier they'd otherwise fall in -- see PayrollBreakdown's
   *  own note above: this is a real hour count, not weighted. */
  shabbatHours: number;
  grossEstimate: number;
}

/**
 * Daily overtime tiers (Israeli law): the first OT_WIDTH_HOURS beyond the
 * standard day are +25 percentage points over the base rate, everything
 * beyond that is +50pp. The standard day itself is shorter for a NIGHT
 * shift -- 7h instead of 8 -- because Israeli law entitles a night-shift
 * employee (at least 2h of the shift inside the 22:00-06:00 window) to a
 * shorter standard day; overtime simply starts one hour earlier as a
 * result. The +25pp/+50pp SIZE is the same either way.
 *
 * Critically, these increments are ADDED to the base rate, never
 * multiplied onto it: a weekday's base is 100%, so its tiers read as the
 * familiar 100/125/150%. A rest-day's (Shabbat/holiday) base is already
 * 150% (see weekendWindow() below) BEFORE any daily overtime is even
 * considered, so the SAME +25/+50pp increments land at 150/175/200% there
 * -- not 150%x1.25 / 150%x1.5 (187.5%/225%), which the previous version of
 * this file incorrectly used. Stacking in Israeli law is additive on top
 * of whichever base rate applies, not multiplicative.
 */
const DAY_SHIFT_REGULAR_HOURS = 8;
const NIGHT_SHIFT_REGULAR_HOURS = 7;
const OT_TIER_1_WIDTH_HOURS = 2;
const OT_TIER_1_INCREMENT = 0.25;
const OT_TIER_2_INCREMENT = 0.5;

/** A shift counts as a "night shift" for the 7h-day entitlement once at
 *  least this many hours of it fall inside 22:00-06:00 (standard Israeli
 *  definition) -- checked against the day's ACTUAL logged hours, not a
 *  shift-type label, so a manually edited or free-form entry is classified
 *  correctly too. */
const NIGHT_SHIFT_MIN_HOURS = 2;

/** Weekly reconciliation: total NON-weekend regular hours (after the daily
 *  split above) beyond 42/week are reclassified into the +25pp bucket --
 *  catches a guard stacking many short days that never individually
 *  trigger daily OT. Weekend hours are a separate accounting entirely (see
 *  weekendWindow()) and are not part of this reconciliation. */
const WEEKLY_REGULAR_HOURS = 42;

const MS_PER_HOUR = 3_600_000;

/** Friday 16:00 to the following Sunday 00:00, Asia/Jerusalem -- a fixed
 *  approximation of the weekly rest period (real Shabbat start/end follows
 *  sunset, which this repo has no data for). `targetDate` can be any day of
 *  the week; the window returned is always for THAT week's Friday/Saturday. */
function weekendWindow(targetDate: DateKey): { start: Date; end: Date } {
  const weekStart = addDays(targetDate, -dayIndex(targetDate));
  const friday = addDays(weekStart, 5);
  const followingSunday = addDays(weekStart, 7);
  return { start: israelDateTime(friday, 16), end: israelDateTime(followingSunday, 0) };
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
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
 * Six RAW, mutually-exclusive hour buckets per day: {regular, ot125, ot150}
 * for non-weekend hours (base rate 1.0, so their effective multiplier is
 * 1 / 1.25 / 1.5), and the same three OT tiers again for hours that fall in
 * the weekend window (base rate 1.5, so their effective multiplier is
 * 1.5 / 1.75 / 2.0 -- additive, per the comment on the tier constants
 * above). Every logged hour lands in exactly one of the six; weeklyRegular
 * only ever moves hours between the first two non-weekend buckets.
 */
interface DayBuckets {
  regular: number;
  ot125: number;
  ot150: number;
  shabbatRegular: number;
  shabbatOt125: number;
  shabbatOt150: number;
}

const EMPTY_BUCKETS = (): DayBuckets => ({
  regular: 0,
  ot125: 0,
  ot150: 0,
  shabbatRegular: 0,
  shabbatOt125: 0,
  shabbatOt150: 0,
});

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
    const { start: weekendStart, end: weekendEnd } = weekendWindow(date);
    const weekendStartMs = weekendStart.getTime();
    const weekendEndMs = weekendEnd.getTime();
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

    const tiers = [
      { from: 0, to: regularThreshold, bucket: 'regular' as const, shabbatBucket: 'shabbatRegular' as const },
      {
        from: regularThreshold,
        to: regularThreshold + OT_TIER_1_WIDTH_HOURS,
        bucket: 'ot125' as const,
        shabbatBucket: 'shabbatOt125' as const,
      },
      {
        from: regularThreshold + OT_TIER_1_WIDTH_HOURS,
        to: Infinity,
        bucket: 'ot150' as const,
        shabbatBucket: 'shabbatOt150' as const,
      },
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

        // This cumulative-hour segment's real clock-time range, so it can be
        // tested against the weekend window.
        const segStartMs = startMs + (segFromHour - cumHoursToday) * MS_PER_HOUR;
        const segEndMs = startMs + (segToHour - cumHoursToday) * MS_PER_HOUR;
        const overlapHours =
          overlapMs(segStartMs, segEndMs, weekendStartMs, weekendEndMs) / MS_PER_HOUR;
        const plainHours = segHours - overlapHours;

        buckets[tier.bucket] += plainHours;
        buckets[tier.shabbatBucket] += overlapHours;
      }

      cumHoursToday += durationHours;
    }

    perDay.set(date, buckets);
  }

  // Resets at each roster week's own Sunday boundary -- so a multi-week
  // input (the monthly rollup) reconciles 42h independently per week rather
  // than treating the whole month as one continuous accumulation. Only the
  // non-weekend buckets participate -- weekend hours are already at their
  // own 150%+ base and are not folded into this weekday-hours cap.
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
    cumulativeRegular += buckets.regular;
    const excess =
      Math.max(0, cumulativeRegular - WEEKLY_REGULAR_HOURS) - Math.max(0, before - WEEKLY_REGULAR_HOURS);
    buckets.regular -= excess;
    buckets.ot125 += excess;
  }

  // Gross is accumulated PER DAY, each at whatever rate was effective on
  // that specific date -- a day earlier than any recorded rate contributes
  // its hours to the totals below but nothing to grossEstimate. Weekend
  // buckets add their OT increment on top of the 1.5 base (additive, per
  // the tier-constants comment), never multiplied onto it.
  let regularHours = 0;
  let ot125Hours = 0;
  let ot150Hours = 0;
  let shabbatHours = 0;
  let grossEstimate = 0;
  for (const date of sortedDates) {
    const b = perDay.get(date)!;
    regularHours += b.regular;
    ot125Hours += b.ot125;
    ot150Hours += b.ot150;
    shabbatHours += b.shabbatRegular + b.shabbatOt125 + b.shabbatOt150;

    const rate = rateForDate(rateHistory, date);
    if (rate != null) {
      grossEstimate +=
        rate *
        (b.regular +
          (1 + OT_TIER_1_INCREMENT) * b.ot125 +
          (1 + OT_TIER_2_INCREMENT) * b.ot150 +
          1.5 * b.shabbatRegular +
          (1.5 + OT_TIER_1_INCREMENT) * b.shabbatOt125 +
          (1.5 + OT_TIER_2_INCREMENT) * b.shabbatOt150);
    }
  }

  return { regularHours, ot125Hours, ot150Hours, shabbatHours, grossEstimate };
}
