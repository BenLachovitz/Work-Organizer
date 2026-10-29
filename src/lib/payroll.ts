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

/**
 * Computes the estimated gross-pay breakdown for one set of work-log entries
 * (meant to be exactly one roster week's worth -- the weekly reconciliation
 * above assumes that scope) at a flat hourly rate.
 */
export function computePayroll(entries: WorkLogEntry[], hourlyRate: number): PayrollBreakdown {
  let regularHours = 0;
  let ot125Hours = 0;
  let ot150Hours = 0;
  let shabbatHours = 0;

  const byDate = new Map<DateKey, WorkLogEntry[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.target_date);
    if (list) list.push(entry);
    else byDate.set(entry.target_date, [entry]);
  }

  const dailyRegularByDate = new Map<DateKey, number>();
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

    let cumHoursToday = 0;
    let dayRegular = 0;

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

        if (tier.weight === 1) dayRegular += plainHours;
        else if (tier.weight === 1.25) ot125Hours += plainHours;
        else ot150Hours += plainHours;

        shabbatHours += overlapHours * tier.weight;
      }

      cumHoursToday += durationHours;
    }

    dailyRegularByDate.set(date, dayRegular);
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
    const dayRegular = dailyRegularByDate.get(date)!;
    const before = cumulativeRegular;
    cumulativeRegular += dayRegular;
    const excess =
      Math.max(0, cumulativeRegular - WEEKLY_REGULAR_HOURS) - Math.max(0, before - WEEKLY_REGULAR_HOURS);
    regularHours += dayRegular - excess;
    ot125Hours += excess;
  }

  const grossEstimate =
    hourlyRate * (regularHours + 1.25 * ot125Hours + 1.5 * ot150Hours + 1.5 * shabbatHours);

  return { regularHours, ot125Hours, ot150Hours, shabbatHours, grossEstimate };
}
