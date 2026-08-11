import { Card, cn } from '@/components/ui';
import { HEBREW_DAYS_SHORT, type DateKey } from '@/lib/dates';
import {
  BASE_SHIFTS,
  SHIFTS,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type MorningTarget,
  type MorningTargetOverrides,
  type SecondaryTargetOverrides,
} from '@/lib/shifts';
import type { CoverageCell } from '@/hooks/useManager';

/**
 * Supply, not assignment: how many guards said they COULD work each slot,
 * against what the week needs.
 *
 * This is the manager's pre-flight check. If a night shows 0 available, no
 * solver can staff it and no amount of re-running will help -- the fix is to
 * phone somebody, and they need to know that before pressing Generate.
 */
export function CoverageMatrix({
  cells,
  dates,
  morningTarget,
  morningTargetOverrides,
  segmentTargetOverrides,
}: {
  cells: CoverageCell[];
  dates: DateKey[];
  morningTarget: MorningTarget;
  /** Per-day exceptions to morningTarget for this week (§1). */
  morningTargetOverrides?: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of 2 (§1). */
  segmentTargetOverrides?: SecondaryTargetOverrides;
}) {
  // Per day: the raised morning target applies Mon-Fri only, so Saturday and
  // Sunday show a requirement of 2 even when the week is set to 3. A per-day
  // override (§1) beats the week setting for a day that has one.
  // The 8h shifts map onto segments: morning->S1, afternoon->S2/S3, night->S4.
  // Guards mark availability per BASE shift (one number for the whole
  // afternoon), so a single "afternoon" supply count is checked against
  // whichever of S2/S3 is more demanding -- their own per-day overrides can
  // now diverge, and the pre-flight check should flag a shortage against the
  // stricter half.
  const needOn = (dayIndex: number) => {
    const floors = segmentFloors(morningTarget, dayIndex, morningTargetOverrides, segmentTargetOverrides);
    const targets = segmentTargets(morningTarget, dayIndex, morningTargetOverrides, segmentTargetOverrides);
    return {
      morning: { floor: floors.S1, target: targets.S1 },
      afternoon: {
        floor: Math.max(floors.S2, floors.S3),
        target: Math.max(targets.S2, targets.S3),
      },
      night: { floor: floors.S4, target: targets.S4 },
    } as const;
  };

  const at = (date: DateKey, shift: string) =>
    cells.find((c) => c.date === date && c.shift === shift)?.available ?? 0;

  let breaches = 0;
  let gaps = 0;
  dates.forEach((d, i) => {
    const need = needOn(i);
    for (const s of BASE_SHIFTS) {
      const a = at(d, s);
      if (a < need[s].floor) breaches++;
      else if (a < need[s].target) gaps++;
    }
  });

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <p className="font-bold text-slate-900 dark:text-slate-100">זמינות הצוות</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          כמה מאבטחים סימנו שהם יכולים לעבוד בכל משמרת
        </p>
      </div>

      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full min-w-[22rem] border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="w-16" />
              {dates.map((d, i) => (
                <th
                  key={d}
                  title={isWeekendDay(i) ? 'יום מנוחה - יעד בוקר 2 תמיד' : undefined}
                  className={cn(
                    'pb-1 text-center text-xs font-bold',
                    // Marks why Saturday and Sunday show 2 even at target 3.
                    isWeekendDay(i)
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400',
                  )}
                >
                  {HEBREW_DAYS_SHORT[i]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {BASE_SHIFTS.map((shift) => (
              <tr key={shift}>
                <td className="pe-2 text-end">
                  <span
                    className="inline-block size-2.5 rounded-full align-middle"
                    style={{ backgroundColor: SHIFTS[shift].colorVar }}
                  />
                  <span className="ms-1.5 align-middle text-xs font-bold text-slate-700 dark:text-slate-300">
                    {SHIFTS[shift].he}
                  </span>
                </td>
                {dates.map((date, dayIndex) => {
                  const a = at(date, shift);
                  const { floor, target } = needOn(dayIndex)[shift];
                  const below = a < floor;
                  const short = !below && a < target;
                  return (
                    <td key={date} className="p-0">
                      <div
                        title={`${a} זמינים · רצפה ${floor} · יעד ${target}`}
                        className={cn(
                          'grid h-9 place-items-center rounded-lg text-sm font-bold tabular-nums',
                          below
                            ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300 dark:bg-rose-950/50 dark:text-rose-400 dark:ring-rose-800'
                            : short
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-400'
                              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400',
                        )}
                      >
                        {a}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2.5 text-xs dark:border-slate-800 dark:text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-emerald-100 ring-1 ring-emerald-300 dark:bg-emerald-950/60 dark:ring-emerald-700" />
          מספיק ליעד
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-amber-100 ring-1 ring-amber-300 dark:bg-amber-950/60 dark:ring-amber-700" />
          מעל הרצפה, מתחת ליעד
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-rose-100 ring-1 ring-rose-300 dark:bg-rose-950/60 dark:ring-rose-700" />
          מתחת לרצפה
        </span>
      </div>

      {(breaches > 0 || gaps > 0) && (
        <div className="border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
          {breaches > 0 ? (
            <p className="font-semibold text-rose-700 dark:text-rose-400">
              {breaches} משמרות ללא מספיק מתנדבים כדי לעמוד ברצפה. שום מנוע שיבוץ לא יוכל לאייש
              אותן - צריך לפנות למאבטחים.
            </p>
          ) : (
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              {gaps} משמרות יאוישו מתחת ליעד, אך מעל הרצפה.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
