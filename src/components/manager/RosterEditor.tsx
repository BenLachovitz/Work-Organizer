import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, cn } from '@/components/ui';
import { widestRosterColumn } from '@/lib/measureColumns';
import {
  HEBREW_DAYS,
  HEBREW_DAYS_SHORT,
  dayIndexInWeek,
  formatDayMonth,
  weekDates,
  type DateKey,
} from '@/lib/dates';
import {
  SHIFTS,
  SHIFT_TYPES,
  classifyRest,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type MorningTarget,
  type MorningTargetOverrides,
  type Segment,
  type SecondaryTargetOverrides,
  type ShiftType,
} from '@/lib/shifts';
import { verifySchedule, type Violation } from '@/lib/validate';
import type { SolverInput } from '@/lib/solverContract';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * Manual editing of a draft roster.
 *
 * The manager knows things the solver cannot -- who is covering for whom, who
 * asked in person. But a hand edit can break rules the DATABASE cannot catch:
 * the one_shift_per_guard_per_day index stops a double booking, and nothing
 * else stops a clopen, a sixth shift, or assigning somebody who never marked
 * that day. So every edit is re-judged by the same referee the solver answers
 * to, and the result is split in two:
 *
 *   BLOCKING  — physically unsafe. Rest below 8 hours (H5/H7) and two shifts in
 *               one day (H3). Save is refused.
 *   WARNING   — policy, which the manager may knowingly override. Not on the
 *               guard's submitted availability (H1), no 12h opt-in (H2), over
 *               the 5-shift ceiling (H4), above the target ceiling (H6).
 *
 * That split is deliberate: Ben's stated rule is "we can't have an unoccupied
 * shift", and in practice he phones someone who did not volunteer. The editor
 * has to permit that while still refusing to put anybody on a clopen.
 */

const BLOCKING_RULES: Violation['rule'][] = ['H3', 'H5', 'H7'];

/** Width of the block-label column; the day columns divide the rest. */
const LABEL_COLUMN = 64;

export interface DraftAssignment {
  key: string; // stable local id; assignments are rebuilt wholesale on save
  guard_id: string;
  shift: ShiftType;
  date: DateKey;
  /** Free text rendered before/after the guard's name on this cell (§2.2c) -- empty string, not undefined, so the SlotEditor's inputs stay controlled. */
  noteBefore: string;
  noteAfter: string;
}

let seq = 0;
const newKey = () => `n${seq++}`;

