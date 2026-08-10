import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Modal, Stepper, cn } from '@/components/ui';
import {
  HEBREW_DAYS,
  formatDayMonth,
  formatDeadline,
  timeUntil,
  weekDates,
  type DateKey,
} from '@/lib/dates';
import {
  BASE_SHIFTS,
  MAX_SHIFTS_PER_WEEK,
  SHIFTS,
  effectiveKamut,
  isWeekendDay,
  maxFeasibleShifts as computeMaxFeasibleShifts,
  type BaseShift,
} from '@/lib/shifts';

/**
 * Selection state.
 *
 * Key is "YYYY-MM-DD|shift"; presence means available. The value carries the
 * two per-slot flags that ride alongside availability: whether the guard will
 * extend that specific shift to 12 hours, and whether they prefer it over
 * their other marked shifts. Keeping both inside the same entry is what makes
 * it impossible to be opted into either for a day you are not working --
 * removing the slot removes both with it, mirroring how `allows_12h` and
 * `strength` live on the preference row in the database.
 */
export interface SlotFlags {
  allows12h: boolean;
  strength: 1 | 2;
}
export type Selection = Map<string, SlotFlags>;

const slotKey = (date: DateKey, shift: BaseShift) => `${date}|${shift}`;

/** Only morning and night can extend (-> day12 / night12). */
const canExtend = (shift: BaseShift) => shift === 'morning' || shift === 'night';

const EXTENDED_OF: Record<'morning' | 'night', 'day12' | 'night12'> = {
  morning: 'day12',
  night: 'night12',
};

export function selectionToSlots(
  sel: Selection,
): { date: DateKey; shift: BaseShift; allows12h: boolean; strength: 1 | 2 }[] {
  return [...sel.entries()].map(([k, flags]) => {
    const [date, shift] = k.split('|');
    return { date: date!, shift: shift as BaseShift, ...flags };
  });
}

export function rowsToSelection(
  rows: { target_date: string; shift: BaseShift; allows_12h?: boolean; strength?: 1 | 2 }[],
): Selection {
  return new Map(
    rows.map((r) => [
      slotKey(r.target_date, r.shift),
      { allows12h: Boolean(r.allows_12h), strength: r.strength ?? 1 },
    ]),
  );
}

/** Matches the `notes_length` CHECK on weekly_submissions. */
export const NOTES_MAX_LENGTH = 500;

export interface PreferenceFormValue {
  slots: Selection;
  notes: string;
  /** Guard's preferred shift count for the week, or null for "no explicit
   *  request, defer to configured כמות" (also what an equal-to-configured
   *  pick normalises to on submit -- see effectiveKamut()/stretchTarget()
   *  in src/lib/shifts.ts for how a lower/higher request is applied). */
  requestedShifts: number | null;
}

