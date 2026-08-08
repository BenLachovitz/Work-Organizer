import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, cn } from '@/components/ui';
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
  type BaseShift,
} from '@/lib/shifts';

/**
 * Selection state.
 *
 * Key is "YYYY-MM-DD|shift"; presence means available, and the value says
 * whether the guard will extend that specific shift to 12 hours. Keeping the
 * flag inside the same entry is what makes it impossible to be opted in for a
 * day you are not working -- removing the slot removes the flag with it,
 * mirroring how `allows_12h` lives on the preference row in the database.
 */
export type Selection = Map<string, boolean>;

const slotKey = (date: DateKey, shift: BaseShift) => `${date}|${shift}`;

/** Only morning and night can extend (-> day12 / night12). */
const canExtend = (shift: BaseShift) => shift === 'morning' || shift === 'night';

const EXTENDED_OF: Record<'morning' | 'night', 'day12' | 'night12'> = {
  morning: 'day12',
  night: 'night12',
};

export function selectionToSlots(
  sel: Selection,
): { date: DateKey; shift: BaseShift; allows12h: boolean }[] {
  return [...sel.entries()].map(([k, allows12h]) => {
    const [date, shift] = k.split('|');
    return { date: date!, shift: shift as BaseShift, allows12h };
  });
}

export function rowsToSelection(
  rows: { target_date: string; shift: BaseShift; allows_12h?: boolean }[],
): Selection {
  return new Map(rows.map((r) => [slotKey(r.target_date, r.shift), Boolean(r.allows_12h)]));
}

/** Matches the `notes_length` CHECK on weekly_submissions. */
export const NOTES_MAX_LENGTH = 500;

export interface PreferenceFormValue {
  slots: Selection;
  notes: string;
}

export function WeeklyPreferenceForm({
  weekStart,
  deadline,
  locked,
  configuredKamut,
  initial,
  onSubmit,
  submitting = false,
}: {
  weekStart: DateKey;
  deadline: Date;
  locked: boolean;
  configuredKamut: number;
  initial?: PreferenceFormValue;
  onSubmit: (value: PreferenceFormValue) => void;
  submitting?: boolean;
}) {
  const [slots, setSlots] = useState<Selection>(() => new Map(initial?.slots ?? []));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const left = timeUntil(deadline);

  const toggleSlot = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const next = new Map(prev);
      const k = slotKey(date, shift);
      // Deleting the slot drops its 12h flag automatically -- no orphan state.
      if (next.has(k)) next.delete(k);
      else next.set(k, false);
      return next;
    });
    setConfirmEmpty(false);
  };

  const toggle12h = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const k = slotKey(date, shift);
      if (!prev.has(k)) return prev; // cannot extend a shift you are not working
      const next = new Map(prev);
      next.set(k, !prev.get(k));
      return next;
    });
  };

  /** "בכל הימים" — opt every currently-selected day in (or clear them all). */
  const setAll12h = (shift: 'morning' | 'night', on: boolean) => {
    if (locked) return;
    setSlots((prev) => {
      const next = new Map(prev);
      for (const [k] of prev) {
        if (k.endsWith(`|${shift}`)) next.set(k, on);
      }
      return next;
    });
  };

  const count12h = (shift: 'morning' | 'night') =>
    [...slots.entries()].filter(([k, on]) => on && k.endsWith(`|${shift}`)).length;

  const countSelected = (shift: 'morning' | 'night') =>
    [...slots.keys()].filter((k) => k.endsWith(`|${shift}`)).length;

  // A guard works at most one shift per day, so the binding count for the כמות
  // override is DISTINCT DAYS with any availability -- not total slots ticked.
  const availableDays = useMemo(
    () => new Set([...slots.keys()].map((k) => k.split('|')[0])).size,
    [slots],
  );
  const effective = effectiveKamut(configuredKamut, availableDays);
  const isEmpty = slots.size === 0;
  const wasLowered = effective < configuredKamut;

  const submit = () => {
    if (isEmpty && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    onSubmit({ slots, notes });
  };

  return (
    <div className="space-y-4">
      {/* ---------------- deadline ---------------- */}
      <Card className={cn('flex items-center justify-between gap-3', locked && 'bg-slate-50')}>
        <div className="min-w-0">
          <p className="font-bold text-slate-900">
            {locked ? 'ההגשות נסגרו' : `נותרו ${left} להגשה`}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">{formatDeadline(deadline)}</p>
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
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="font-bold text-slate-900">מתי אתה זמין?</p>
          <p className="mt-0.5 text-sm text-slate-500">
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
              <div key={date} className={cn('px-4 py-3', isWeekend && 'bg-amber-50/40')}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[15px] font-bold text-slate-900">
                    יום {HEBREW_DAYS[dayIdx]}
                  </span>
                  <span className="text-xs text-slate-400">{formatDayMonth(date)}</span>
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
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
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
                      const on = slots.get(slotKey(date, shift)) === true;
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
                              : 'border-dashed border-slate-300 bg-white text-slate-500 hover:border-slate-400',
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
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---------------- 12h summary + bulk actions ---------------- */}
      <Card className="space-y-3">
        <div>
          <p className="font-bold text-slate-900">משמרות 12 שעות</p>
          <p className="mt-0.5 text-sm text-slate-500">
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
              className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">
                  {ext.he} <span className="num font-normal text-slate-500">{ext.label}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
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
          <p className="font-bold text-slate-900">הערות</p>
          <p className="mt-0.5 text-sm text-slate-500">
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
            'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none',
            'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70',
          )}
        />
        <p className="text-end text-xs text-slate-400">
          {notes.length}/{NOTES_MAX_LENGTH}
        </p>
      </Card>

      {/* ---------------- summary ---------------- */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">משמרות שסומנו</span>
          <span className="font-bold text-slate-900">{slots.size}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">ימים זמינים</span>
          <span className="font-bold text-slate-900">{availableDays} מתוך 7</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">הכמות שהוגדרה לך</span>
          <span className="font-bold text-slate-900">
            {configuredKamut} <span className="text-slate-400">/ {MAX_SHIFTS_PER_WEEK} מקסימום</span>
          </span>
        </div>

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

        {confirmEmpty && (
          <Alert tone="warn" title="לאשר הגשה ריקה?">
            לחיצה נוספת על ״שלח״ תגיש שבוע ריק - לא תשובץ לאף משמרת.
          </Alert>
        )}

        <Button
          fullWidth
          size="lg"
          disabled={locked}
          loading={submitting}
          onClick={submit}
          variant={confirmEmpty ? 'danger' : 'primary'}
        >
          {confirmEmpty ? 'אשר הגשה ריקה' : 'שלח בקשות'}
        </Button>
      </Card>
    </div>
  );
}