export function RosterEditor({
  weekStart,
  morningTarget,
  morningTargetOverrides,
  segmentTargetOverrides,
  assignments,
  guards,
  solverInput,
  saving,
  onCancel,
  onSave,
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  /** Per-day exceptions to morningTarget for this week (§1). */
  morningTargetOverrides?: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of 2 (§1). */
  segmentTargetOverrides?: SecondaryTargetOverrides;
  assignments: ScheduleAssignment[];
  guards: Profile[];
  /** The same input the solver saw, so the referee judges identically. */
  solverInput: SolverInput;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: DraftAssignment[]) => void;
}) {
  const [draft, setDraft] = useState<DraftAssignment[]>(() =>
    assignments.map((a) => ({
      key: a.id,
      guard_id: a.guard_id,
      shift: a.shift,
      date: a.target_date,
      noteBefore: a.note_before ?? '',
      noteAfter: a.note_after ?? '',
    })),
  );
  const [openCell, setOpenCell] = useState<{ date: DateKey; block: BlockKey } | null>(null);

  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const nameOf = (id: string) => guards.find((g) => g.id === id)?.display_name ?? '—';

  // Measuring before the web font loads reads short, so re-measure once it is
  // ready -- otherwise the columns are sized for the fallback font's metrics.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Re-measures as the manager edits: swapping in a longer name widens every
  // column rather than clipping that one cell.
  const columnWidth = useMemo(
    () =>
      widestRosterColumn(
        dates,
        draft.map((d) => ({
          target_date: d.date,
          shift: d.shift,
          guard_id: d.guard_id,
          note_before: d.noteBefore,
          note_after: d.noteAfter,
        })),
        nameOf,
        { handover: false },
      ),
    [dates, draft, guards, fontsReady],
  );

  // --- referee -------------------------------------------------------------
  const verdict = useMemo(
    () =>
      verifySchedule(solverInput, {
        status: 'EDITED',
        objective_value: 0,
        assignments: draft.map((d) => ({
          day: dayIndexInWeek(weekStart, d.date),
          date: d.date,
          shift: d.shift,
          guard_id: d.guard_id,
        })),
        coverage_report: {
          floor_breaches: [],
          target_gaps: [],
          unmet_kamut: [],
          rest_violations: [],
        },
      }),
    [draft, solverInput, weekStart],
  );

  const blocking = verdict.violations.filter((v) => BLOCKING_RULES.includes(v.rule));
  const warnings = verdict.violations.filter((v) => !BLOCKING_RULES.includes(v.rule));
  const dirty =
    draft.length !== assignments.length ||
    draft.some((d) => {
      const orig = assignments.find((a) => a.id === d.key);
      return (
        !orig ||
        orig.guard_id !== d.guard_id ||
        orig.shift !== d.shift ||
        (orig.note_before ?? '') !== d.noteBefore ||
        (orig.note_after ?? '') !== d.noteAfter
      );
    });

  // --- edits ---------------------------------------------------------------
  const update = (key: string, patch: Partial<DraftAssignment>) =>
    setDraft((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: string) => setDraft((prev) => prev.filter((d) => d.key !== key));
  const add = (date: DateKey, shift: ShiftType, guard_id: string) =>
    setDraft((prev) => [
      ...prev,
      { key: newKey(), guard_id, shift, date, noteBefore: '', noteAfter: '' },
    ]);

  const onDate = (date: DateKey) => draft.filter((d) => d.date === date);

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
    const cov = (s: Segment) =>
      onDate(date).filter((d) => SHIFTS[d.shift].covers.includes(s)).length;
    if (segs.some((s) => cov(s) < floors[s]))
      return 'bg-rose-50 ring-rose-300 dark:bg-rose-950/40 dark:ring-rose-800';
    if (segs.some((s) => cov(s) < targets[s]))
      return 'bg-amber-50 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-800';
    return 'bg-emerald-50/60 ring-emerald-200 dark:bg-emerald-950/30 dark:ring-emerald-800';
  };

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <p className="font-bold text-slate-900 dark:text-slate-100">עריכת הסידור</p>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            לחץ על תא כדי לשנות שיבוץ. השינויים נשמרים רק בלחיצה על ״שמור״.
          </p>
        </div>
        <Badge tone={dirty ? 'amber' : 'slate'}>{dirty ? 'יש שינויים' : 'ללא שינויים'}</Badge>
      </div>

      {/* ---------------- grid ---------------- */}
      <div className="overflow-x-auto">
        {/* Columns all one width, measured from the longest name actually in the
            table rather than guessed. Stacked layout here, so no handover pair
            to fit -- see widestRosterColumn. */}
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
                      'text-xs font-bold',
                      isWeekendDay(i)
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-700 dark:text-slate-300',
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
            {BLOCKS.map((block) => (
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
                  const rows = onDate(date).filter((d) => block.shifts.includes(d.shift));
                  return (
                    <td key={date} className="align-top">
                      <button
                        type="button"
                        onClick={() => setOpenCell({ date, block: block.key })}
                        className={cn(
                          'min-h-14 w-full space-y-1 rounded-lg p-1.5 text-start ring-1 transition-shadow',
                          'hover:ring-2 hover:ring-brand-400',
                          cellTone(date, dayIndex, block.segs),
                        )}
                      >
                        {rows.length === 0 && (
                          <span className="grid h-10 place-items-center text-[11px] font-bold text-rose-600 dark:text-rose-400">
                            ריק
                          </span>
                        )}
                        {rows.map((d) => (
                          <span
                            key={d.key}
                            className="flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold text-white"
                            style={{ backgroundColor: SHIFTS[d.shift].colorVar }}
                          >
                            {d.noteBefore && (
                              <span className="shrink-0 text-[9px] font-normal opacity-90">
                                {d.noteBefore}
                              </span>
                            )}
                            <span className="truncate">{nameOf(d.guard_id)}</span>
                            {d.noteAfter && (
                              <span className="shrink-0 text-[9px] font-normal opacity-90">
                                {d.noteAfter}
                              </span>
                            )}
                            {/* Only the morning and night blocks carry the 12h
                                annotation; in the afternoon the slash already
                                marks the 18:45 boundary. */}
                            {SHIFTS[d.shift].isExtended && d.shift !== 'afternoon' && (
                              <span className="num shrink-0 text-[9px] font-normal opacity-90">
                                {d.shift === 'day12' ? 'עד 18:45' : 'מ 18:45'}
                              </span>
                            )}
                          </span>
                        ))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------- verdict ---------------- */}
      <div className="space-y-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
        {blocking.length > 0 && (
          <Alert tone="error" title={`${blocking.length} בעיות בטיחות - לא ניתן לשמור`}>
            <ul className="space-y-0.5">
              {blocking.slice(0, 5).map((v, i) => (
                <li key={i}>{humanise(v, nameOf)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert tone="warn" title={`${warnings.length} חריגות ממדיניות - אפשר לשמור בכל זאת`}>
            <ul className="space-y-0.5">
              {warnings.slice(0, 6).map((v, i) => (
                <li key={i}>{humanise(v, nameOf)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {blocking.length === 0 && warnings.length === 0 && (
          <Alert tone="success">הסידור עומד בכל הכללים.</Alert>
        )}

        <div className="flex gap-2">
          <Button
            fullWidth
            loading={saving}
            disabled={blocking.length > 0 || !dirty}
            onClick={() => onSave(draft)}
          >
            שמור שינויים
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            ביטול
          </Button>
        </div>
      </div>

      {openCell && (
        <SlotEditor
          weekStart={weekStart}
          date={openCell.date}
          block={BLOCKS.find((b) => b.key === openCell.block)!}
          rows={onDate(openCell.date).filter((d) =>
            BLOCKS.find((b) => b.key === openCell.block)!.shifts.includes(d.shift),
          )}
          guards={guards}
          solverInput={solverInput}
          onClose={() => setOpenCell(null)}
          onUpdate={update}
          onRemove={remove}
          onAdd={add}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

type BlockKey = 'morning' | 'afternoon' | 'night';

interface BlockDef {
  key: BlockKey;
  he: string;
  label: string;
  segs: Segment[];
  /** Shift types that appear in this block's row. */
  shifts: ShiftType[];
}

const BLOCKS: BlockDef[] = [
  { key: 'morning', he: 'בוקר', label: '06:45-14:45', segs: ['S1'], shifts: ['morning', 'day12'] },
  {
    key: 'afternoon',
    he: 'צהריים',
    label: '14:45-22:45',
    segs: ['S2', 'S3'],
    shifts: ['afternoon'],
  },
  { key: 'night', he: 'לילה', label: '22:45-06:45', segs: ['S4'], shifts: ['night', 'night12'] },
];

/** Turns a referee violation into something a manager can act on. */
function humanise(v: Violation, nameOf: (id: string) => string): string {
  const who = v.guardId ? nameOf(v.guardId) : '';
  const day = v.day !== undefined ? `יום ${HEBREW_DAYS[v.day] ?? v.day}` : '';
  switch (v.rule) {
    case 'H1':
      return `${who} לא סימן זמינות ב${day}`;
    case 'H2':
      return `${who} לא אישר משמרת 12 שעות ב${day}`;
    case 'H3':
      return `${who} משובץ ליותר ממשמרת אחת ב${day}`;
    case 'H4':
      return `${who} חורג מ-5 משמרות בשבוע`;
    case 'H5':
      return `${who}: פחות מ-8 שעות מנוחה אחרי ${day}`;
    case 'H6':
      return `${day}: יותר מדי מאבטחים במשמרת`;
    case 'H7':
      return `${who}: מנוחה קצרה מדי מהשבוע הקודם`;
    default:
      return v.message;
  }
}

// ---------------------------------------------------------------------------

function SlotEditor({
  weekStart,
  date,
  block,
  rows,
  guards,
  solverInput,
  onClose,
  onUpdate,
  onRemove,
  onAdd,
}: {
  weekStart: DateKey;
  date: DateKey;
  block: BlockDef;
  rows: DraftAssignment[];
  guards: Profile[];
  solverInput: SolverInput;
  onClose: () => void;
  onUpdate: (key: string, patch: Partial<DraftAssignment>) => void;
  onRemove: (key: string) => void;
  onAdd: (date: DateKey, shift: ShiftType, guardId: string) => void;
}) {
  const dayIdx = dayIndexInWeek(weekStart, date);
  const [addGuard, setAddGuard] = useState('');
  const [addShift, setAddShift] = useState<ShiftType>(block.shifts[0]!);

  /** Did this guard actually mark this shift? Shown, never enforced. */
  const marked = (guardId: string, shift: ShiftType) => {
    const g = solverInput.guards.find((x) => x.id === guardId);
    if (!g) return false;
    const base = SHIFTS[shift].requiresBase;
    if (!(g.availability[String(dayIdx)] ?? []).includes(base)) return false;
    if (shift === 'day12') return g.twelve_hour_day.includes(dayIdx);
    if (shift === 'night12') return g.twelve_hour_night.includes(dayIdx);
    return true;
  };

  /**
   * What this guard worked last Saturday. Only Sunday can collide with it, so
   * the hint is shown there and nowhere else -- a night-ending shift makes
   * Sunday morning a 0-hour rest, which the referee blocks outright.
   */
  const carriedIn = (guardId: string): ShiftType | null =>
    dayIdx === 0 ? (solverInput.carry_in?.[guardId] ?? null) : null;

  const carryNote = (guardId: string) => {
    const prev = carriedIn(guardId);
    if (!prev) return '';
    return `  (שבת: ${SHIFTS[prev].he})`;
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl dark:bg-slate-900">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <p className="font-bold text-slate-900 dark:text-slate-100">
              {block.he} · יום {HEBREW_DAYS[dayIdx]}
            </p>
            <p className="num text-xs text-slate-500 dark:text-slate-400">
              {formatDayMonth(date)} · {block.label}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {dayIdx === 0 && Object.keys(solverInput.carry_in ?? {}).length > 0 && (
          <p className="mb-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            יום ראשון: המנוחה נבדקת גם מול משמרות שבת של השבוע הקודם.
          </p>
        )}

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">
              אין אף אחד משובץ במשמרת הזו.
            </p>
          )}

          {rows.map((r) => (
            <div
              key={r.key}
              className="space-y-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800"
            >
              <div className="flex gap-2">
                <select
                  value={r.guard_id}
                  onChange={(e) => onUpdate(r.key, { guard_id: e.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                >
                  {guards.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.display_name}
                      {marked(g.id, r.shift) ? '' : '  (לא סימן)'}
                      {carryNote(g.id)}
                    </option>
                  ))}
                </select>
                <select
                  value={r.shift}
                  onChange={(e) => onUpdate(r.key, { shift: e.target.value as ShiftType })}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                >
                  {SHIFT_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {SHIFTS[s].he}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onRemove(r.key)}
                  className="rounded-lg bg-rose-100 px-2.5 text-sm font-bold text-rose-700 hover:bg-rose-200 dark:bg-rose-950/50 dark:text-rose-400 dark:hover:bg-rose-900/60"
                  title="הסר"
                >
                  ✕
                </button>
              </div>
              {/* Free text next to the guard's name -- e.g. "she's actually
                  coming at 10:45 and working a 12h day" -- without reshaping
                  the assignment itself into a different shift type (§2.2c).
                  Purely cosmetic: never read by the referee or the solver. */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={r.noteBefore}
                  onChange={(e) => onUpdate(r.key, { noteBefore: e.target.value })}
                  maxLength={40}
                  placeholder="הערה לפני השם"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                />
                <input
                  type="text"
                  value={r.noteAfter}
                  onChange={(e) => onUpdate(r.key, { noteAfter: e.target.value })}
                  maxLength={40}
                  placeholder="הערה אחרי השם"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
              {!marked(r.guard_id, r.shift) && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  ⚠ לא סומן על ידי המאבטח - שיבוץ ידני
                </p>
              )}
              {carriedIn(r.guard_id) && (
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  עבד {SHIFTS[carriedIn(r.guard_id)!].he} בשבת שעברה
                  {classifyRest(carriedIn(r.guard_id)!, r.shift) === 'blocked' && (
                    <span className="font-bold text-rose-700 dark:text-rose-400">
                      {' '}
                      — מנוחה קצרה מדי, לא ניתן לשמור
                    </span>
                  )}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* ---------------- add ---------------- */}
        <div className="mt-3 space-y-2 rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-600">
          <p className="text-xs font-bold text-slate-600 dark:text-slate-300">הוספת מאבטח</p>
          <div className="flex gap-2">
            <select
              value={addGuard}
              onChange={(e) => setAddGuard(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">בחר מאבטח…</option>
              {guards.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.display_name}
                  {marked(g.id, addShift) ? '' : '  (לא סימן)'}
                  {carryNote(g.id)}
                </option>
              ))}
            </select>
            <select
              value={addShift}
              onChange={(e) => setAddShift(e.target.value as ShiftType)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              {block.shifts.map((s) => (
                <option key={s} value={s}>
                  {SHIFTS[s].he}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!addGuard}
              onClick={() => {
                onAdd(date, addShift, addGuard);
                setAddGuard('');
              }}
            >
              הוסף
            </Button>
          </div>
          {block.key === 'afternoon' && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              משמרת 12 שעות מתווספת דרך הבוקר (עד 18:45) או דרך הלילה (מ-18:45).
            </p>
          )}
        </div>

        <Button className="mt-3" fullWidth variant="secondary" onClick={onClose}>
          סגור
        </Button>
      </div>
    </div>
  );
}
