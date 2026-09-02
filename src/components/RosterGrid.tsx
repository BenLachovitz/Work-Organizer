import { useEffect, useMemo, useState } from 'react';
import { Card, cn } from '@/components/ui';
import { widestRosterColumn } from '@/lib/measureColumns';
import { HEBREW_DAYS_SHORT, formatDayMonth, weekDates, type DateKey } from '@/lib/dates';
import {
  SHIFTS,
  doubleShiftSuffix,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type DoubleShiftHours,
  type MorningTarget,
  type MorningTargetOverrides,
  type Segment,
  type SecondaryTargetOverrides,
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

/** Width of the block-label column; the day columns divide the rest. */
const LABEL_COLUMN = 64;

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
  earlySlots: number,
  lateSlots: number,
): AfternoonRow[] {
  const full = dayAssignments.filter((a) => a.shift === 'afternoon');
  // afternoon_early/afternoon_late (migration 53) occupy just one half of the
  // handover, same as day12/night12 already do -- paired the identical way.
  const early = dayAssignments.filter((a) => a.shift === 'day12' || a.shift === 'afternoon_early');
  const late = dayAssignments.filter((a) => a.shift === 'night12' || a.shift === 'afternoon_late');

  const rows: AfternoonRow[] = full.map((a) => ({ early: null, late: null, full: a }));

  const pairs = Math.max(early.length, late.length);
  for (let i = 0; i < pairs; i++) {
    rows.push({ early: early[i] ?? null, late: late[i] ?? null, full: null });
  }

  // A placeholder (guard_id === null) renders as an extra row but is not a
  // real body -- it must never count against the target, or a cosmetic note
  // could silently hide a real coverage gap underneath it. So padding is
  // driven by how many REAL (or explicitly coverage-occupying, §12.9
  // migration 52) rows exist, not by rows.length.
  const occupies = (a: ScheduleAssignment | null | undefined) =>
    a != null && (a.guard_id != null || a.occupies_slot);
  const realFull = full.filter(occupies).length;
  let realPairs = 0;
  for (let i = 0; i < pairs; i++) {
    if (occupies(early[i]) || occupies(late[i])) realPairs++;
  }
  const realRows = realFull + realPairs;

  // Early (S2) and late (S3) can now carry independent per-day targets, so
  // pad up to whichever side demands more rows -- the same "at least N rows,
  // a Chip where a real assignment exists, a Gap elsewhere" contract as
  // before, just driven by two targets instead of one shared one.
  const slots = Math.max(earlySlots, lateSlots);
  for (let i = realRows; i < slots; i++) rows.push({ early: null, late: null, full: null });
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
        mine && 'ring-2 ring-slate-900 ring-offset-1 dark:ring-slate-100 dark:ring-offset-slate-900',
        className,
      )}
      style={{ backgroundColor: SHIFTS[assignment.shift].colorVar }}
      title={`${SHIFTS[assignment.shift].he} ${SHIFTS[assignment.shift].label}`}
    >
      {/* Flex `gap`, not a margin. A literal space is stripped by JSX at a line
          boundary, and `ms-1` resolves against the SUFFIX's own direction --
          which .num sets to ltr -- so the margin landed on the far side and the
          text still read "בןמ 18:45". gap is direction-agnostic. */}
      {assignment.note_before && (
        <span className="shrink-0 text-[9px] font-normal opacity-90">
          {assignment.note_before}
        </span>
      )}
      {name && <span className="truncate">{name}</span>}
      {assignment.note_after && (
        <span className="shrink-0 text-[9px] font-normal opacity-90">{assignment.note_after}</span>
      )}
      {suffix && <span className="num shrink-0 text-[9px] font-normal opacity-90">{suffix}</span>}
    </span>
  );
}

