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
  mine,
}: {
  assignment: ScheduleAssignment;
  name: string;
  suffix?: string;
  className?: string;
  /** The viewer's own shift. A guard must be able to find themselves at a glance. */
  mine?: boolean;
}) {
  return (
    <span
      className={cn(
        'flex items-center justify-center gap-1 rounded px-1.5 py-1',
        'text-[11px] font-semibold text-white',
        // A ring rather than a different colour: the colour already encodes the
        // shift type, and overloading it would cost more than it gains.
        mine && 'ring-2 ring-slate-900 ring-offset-1',
        className,
      )}
      style={{ backgroundColor: SHIFTS[assignment.shift].colorVar }}
      title={`${SHIFTS[assignment.shift].he} ${SHIFTS[assignment.shift].label}`}
    >
      {/* Flex `gap`, not a margin. A literal space is stripped by JSX at a line
          boundary, and `ms-1` resolves against the SUFFIX's own direction --
          which .num sets to ltr -- so the margin landed on the far side and the
          text still read "בןמ 18:45". gap is direction-agnostic. */}
      <span className="truncate">{name}</span>
      {suffix && <span className="num shrink-0 font-normal opacity-90">{suffix}</span>}
    </span>
  );
}

export function RosterGrid({
  weekStart,
  morningTarget,
  assignments,
  guards,
  highlightGuardId,
  todayDate,
  title = 'הסידור שנוצר',
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  assignments: ScheduleAssignment[];
  guards: Profile[];
  /** Ring this guard's chips. Set on the guard-facing view so a person can
   *  locate their own shifts without reading every name. */
  highlightGuardId?: string;
  /** Emphasise this column. Only meaningful for a week in progress. */
  todayDate?: DateKey;
  /** The manager sees "the roster that was generated"; a guard just sees the roster. */
  title?: string;
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
    { key: 'morning', he: 'בוקר', label: '06:45-14:45', segs: ['S1'] as Segment[] },
    { key: 'afternoon', he: 'צהריים', label: '14:45-22:45', segs: ['S2', 'S3'] as Segment[] },
    { key: 'night', he: 'לילה', label: '22:45-06:45', segs: ['S4'] as Segment[] },
  ] as const;

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">{title}</p>
        <p className="mt-0.5 text-sm text-slate-500">
          משמרת 12 שעות מסומנת ״עד 18:45״ או ״מ 18:45״. בצהריים, שני שמות מופרדים ב־/ הם חילוף
          ב־18:45 - הראשון עד, השני מ־18:45.
        </p>
      </div>

      <div className="overflow-x-auto">
        {/* Narrower than before: stacking the handover means a column only has
            to fit one name, not two side by side. */}
        <table className="w-full min-w-[34rem] border-separate border-spacing-1 p-3">
          <thead>
            <tr>
              <th className="w-16" />
              {dates.map((d, i) => (
                <th key={d} className="pb-1 text-center">
                  <div
                    className={cn(
                      'rounded text-xs font-bold',
                      d === todayDate && 'bg-brand-600 text-white',
                      d !== todayDate && (isWeekendDay(i) ? 'text-amber-600' : 'text-slate-700'),
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
                  <div className="text-right text-xs font-bold text-slate-800">{block.he}</div>
                  {/* .num forces direction: ltr, which pushed the time to the
                      LEFT edge while the Hebrew label sat at the right. Pinning
                      it right lines the two up and reclaims the gap between. */}
                  <div className="num text-right text-[10px] text-slate-400">{block.label}</div>
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
                          mine={a.guard_id === highlightGuardId}
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
                          mine={a.guard_id === highlightGuardId}
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
                            mine={r.full.guard_id === highlightGuardId}
                          />
                        ) : (
                          // The handover, written the way the spreadsheet does:
                          // "ים / שלי", names only. The 12h annotation belongs
                          // on the morning and night blocks, where it says
                          // something the reader cannot otherwise infer. Here
                          // the slash IS the 18:45 boundary, so repeating the
                          // time on both halves was noise -- and it was that
                          // noise, not the layout, that forced the columns wide.
                          <div key={i} className="flex items-stretch gap-1">
                            {r.early ? (
                              <Chip
                                assignment={r.early}
                                name={nameOf(r.early.guard_id)}
                                className="min-w-0 flex-1"
                                mine={r.early.guard_id === highlightGuardId}
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
                                mine={r.late.guard_id === highlightGuardId}
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

/**
 * An uncovered half of a handover -- shown, not hidden.
 *
 * Just a dash, as the spreadsheet writes it ("לוק / -"). Its POSITION says
 * which half is empty: before the slash is 14:45-18:45, after it is
 * 18:45-22:45. Spelling the window out again only repeated what the layout
 * already encodes.
 */
function Gap() {
  return (
    <span
      title="אין כיסוי בחצי הזה של המשמרת"
      className="grid min-w-0 flex-1 place-items-center rounded bg-rose-100 px-1.5 py-1 text-[11px] font-bold text-rose-500 ring-1 ring-rose-200"
    >
      —
    </span>
  );
}