export function WeeklyPreferenceForm({
  weekStart,
  deadline,
  locked,
  configuredKamut,
  initial,
  hasSubmitted = false,
  onSubmit,
  submitting = false,
  onDelete,
  deleting = false,
}: {
  weekStart: DateKey;
  deadline: Date;
  locked: boolean;
  configuredKamut: number;
  initial?: PreferenceFormValue;
  /** Whether a submission already exists for this week -- the cancel action
   *  below only makes sense when there is something to cancel. */
  hasSubmitted?: boolean;
  onSubmit: (value: PreferenceFormValue) => void;
  submitting?: boolean;
  /** Cancels the existing submission outright (delete_week_submission,
   *  migration 30) -- distinct from submitting an empty week (spec 3.4),
   *  which is a deliberate "I am unavailable" answer, not a withdrawal. */
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [slots, setSlots] = useState<Selection>(() => new Map(initial?.slots ?? []));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  // Defensively re-clamped at mount in case stored availability shrank since
  // a prior submission (e.g. the guard requested 4, then a later edit removed
  // enough days that 4 shifts are no longer feasible) -- the reactive clamp
  // below (tied to maxFeasibleShifts) handles it from here on.
  const [requestedShifts, setRequestedShifts] = useState(() => {
    const initialSlots = initial?.slots ?? new Map<string, SlotFlags>();
    const feasible = computeMaxFeasibleShifts(weekDates(weekStart), (date, shift) =>
      initialSlots.has(slotKey(date, shift)),
    );
    const base = initial?.requestedShifts ?? configuredKamut;
    return Math.max(0, Math.min(base, feasible, MAX_SHIFTS_PER_WEEK));
  });
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const left = timeUntil(deadline);

  const toggleSlot = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const next = new Map(prev);
      const k = slotKey(date, shift);
      // Deleting the slot drops its 12h flag and its strength automatically --
      // no orphan state.
      if (next.has(k)) next.delete(k);
      else next.set(k, { allows12h: false, strength: 1 });
      return next;
    });
  };

  const toggle12h = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const k = slotKey(date, shift);
      const cur = prev.get(k);
      if (!cur) return prev; // cannot extend a shift you are not working
      const next = new Map(prev);
      next.set(k, { ...cur, allows12h: !cur.allows12h });
      return next;
    });
  };

  const toggleStrength = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const k = slotKey(date, shift);
      const cur = prev.get(k);
      if (!cur) return prev; // cannot prefer a shift you are not working
      if (cur.strength === 1) {
        // Turning ON: capped at N-1 of the day's marked shifts (1 of 2, 2 of
        // 3), so there is always at least one non-preferred option left --
        // marking every marked shift preferred is a null signal, since the
        // solver would have nothing to favour it over.
        const daySlotCount = BASE_SHIFTS.filter((s) => prev.has(slotKey(date, s))).length;
        const preferredNow = BASE_SHIFTS.filter(
          (s) => prev.get(slotKey(date, s))?.strength === 2,
        ).length;
        if (preferredNow >= daySlotCount - 1) return prev;
      }
      const next = new Map(prev);
      next.set(k, { ...cur, strength: cur.strength === 2 ? 1 : 2 });
      return next;
    });
  };

  /** "בכל הימים" — opt every currently-selected day in (or clear them all). */
  const setAll12h = (shift: 'morning' | 'night', on: boolean) => {
    if (locked) return;
    setSlots((prev) => {
      const next = new Map(prev);
      for (const [k, flags] of prev) {
        if (k.endsWith(`|${shift}`)) next.set(k, { ...flags, allows12h: on });
      }
      return next;
    });
  };

  const count12h = (shift: 'morning' | 'night') =>
    [...slots.entries()].filter(([k, flags]) => flags.allows12h && k.endsWith(`|${shift}`)).length;

  const countSelected = (shift: 'morning' | 'night') =>
    [...slots.keys()].filter((k) => k.endsWith(`|${shift}`)).length;

  // A guard works at most one shift per day, so the binding count for the כמות
  // override is DISTINCT DAYS with any availability -- not total slots ticked.
  const availableDays = useMemo(
    () => new Set([...slots.keys()].map((k) => k.split('|')[0])).size,
    [slots],
  );

  /**
   * The best shift count actually achievable from the marked slots alone,
   * respecting the same >=8h rest rule the solver enforces (H5) -- a guard
   * who marks Sunday night and Monday morning has NOT bought two shifts,
   * since the two can never legally combine (0h rest, ⛔). A simple day
   * count would overstate what the submission can produce; this doesn't.
   *
   * Deliberately shown instead of the manager-set כמות target (not the
   * guard's business, spec 1.4 item 33) -- this is a fact about the guard's
   * OWN submission, not about what was configured for them.
   *
   * The actual DP (a small forward pass -- for each day, the best count
   * ending in "worked shift S" is 1 + the best count from the previous day
   * that isn't blocked by resting into S, or the best "day off" count,
   * always compatible) now lives in src/lib/shifts.ts as `maxFeasibleShifts`,
   * shared with the manager's GuardPreferenceEditor, which needs the
   * identical calculation recomputed live against whatever it's currently
   * editing. Extended (12h) shifts aren't modelled separately there either --
   * this is a guide number, not the generation input.
   */
  const maxFeasibleShifts = useMemo(
    () => computeMaxFeasibleShifts(dates, (date, shift) => slots.has(slotKey(date, shift))),
    [slots, dates],
  );

  // The requested-shifts stepper can never exceed what's actually feasible
  // from the currently marked slots (rule: requested <= feasible) -- if the
  // guard unmarks days after picking a higher number, this pulls it back
  // down rather than leaving a now-infeasible value sitting in the field.
  const requestedMax = Math.min(maxFeasibleShifts, MAX_SHIFTS_PER_WEEK);
  useEffect(() => {
    setRequestedShifts((prev) => Math.min(prev, requestedMax));
  }, [requestedMax]);

  const effective = effectiveKamut(configuredKamut, availableDays);
  const isEmpty = slots.size === 0;
  const wasLowered = effective < configuredKamut;

  // "שלח בקשות" only opens the confirmation modal below -- the actual
  // onSubmit call happens from its confirm button, so a guard (or a manager
  // editing on their behalf) always sees exactly what is about to be sent
  // before it goes out.
  const submit = () => setConfirmSubmit(true);
  const confirmAndSubmit = () => {
    setConfirmSubmit(false);
    // Equal-to-configured normalises to null: absence of a real request
    // should leave a clean absence of data, not a stray value equal to the
    // default (same treatment an empty note already gets).
    onSubmit({
      slots,
      notes,
      requestedShifts: requestedShifts === configuredKamut ? null : requestedShifts,
    });
  };

  return (
    <div className="space-y-4">
      {/* ---------------- deadline ---------------- */}
      <Card
        className={cn(
          'flex items-center justify-between gap-3',
          locked && 'bg-slate-50 dark:bg-slate-800',
        )}
      >
        <div className="min-w-0">
          <p className="font-bold text-slate-900 dark:text-slate-100">
            {locked
              ? 'ההגשות נסגרו'
              : left
                ? `נותרו ${left} להגשה`
                // Reachable only when a manager edits on a guard's behalf after
                // that guard's own deadline passed -- locked stays false since
                // a manager's edit isn't bound by it, but `left` is null.
                : 'מועד ההגשה הרגיל עבר - פתוח לעריכה על ידך'}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
            {formatDeadline(deadline)}
          </p>
        </div>
        <Badge tone={locked ? 'rose' : 'green'}>{locked ? 'נעול' : 'פתוח'}</Badge>
      </Card>

      {locked && (
        <Alert tone="warn">
          לא ניתן לערוך בקשות לאחר מועד הסגירה. לשינוי דחוף פנה למנהל המשמרת.
        </Alert>
      )}

      {/* ---------------- the grid ---------------- */}
      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="font-bold text-slate-900 dark:text-slate-100">מתי אתה זמין?</p>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            סמן כל משמרת שאתה יכול לעבוד. אפשר לסמן כמה שתרצה - השיבוץ בפועל ייקבע לפי הצרכים.
          </p>
        </div>

        <div className="divide-y divide-slate-100">
          {dates.map((date, dayIdx) => {
            const daySlots = BASE_SHIFTS.filter((s) => slots.has(slotKey(date, s)));
            // American school: the days off are Saturday and Sunday, so the
            // tint sits at both ends of the Sunday-first grid, not on Friday.
            const isWeekend = isWeekendDay(dayIdx);
            const extendable = daySlots.filter(canExtend) as ('morning' | 'night')[];

            return (
              <div
                key={date}
                className={cn('px-4 py-3', isWeekend && 'bg-amber-50/40 dark:bg-amber-950/20')}
              >
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[15px] font-bold text-slate-900 dark:text-slate-100">
                    יום {HEBREW_DAYS[dayIdx]}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {formatDayMonth(date)}
                  </span>
                  {daySlots.length > 0 && (
                    <span className="ms-auto text-xs font-semibold text-brand-600">
                      {daySlots.length} נבחרו
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {BASE_SHIFTS.map((shift) => {
                    const on = slots.has(slotKey(date, shift));
                    const def = SHIFTS[shift];
                    return (
                      <button
                        key={shift}
                        type="button"
                        disabled={locked}
                        onClick={() => toggleSlot(date, shift)}
                        aria-pressed={on}
                        className={cn(
                          'flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-2.5',
                          'transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
                          on
                            ? 'border-transparent text-white shadow-sm'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600',
                        )}
                        style={on ? { backgroundColor: def.colorVar } : undefined}
                      >
                        <span className="text-[13px] font-bold">{def.he}</span>
                        <span className="num text-[10px] opacity-80">{def.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 12h chips. Rendered only for shifts actually selected on
                    this day, so the option appears and disappears with the
                    button that enables it. */}
                {extendable.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {extendable.map((shift) => {
                      const ext = SHIFTS[EXTENDED_OF[shift]];
                      const on = slots.get(slotKey(date, shift))?.allows12h === true;
                      return (
                        <button
                          key={shift}
                          type="button"
                          disabled={locked}
                          onClick={() => toggle12h(date, shift)}
                          aria-pressed={on}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5',
                            'text-[11px] font-semibold transition-all disabled:opacity-50',
                            on
                              ? 'border-transparent text-white'
                              : 'border-dashed border-slate-300 bg-white text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400 dark:hover:border-slate-500',
                          )}
                          style={on ? { backgroundColor: ext.colorVar } : undefined}
                        >
                          <span>{on ? '✓' : '+'}</span>
                          <span>12 שעות</span>
                          <span className="num opacity-80">{ext.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Preference chips. One per selected shift regardless of
                    type -- unlike the 12h chip, preference is not limited to
                    morning/night, since the whole point is choosing between
                    e.g. afternoon and night on a day both are marked. Only
                    shown with 2+ marked shifts -- with just one, there is
                    nothing to prefer it over. Capped at N-1 preferred (see
                    toggleStrength): the chip for a currently-unpreferred
                    shift disables once the cap is reached. */}
                {daySlots.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(() => {
                      const dayPreferredCount = daySlots.filter(
                        (s) => slots.get(slotKey(date, s))?.strength === 2,
                      ).length;
                      const atCap = dayPreferredCount >= daySlots.length - 1;
                      return daySlots.map((shift) => {
                        const def = SHIFTS[shift];
                        const preferred = slots.get(slotKey(date, shift))?.strength === 2;
                        return (
                          <button
                            key={shift}
                            type="button"
                            disabled={locked || (atCap && !preferred)}
                            onClick={() => toggleStrength(date, shift)}
                            aria-pressed={preferred}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5',
                              'text-[11px] font-semibold transition-all disabled:opacity-50',
                              preferred
                                ? 'border-transparent text-white'
                                : 'border-dashed border-slate-300 bg-white text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400 dark:hover:border-slate-500',
                            )}
                            style={preferred ? { backgroundColor: def.colorVar } : undefined}
                          >
                            <span>{preferred ? '★' : '☆'}</span>
                            <span>עדיפות</span>
                            <span className="opacity-80">{def.he}</span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---------------- 12h summary + bulk actions ---------------- */}
      <Card className="space-y-3">
        <div>
          <p className="font-bold text-slate-900 dark:text-slate-100">משמרות 12 שעות</p>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            אופציונלי, ונבחר לכל יום בנפרד. משמרת 12 שעות נחשבת כמשמרת אחת בלבד לצורך הכמות
            השבועית.
          </p>
        </div>

        {(['morning', 'night'] as const).map((shift) => {
          const ext = SHIFTS[EXTENDED_OF[shift]];
          const selected = countSelected(shift);
          const opted = count12h(shift);
          return (
            <div
              key={shift}
              className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {ext.he}{' '}
                  <span className="num font-normal text-slate-500 dark:text-slate-400">
                    {ext.label}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {selected === 0
                    ? `סמן ${SHIFTS[shift].he} בימים שתרצה, ואז אפשר להאריך אותם`
                    : `${opted} מתוך ${selected} ימי ${SHIFTS[shift].he} מסומנים`}
                </p>
              </div>
              {selected > 0 && (
                <Button
                  size="sm"
                  variant={opted === selected ? 'secondary' : 'primary'}
                  disabled={locked}
                  onClick={() => setAll12h(shift, opted !== selected)}
                >
                  {opted === selected ? 'נקה הכול' : 'בכל הימים'}
                </Button>
              )}
            </div>
          );
        })}
      </Card>

      {/* ---------------- notes ---------------- */}
      <Card className="space-y-2">
        <div>
          <p className="font-bold text-slate-900 dark:text-slate-100">הערות</p>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            משהו שכדאי שנדע ולא נכנס לטבלה - למשל "עדיפות למשמרות לילה", "עד 4 משמרות השבוע", "דבר
            איתי אם אתה צריך עזרה".
          </p>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX_LENGTH))}
          disabled={locked}
          rows={3}
          placeholder="לא חובה..."
          className={cn(
            'w-full resize-none rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800',
            'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none dark:placeholder:text-slate-500',
            'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70 dark:disabled:bg-slate-800/50',
          )}
        />
        <p className="text-end text-xs text-slate-400 dark:text-slate-500">
          {notes.length}/{NOTES_MAX_LENGTH}
        </p>
      </Card>

      {/* ---------------- summary ---------------- */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">משמרות שסומנו</span>
          <span className="font-bold text-slate-900 dark:text-slate-100">{slots.size}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">ימים זמינים</span>
          <span className="font-bold text-slate-900 dark:text-slate-100">
            {availableDays} מתוך 7
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">משמרות אפשריות מהסימונים שלך</span>
          <span className="font-bold text-slate-900 dark:text-slate-100">{maxFeasibleShifts}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">כמות משמרות מבוקשת</span>
          <Stepper
            value={requestedShifts}
            onChange={setRequestedShifts}
            disabled={locked}
            min={0}
            max={requestedMax}
          />
        </div>
        {!isEmpty && maxFeasibleShifts < availableDays && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            חלק מהימים שסימנת לא יכולים להצטרף יחד - נדרשות לפחות 8 שעות מנוחה בין משמרות.
          </p>
        )}

        {wasLowered && !isEmpty && (
          <Alert tone="warn" title="הכמות שלך תרד אוטומטית">
            סימנת {availableDays} ימים בלבד, ולכן היעד שלך לשבוע זה יהיה{' '}
            <strong>{effective}</strong> במקום {configuredKamut}. סמן ימים נוספים כדי להגיע ליעד
            המלא.
          </Alert>
        )}

        {isEmpty && (
          <Alert tone="info" title="לא סימנת אף משמרת">
            זה בסדר גמור. הגשה ריקה מסמנת שאינך זמין השבוע, ולא תשובץ כלל.
          </Alert>
        )}

        <Button fullWidth size="lg" disabled={locked} loading={submitting} onClick={submit}>
          שלח בקשות
        </Button>
      </Card>

      {/* ---------------- confirm before submit ---------------- */}
      {confirmSubmit && (
        <Modal title="לאשר שליחה?" onClose={() => setConfirmSubmit(false)}>
          <div className="space-y-3">
            {isEmpty ? (
              <Alert tone="warn" title="הגשה ריקה">
                לא סימנת אף משמרת. הגשה ריקה מסמנת שאינך זמין השבוע, ולא תשובץ כלל.
              </Alert>
            ) : (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400">אלו הבקשות שיישלחו:</p>
                {requestedShifts !== configuredKamut && (
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    כמות משמרות מבוקשת: <strong>{requestedShifts}</strong>
                    {requestedShifts < configuredKamut
                      ? ` (במקום ${configuredKamut})`
                      : ' (מעבר לכמות שהוגדרה - ינתן רק אם ניתן)'}
                  </p>
                )}
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {dates.map((date, dayIdx) => {
                    const daySlots = BASE_SHIFTS.filter((s) => slots.has(slotKey(date, s)));
                    if (daySlots.length === 0) return null;
                    return (
                      <div key={date} className="flex flex-wrap items-center gap-2 py-2">
                        <span className="w-14 shrink-0 text-xs font-bold text-slate-700 dark:text-slate-300">
                          {HEBREW_DAYS[dayIdx]}
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {daySlots.map((shift) => {
                            const flags = slots.get(slotKey(date, shift))!;
                            const def = SHIFTS[shift];
                            return (
                              <span
                                key={shift}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-white"
                                style={{ backgroundColor: def.colorVar }}
                              >
                                {flags.strength === 2 && <span aria-label="עדיפות">★</span>}
                                <span>{def.he}</span>
                                {flags.allows12h && <span className="opacity-80">12ש׳</span>}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                fullWidth
                loading={submitting}
                onClick={confirmAndSubmit}
                variant={isEmpty ? 'danger' : 'primary'}
              >
                {isEmpty ? 'אשר הגשה ריקה' : 'אישור ושליחה'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmSubmit(false)}>
                ביטול
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---------------- cancel submission ---------------- */}
      {hasSubmitted && !locked && onDelete && (
        <Card className="space-y-2">
          <div>
            <p className="font-bold text-slate-900 dark:text-slate-100">ביטול ההגשה</p>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              מוחק את הבקשות ששלחת לשבוע זה ומחזיר אותך למצב ״טרם הגשת״. אפשר להגיש מחדש עד מועד
              הסגירה.
            </p>
          </div>

          {confirmDelete && (
            <Alert tone="warn">לחיצה נוספת תמחק את ההגשה. אי אפשר לבטל את המחיקה עצמה.</Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={confirmDelete ? 'danger' : 'ghost'}
              loading={deleting}
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            >
              {confirmDelete ? 'לחץ שוב לביטול סופי' : 'ביטול ההגשה'}
            </Button>
            {confirmDelete && (
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                חזרה
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
