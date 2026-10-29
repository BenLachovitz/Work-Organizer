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
  regularHours: number;
  ot125Hours: number;
  ot150Hours: number;
  /** Already weight-adjusted: an hour that would otherwise have been a
   *  150%-tier hour contributes 1.5 "equivalent hours" here, not 1 -- so the
   *  final formula's flat 1.5x on this bucket reproduces the stacked rate
   *  (e.g. an 11th hour worked on Saturday nets 150%x150%). */
  shabbatHours: number;
  grossEstimate: number;
}

/** Daily overtime tiers (Israeli law): hours 1-8 regular, 9-10 at 125%, 11+
 *  at 150%. Applied per calendar day across ALL of that day's entries
 *  combined, in chronological order -- a guard who splits one long day
 *  across two logged entries still crosses the same tier boundaries. */
const DAILY_REGULAR_HOURS = 8;
const DAILY_OT125_HOURS = 2;

/** Weekly reconciliation: total regular hours (after the daily split above)
 *  beyond 42/week are reclassified into the 125% bucket -- catches a guard
 *  stacking many short days that never individually trigger daily OT. */
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

type DayBuckets = { regular: number; ot125: number; ot150: number; shabbat: number };

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

    const tiers = [
      { from: 0, to: DAILY_REGULAR_HOURS, weight: 1 },
      { from: DAILY_REGULAR_HOURS, to: DAILY_REGULAR_HOURS + DAILY_OT125_HOURS, weight: 1.25 },
      { from: DAILY_REGULAR_HOURS + DAILY_OT125_HOURS, to: Infinity, weight: 1.5 },
    ] as const;

    const buckets: DayBuckets = { regular: 0, ot125: 0, ot150: 0, shabbat: 0 };
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

        if (tier.weight === 1) buckets.regular += plainHours;
        else if (tier.weight === 1.25) buckets.ot125 += plainHours;
        else buckets.ot150 += plainHours;

        buckets.shabbat += overlapHours * tier.weight;
      }

      cumHoursToday += durationHours;
    }

    perDay.set(date, buckets);
  }

  // Resets at each roster week's own Sunday boundary -- so a multi-week
  // input (the monthly rollup) reconciles 42h independently per week rather
  // than treating the whole month as one continuous accumulation.
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
  // its hours to the totals below but nothing to grossEstimate.
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
    shabbatHours += b.shabbat;
    const rate = rateForDate(rateHistory, date);
    if (rate != null) {
      grossEstimate += rate * (b.regular + 1.25 * b.ot125 + 1.5 * b.ot150 + 1.5 * b.shabbat);
    }
  }

  return { regularHours, ot125Hours, ot150Hours, shabbatHours, grossEstimate };
}
