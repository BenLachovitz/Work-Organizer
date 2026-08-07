import { Card, cn } from '@/components/ui';
import { HEBREW_DAYS_SHORT, formatDayMonth, weekDates, type DateKey } from '@/lib/dates';
import {
  SHIFTS,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type MorningTarget,
  type Segment,
} from '@/lib/shifts';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * The roster laid out the way the manager's spreadsheet already does it: three
 * time blocks, with the 12h shifts annotated and the 18:45 handover shown
 * inside a single afternoon cell.
 *
 *   morning      ניתאי          a plain 8h morning
 *                ים עד 18:45    a day12, working through to 18:45
 *   afternoon    לוק            a plain 8h afternoon, covers the whole block
 *                ים / שלי       HANDOVER: ים until 18:45, שלי from 18:45
 *   night        שלי מ 18:45    a night12, on since 18:45
 *
 * A day12 guard therefore appears twice -- once in the morning block and once
 * as the first half of an afternoon handover -- because that is what they are
 * actually doing. Listing the four raw coverage segments as separate rows shows
 * the same facts but in a shape nobody reads a roster in.
 */

interface AfternoonRow {
  early: ScheduleAssignment | null; // 14:45-18:45
  late: ScheduleAssignment | null; // 18:45-22:45
  full: ScheduleAssignment | null; // 14:45-22:45, a plain afternoon shift
}

/**
 * Builds the afternoon rows.
 *
 * Full-block guards take a row each; the partial coverers left over are then
 * paired up into handovers. An unpaired half renders as "name / -", which is
 * how the spreadsheet shows a genuinely uncovered stretch rather than hiding it.
 */
export function buildAfternoonRows(
  dayAssignments: ScheduleAssignment[],
  slots: number,
): AfternoonRow[] {
  const full = dayAssignments.filter((a) => a.shift === 'afternoon');
  const early = dayAssignments.filter((a) => a.shift === 'day12');
  const late = dayAssignments.filter((a) => a.shift === 'night12');

  const rows: AfternoonRow[] = full.map((a) => ({ early: null, late: null, full: a }));

  const pairs = Math.max(early.length, late.length);
  for (let i = 0; i < pairs; i++) {
    rows.push({ early: early[i] ?? null, late: late[i] ?? null, full: null });
  }

  while (rows.length < slots) rows.push({ early: null, late: null, full: null });
  return rows;
}

