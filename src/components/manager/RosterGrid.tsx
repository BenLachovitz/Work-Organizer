import { Card, cn } from '@/components/ui';
import { HEBREW_DAYS_SHORT, formatDayMonth, weekDates, type DateKey } from '@/lib/dates';
import {
  SEGMENTS,
  SEGMENT_DEFS,
  SHIFTS,
  SHIFT_TYPES,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type MorningTarget,
  type Segment,
} from '@/lib/shifts';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * The generated roster, shown by SEGMENT rather than by shift.
 *
 * Showing shifts would hide the thing a manager most needs to see: a guard on
 * day12 is covering two segments at once, so a "morning" row and an "afternoon"
 * row would each look short by one while the day is actually fully staffed.
 * Rows are the four coverage windows, and a 12h guard appears in both of theirs.
 */
export function RosterGrid({
  weekStart,
  morningTarget,
  assignments,
  guards,
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  assignments: ScheduleAssignment[];
  guards: Profile[];
}) {
  const dates = weekDates(weekStart);
  const nameOf = (id: string) =>
    guards.find((g) => g.id === id)?.display_name ?? '—';

  const inSegment = (date: DateKey, seg: Segment) =>
    assignments.filter(
      (a) => a.target_date === date && SHIFTS[a.shift].covers.includes(seg),
    );

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">הסידור שנוצר</p>
        <p className="mt-0.5 text-sm text-slate-500">
          לפי חלונות כיסוי. מאבטח במשמרת 12 שעות מופיע בשני החלונות שהוא מכסה.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-separate border-spacing-1 p-3">
          <thead>
            <tr>
              <th className="w-28" />
              {dates.map((d, i) => (
                <th key={d} className="pb-1 text-center">
                  <div
                    className={cn(
                      'text-xs font-bold',
                      isWeekendDay(i) ? 'text-amber-600' : 'text-slate-600',
                    )}
                  >
                    {HEBREW_DAYS_SHORT[i]}
                  </div>
                  <div className="text-[10px] font-normal text-slate-400">
                    {formatDayMonth(d).replace(/ב/, '')}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((seg) => (
              <tr key={seg}>
                <td className="pe-2 align-top">
                  <div className="text-xs font-bold text-slate-700">{SEGMENT_DEFS[seg].he}</div>
                  <div className="num text-[10px] text-slate-400">{SEGMENT_DEFS[seg].label}</div>
                </td>
                {dates.map((date, dayIndex) => {
                  const here = inSegment(date, seg);
                  const floor = segmentFloors(morningTarget, dayIndex)[seg];
                  const target = segmentTargets(morningTarget, dayIndex)[seg];
                  const below = here.length < floor;
                  const short = !below && here.length < target;

                  return (
                    <td key={date} className="align-top">
                      <div
                        className={cn(
                          'min-h-14 space-y-1 rounded-lg p-1.5 ring-1',
                          below
                            ? 'bg-rose-50 ring-rose-300'
                            : short
                              ? 'bg-amber-50 ring-amber-200'
                              : 'bg-emerald-50/60 ring-emerald-200',
                        )}
                      >
                        {here.map((a) => (
                          <div
                            key={a.id}
                            title={`${SHIFTS[a.shift].he} ${SHIFTS[a.shift].label}`}
                            className="truncate rounded px-1.5 py-1 text-[11px] font-semibold text-white"
                            style={{ backgroundColor: SHIFTS[a.shift].colorVar }}
                          >
                            {nameOf(a.guard_id)}
                          </div>
                        ))}
                        {here.length === 0 && (
                          <div className="grid h-10 place-items-center text-[11px] font-bold text-rose-600">
                            ריק
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 px-4 py-2.5">
        {SHIFT_TYPES.map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <span
              className="size-3 rounded"
              style={{ backgroundColor: SHIFTS[s].colorVar }}
            />
            {SHIFTS[s].he}
          </span>
        ))}
      </div>
    </Card>
  );
}
