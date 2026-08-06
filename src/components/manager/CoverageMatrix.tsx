import { Card, cn } from '@/components/ui';
import { HEBREW_DAYS_SHORT, type DateKey } from '@/lib/dates';
import { BASE_SHIFTS, SHIFTS, segmentFloors, segmentTargets, type MorningTarget } from '@/lib/shifts';
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
}: {
  cells: CoverageCell[];
  dates: DateKey[];
  morningTarget: MorningTarget;
}) {
  const floors = segmentFloors(morningTarget);
  const targets = segmentTargets(morningTarget);

  // The 8h shifts map onto segments: morning->S1, afternoon->S2/S3, night->S4.
  const need = {
    morning: { floor: floors.S1, target: targets.S1 },
    afternoon: { floor: floors.S2, target: targets.S2 },
    night: { floor: floors.S4, target: targets.S4 },
  } as const;

  const at = (date: DateKey, shift: string) =>
    cells.find((c) => c.date === date && c.shift === shift)?.available ?? 0;

  let breaches = 0;
  let gaps = 0;
  for (const d of dates) {
    for (const s of BASE_SHIFTS) {
      const a = at(d, s);
      if (a < need[s].floor) breaches++;
      else if (a < need[s].target) gaps++;
    }
  }

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">זמינות הצוות</p>
        <p className="mt-0.5 text-sm text-slate-500">
          כמה מאבטחים סימנו שהם יכולים לעבוד בכל משמרת
        </p>
      </div>

      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full min-w-[22rem] border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="w-16" />
              {dates.map((d, i) => (
                <th key={d} className="pb-1 text-center text-xs font-bold text-slate-500">
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
                  <span className="ms-1.5 align-middle text-xs font-bold text-slate-700">
                    {SHIFTS[shift].he}
                  </span>
                </td>
                {dates.map((date) => {
                  const a = at(date, shift);
                  const { floor, target } = need[shift];
                  const below = a < floor;
                  const short = !below && a < target;
                  return (
                    <td key={date} className="p-0">
                      <div
                        title={`${a} זמינים · רצפה ${floor} · יעד ${target}`}
                        className={cn(
                          'grid h-9 place-items-center rounded-lg text-sm font-bold tabular-nums',
                          below
                            ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300'
                            : short
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-emerald-100 text-emerald-800',
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

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2.5 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-emerald-100 ring-1 ring-emerald-300" />
          מספיק ליעד
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-amber-100 ring-1 ring-amber-300" />
          מעל הרצפה, מתחת ליעד
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded bg-rose-100 ring-1 ring-rose-300" />
          מתחת לרצפה
        </span>
      </div>

      {(breaches > 0 || gaps > 0) && (
        <div className="border-t border-slate-200 px-4 py-3 text-sm">
          {breaches > 0 ? (
            <p className="font-semibold text-rose-700">
              {breaches} משמרות ללא מספיק מתנדבים כדי לעמוד ברצפה. שום מנוע שיבוץ לא יוכל לאייש
              אותן - צריך לפנות למאבטחים.
            </p>
          ) : (
            <p className="font-semibold text-amber-700">
              {gaps} משמרות יאוישו מתחת ליעד, אך מעל הרצפה.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