function Chip({
  assignment,
  name,
  suffix,
  className,
}: {
  assignment: ScheduleAssignment;
  name: string;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate rounded px-1.5 py-1 text-[11px] font-semibold text-white',
        className,
      )}
      style={{ backgroundColor: SHIFTS[assignment.shift].colorVar }}
      title={`${SHIFTS[assignment.shift].he} ${SHIFTS[assignment.shift].label}`}
    >
      {name}
      {suffix && <span className="num font-normal opacity-90"> {suffix}</span>}
    </span>
  );
}

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
  const nameOf = (id: string) => guards.find((g) => g.id === id)?.display_name ?? '—';

  const onDay = (date: DateKey) => assignments.filter((a) => a.target_date === date);

  /** Coverage of one segment on one day, for the shortfall colouring. */
  const covers = (date: DateKey, seg: Segment) =>
    onDay(date).filter((a) => SHIFTS[a.shift].covers.includes(seg)).length;

  const cellTone = (date: DateKey, dayIndex: number, segs: Segment[]) => {
    const floors = segmentFloors(morningTarget, dayIndex);
    const targets = segmentTargets(morningTarget, dayIndex);
    const below = segs.some((s) => covers(date, s) < floors[s]);
    const short = !below && segs.some((s) => covers(date, s) < targets[s]);
    return below
      ? 'bg-rose-50 ring-rose-300'
      : short
        ? 'bg-amber-50 ring-amber-200'
        : 'bg-emerald-50/60 ring-emerald-200';
  };

  const blocks = [
    { key: 'morning', he: 'בוקר', label: '06:45 - 14:45', segs: ['S1'] as Segment[] },
    { key: 'afternoon', he: 'צהריים', label: '14:45 - 22:45', segs: ['S2', 'S3'] as Segment[] },
    { key: 'night', he: 'לילה', label: '22:45 - 06:45', segs: ['S4'] as Segment[] },
  ] as const;

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">הסידור שנוצר</p>
        <p className="mt-0.5 text-sm text-slate-500">
          משמרת 12 שעות מסומנת ״עד 18:45״ או ״מ 18:45״. תא צהריים עם שני שמות הוא חילוף ב־18:45.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-separate border-spacing-1 p-3">
          <thead>
            <tr>
              <th className="w-24" />
              {dates.map((d, i) => (
                <th key={d} className="pb-1 text-center">
                  <div
                    className={cn(
                      'text-xs font-bold',
                      isWeekendDay(i) ? 'text-amber-600' : 'text-slate-700',
                    )}
                  >
                    {HEBREW_DAYS_SHORT[i]}
                  </div>
                  <div className="num text-[10px] font-normal text-slate-400">
                    {formatDayMonth(d).replace(/\sב.*/, '')}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {blocks.map((block) => (
              <tr key={block.key}>
                <td className="pe-2 align-top">
                  <div className="text-xs font-bold text-slate-800">{block.he}</div>
                  <div className="num text-[10px] text-slate-400">{block.label}</div>
                </td>

                {dates.map((date, dayIndex) => {
                  const day = onDay(date);
                  const tone = cellTone(date, dayIndex, block.segs);

                  let content: React.ReactNode;

                  if (block.key === 'morning') {
                    // morning + day12; day12 is annotated as running to 18:45
                    const rows = day.filter(
                      (a) => a.shift === 'morning' || a.shift === 'day12',
                    );
                    content = rows.length ? (
                      rows.map((a) => (
                        <Chip
                          key={a.id}
                          assignment={a}
                          name={nameOf(a.guard_id)}
                          suffix={a.shift === 'day12' ? 'עד 18:45' : undefined}
                        />
                      ))
                    ) : (
                      <Empty />
                    );
                  } else if (block.key === 'night') {
                    // night + night12; night12 is annotated as on since 18:45
                    const rows = day.filter(
                      (a) => a.shift === 'night' || a.shift === 'night12',
                    );
                    content = rows.length ? (
                      rows.map((a) => (
                        <Chip
                          key={a.id}
                          assignment={a}
                          name={nameOf(a.guard_id)}
                          suffix={a.shift === 'night12' ? 'מ 18:45' : undefined}
                        />
                      ))
                    ) : (
                      <Empty />
                    );
                  } else {
                    const rows = buildAfternoonRows(day, 2).filter(
                      (r) => r.full || r.early || r.late,
                    );
                    content = rows.length ? (
                      rows.map((r, i) =>
                        r.full ? (
                          <Chip
                            key={r.full.id}
                            assignment={r.full}
                            name={nameOf(r.full.guard_id)}
                          />
                        ) : (
                          // The handover, read right-to-left: earlier first.
                          <div key={i} className="flex items-stretch gap-1">
                            {r.early ? (
                              <Chip
                                assignment={r.early}
                                name={nameOf(r.early.guard_id)}
                                className="min-w-0 flex-1"
                              />
                            ) : (
                              <Gap />
                            )}
                            <span className="self-center text-[10px] font-bold text-slate-400">
                              /
                            </span>
                            {r.late ? (
                              <Chip
                                assignment={r.late}
                                name={nameOf(r.late.guard_id)}
                                className="min-w-0 flex-1"
                              />
                            ) : (
                              <Gap />
                            )}
                          </div>
                        ),
                      )
                    ) : (
                      <Empty />
                    );
                  }

                  return (
                    <td key={date} className="align-top">
                      <div className={cn('min-h-14 space-y-1 rounded-lg p-1.5 ring-1', tone)}>
                        {content}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2.5 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded" style={{ backgroundColor: SHIFTS.morning.colorVar }} />
          בוקר
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded" style={{ backgroundColor: SHIFTS.day12.colorVar }} />
          יום 12ש׳
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded" style={{ backgroundColor: SHIFTS.afternoon.colorVar }} />
          צהריים
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded" style={{ backgroundColor: SHIFTS.night12.colorVar }} />
          לילה 12ש׳
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded" style={{ backgroundColor: SHIFTS.night.colorVar }} />
          לילה
        </span>
      </div>
    </Card>
  );
}

function Empty() {
  return (
    <div className="grid h-10 place-items-center text-[11px] font-bold text-rose-600">ריק</div>
  );
}

/** An uncovered half of a handover -- shown, not hidden. */
function Gap() {
  return (
    <span className="grid min-w-0 flex-1 place-items-center rounded bg-rose-100 px-1.5 py-1 text-[11px] font-bold text-rose-600 ring-1 ring-rose-200">
      —
    </span>
  );
}