export function RosterGrid({
  weekStart,
  morningTarget,
  morningTargetOverrides,
  segmentTargetOverrides,
  doubleShiftHours = 12,
  assignments,
  guards,
  highlightGuardId,
  todayDate,
  title = 'הסידור שנוצר',
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  /** Per-day exceptions to morningTarget for this week (§1). */
  morningTargetOverrides?: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of 2 (§1). */
  segmentTargetOverrides?: SecondaryTargetOverrides;
  /** Display-only 12h/11h handover-text setting for this week (§1). */
  doubleShiftHours?: DoubleShiftHours;
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
  // A placeholder (id === null) has no name at all -- '' lets the note text
  // carry the whole chip, distinct from '—', which flags a real data problem
  // (an id that doesn't match any known guard).
  const nameOf = (id: string | null) => (id ? (guards.find((g) => g.id === id)?.display_name ?? '—') : '');

  // Text measured with the web font still loading comes back too narrow, so
  // re-measure once it is ready. Without this the first paint sets a width
  // based on the fallback font and the names clip.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Every column takes the width of the WIDEST cell in the table -- almost
  // always an afternoon handover, which holds two names and a slash.
  const columnWidth = useMemo(
    () => widestRosterColumn(dates, assignments, nameOf),
    [weekStart, assignments, guards, fontsReady],
  );

  const onDay = (date: DateKey) => assignments.filter((a) => a.target_date === date);

  /** Coverage of one segment on one day, for the shortfall colouring. A
   *  placeholder (§12.9) is not a real body and must never count toward it,
   *  unless it's explicitly marked as occupying a slot (migration 52). */
  const covers = (date: DateKey, seg: Segment) =>
    onDay(date).filter(
      (a) => (a.guard_id || a.occupies_slot) && SHIFTS[a.shift].covers.includes(seg),
    ).length;

  const cellTone = (date: DateKey, dayIndex: number, segs: Segment[]) => {
    const floors = segmentFloors(
      morningTarget,
      dayIndex,
      morningTargetOverrides,
      segmentTargetOverrides,
    );
    const targets = segmentTargets(
      morningTarget,
      dayIndex,
      morningTargetOverrides,
      segmentTargetOverrides,
    );
    const below = segs.some((s) => covers(date, s) < floors[s]);
    const short = !below && segs.some((s) => covers(date, s) < targets[s]);
    return below
      ? 'bg-rose-50 ring-rose-300 dark:bg-rose-950/40 dark:ring-rose-800'
      : short
        ? 'bg-amber-50 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-800'
        : 'bg-emerald-50/60 ring-emerald-200 dark:bg-emerald-950/30 dark:ring-emerald-800';
  };

  const blocks = [
    { key: 'morning', he: 'בוקר', label: '06:45-14:45', segs: ['S1'] as Segment[] },
    { key: 'afternoon', he: 'צהריים', label: '14:45-22:45', segs: ['S2', 'S3'] as Segment[] },
    { key: 'night', he: 'לילה', label: '22:45-06:45', segs: ['S4'] as Segment[] },
  ] as const;

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <p className="font-bold text-slate-900 dark:text-slate-100">{title}</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {doubleShiftHours === 12
            ? 'משמרת 12 שעות מסומנת ״עד 18:45״ או ״מ 18:45״.'
            : 'משמרת 12 שעות מסומנת ״עד 17:45״ או ״מ 19:45״, אלא אם אין כיסוי חלופי בצהריים באותו יום - אז התצוגה נשארת ״עד/מ 18:45״ כרגיל.'}{' '}
          בצהריים, שני שמות מופרדים ב־/ הם חילוף ב־18:45 - הראשון עד, השני מ־18:45.
        </p>
      </div>

      <div className="overflow-x-auto">
        {/* Equal columns, but the width is MEASURED rather than guessed: see
            widestRosterColumn. A hardcoded width was wide enough for a single
            name and clipped "יובל / שלי" down to "יו... / ע...". */}
        <table
          className="table-fixed border-separate border-spacing-1 p-3"
          style={{ minWidth: LABEL_COLUMN + columnWidth * 7 + 32 }}
        >
          <colgroup>
            <col style={{ width: LABEL_COLUMN }} />
            {dates.map((d) => (
              <col key={d} style={{ width: columnWidth }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th />
              {dates.map((d, i) => (
                <th key={d} className="pb-1 text-center">
                  <div
                    className={cn(
                      'rounded text-xs font-bold',
                      d === todayDate && 'bg-brand-600 text-white',
                      d !== todayDate &&
                        (isWeekendDay(i)
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-700 dark:text-slate-300'),
                    )}
                  >
                    {HEBREW_DAYS_SHORT[i]}
                  </div>
                  <div className="num text-[10px] font-normal text-slate-400 dark:text-slate-500">
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
                  <div className="text-right text-xs font-bold text-slate-800 dark:text-slate-200">
                    {block.he}
                  </div>
                  {/* .num forces direction: ltr, which pushed the time to the
                      LEFT edge while the Hebrew label sat at the right. Pinning
                      it right lines the two up and reclaims the gap between. */}
                  <div className="num text-right text-[10px] text-slate-400 dark:text-slate-500">
                    {block.label}
                  </div>
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
                    const target = segmentTargets(
                      morningTarget,
                      dayIndex,
                      morningTargetOverrides,
                      segmentTargetOverrides,
                    ).S1;
                    // A placeholder (§12.9) renders as an extra chip but is
                    // not a real body -- gap padding is driven by the REAL (or
                    // explicitly coverage-occupying, migration 52) count, or a
                    // cosmetic note could hide a genuine shortfall.
                    const realCount = rows.filter((a) => a.guard_id != null || a.occupies_slot).length;
                    content = rows.length ? (
                      <>
                        {rows.map((a) => (
                          <Chip
                            key={a.id}
                            assignment={a}
                            name={nameOf(a.guard_id)}
                            suffix={
                              a.shift === 'day12'
                                ? doubleShiftSuffix('day12', a, day, doubleShiftHours)
                                : undefined
                            }
                            mine={a.guard_id === highlightGuardId}
                          />
                        ))}
                        {/* Filled but short of target: a dash per missing slot,
                            same convention as an unpaired handover half --
                            shown, not hidden. Fully empty stays "ריק" below,
                            the stronger signal for nobody at all. */}
                        {Array.from({ length: Math.max(0, target - realCount) }, (_, i) => (
                          <Gap key={`gap-${i}`} />
                        ))}
                      </>
                    ) : (
                      <Empty />
                    );
                  } else if (block.key === 'night') {
                    // night + night12; night12 is annotated as on since 18:45
                    const rows = day.filter(
                      (a) => a.shift === 'night' || a.shift === 'night12',
                    );
                    const target = segmentTargets(
                      morningTarget,
                      dayIndex,
                      morningTargetOverrides,
                      segmentTargetOverrides,
                    ).S4;
                    const realCount = rows.filter((a) => a.guard_id != null || a.occupies_slot).length;
                    content = rows.length ? (
                      <>
                        {rows.map((a) => (
                          <Chip
                            key={a.id}
                            assignment={a}
                            name={nameOf(a.guard_id)}
                            suffix={
                              a.shift === 'night12'
                                ? doubleShiftSuffix('night12', a, day, doubleShiftHours)
                                : undefined
                            }
                            mine={a.guard_id === highlightGuardId}
                          />
                        ))}
                        {Array.from({ length: Math.max(0, target - realCount) }, (_, i) => (
                          <Gap key={`gap-${i}`} />
                        ))}
                      </>
                    ) : (
                      <Empty />
                    );
                  } else {
                    const afternoonTargets = segmentTargets(
                      morningTarget,
                      dayIndex,
                      morningTargetOverrides,
                      segmentTargetOverrides,
                    );
                    const rows = buildAfternoonRows(
                      day,
                      afternoonTargets.S2,
                      afternoonTargets.S3,
                    );
                    const anyCoverage = rows.some((r) => r.full || r.early || r.late);
                    content = anyCoverage ? (
                      rows.map((r, i) =>
                        r.full ? (
                          <Chip
                            key={r.full.id}
                            assignment={r.full}
                            name={nameOf(r.full.guard_id)}
                            mine={r.full.guard_id === highlightGuardId}
                          />
                        ) : r.early || r.late ? (
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
                            <span className="self-center text-[10px] font-bold text-slate-400 dark:text-slate-500">
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
                        ) : (
                          // Neither a full-block guard nor either handover half
                          // showed up for this slot -- there's nothing to say it
                          // would have been a handover rather than a plain shift,
                          // so this reads the same single-dash way morning/night
                          // show a missing guard, not split into an early/late pair.
                          <Gap key={`gap-${i}`} />
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

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2.5 text-[11px] dark:border-slate-800 dark:text-slate-300">
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
    <div className="grid h-10 place-items-center text-[11px] font-bold text-rose-600 dark:text-rose-400">
      ריק
    </div>
  );
}

/**
 * An uncovered slot -- shown, not hidden.
 *
 * Just a dash, as the spreadsheet writes it ("לוק / -"). Two uses: one half of
 * an unpaired handover (its POSITION says which half -- before the slash is
 * 14:45-18:45, after it is 18:45-22:45, so spelling the window out again would
 * only repeat what the layout already encodes), and a morning or night block
 * that has some coverage but fewer guards than its target -- one dash per
 * missing guard, alongside whoever IS assigned. A block with no one at all
 * still reads "ריק" (Empty, below); the dash is for a partial shortfall.
 */
function Gap() {
  return (
    <span
      title="אין כיסוי במשבצת הזו"
      className="grid min-w-0 flex-1 place-items-center rounded bg-rose-100 px-1.5 py-1 text-[11px] font-bold text-rose-500 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:text-rose-400 dark:ring-rose-800"
    >
      —
    </span>
  );
}
