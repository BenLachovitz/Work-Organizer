import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Toggle, cn } from '@/components/ui';
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

/** Set of "YYYY-MM-DD|shift" keys. Row-present-means-available, matching the DB. */
export type Selection = Set<string>;

const slotKey = (date: DateKey, shift: BaseShift) => `${date}|${shift}`;

/** Selection -> the shape save_week_preferences expects. */
export function selectionToSlots(slots: Selection): { date: DateKey; shift: BaseShift }[] {
  return [...slots].map((k) => {
    const [date, shift] = k.split('|');
    return { date: date!, shift: shift as BaseShift };
  });
}

/** Stored preference rows -> Selection. */
export function rowsToSelection(
  rows: { target_date: string; shift: BaseShift }[],
): Selection {
  return new Set(rows.map((r) => slotKey(r.target_date, r.shift)));
}

export interface PreferenceFormValue {
  slots: Selection;
  canWork12hDay: boolean;
  canWork12hNight: boolean;
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
  const [slots, setSlots] = useState<Selection>(() => new Set(initial?.slots ?? []));
  const [canWork12hDay, setDay12] = useState(initial?.canWork12hDay ?? false);
  const [canWork12hNight, setNight12] = useState(initial?.canWork12hNight ?? false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const left = timeUntil(deadline);

  const toggleSlot = (date: DateKey, shift: BaseShift) => {
    if (locked) return;
    setSlots((prev) => {
      const next = new Set(prev);
      const k = slotKey(date, shift);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setConfirmEmpty(false);
  };

  // A guard works at most one shift per day, so the binding count for the כמות
  // override is DISTINCT DAYS with any availability -- not total slots ticked.
  const availableDays = useMemo(
    () => new Set([...slots].map((k) => k.split('|')[0])).size,
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
    onSubmit({ slots, canWork12hDay, canWork12hNight });
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
                    // Flag when an opt-in makes an extended shift possible here.
                    const extended =
                      (shift === 'morning' && canWork12hDay) ||
                      (shift === 'night' && canWork12hNight);

                    return (
                      <button
                        key={shift}
                        type="button"
                        disabled={locked}
                        onClick={() => toggleSlot(date, shift)}
                        aria-pressed={on}
                        className={cn(
                          'relative flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-2.5',
                          'transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
                          on
                            ? 'border-transparent text-white shadow-sm'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                        )}
                        style={on ? { backgroundColor: def.colorVar } : undefined}
                      >
                        <span className="text-[13px] font-bold">{def.he}</span>
                        <span className="num text-[10px] opacity-80">{def.label}</span>
                        {on && extended && (
                          <span className="absolute -top-1.5 -start-1.5 rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] font-bold text-white">
                            12ש׳
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---------------- 12h opt-ins ---------------- */}
      <Card className="p-2">
        <p className="px-3 pt-2 font-bold text-slate-900">משמרות 12 שעות</p>
        <p className="px-3 pb-1 text-sm text-slate-500">
          אופציונלי. משמרת 12 שעות נחשבת כמשמרת אחת בלבד לצורך הכמות השבועית.
        </p>
        <Toggle
          checked={canWork12hDay}
          onChange={setDay12}
          disabled={locked}
          label="יום 12 שעות (06:45-18:45)"
          description="אם תסמן, ייתכן שתשובץ למשמרת ארוכה בימים שסימנת בהם בוקר."
        />
        <Toggle
          checked={canWork12hNight}
          onChange={setNight12}
          disabled={locked}
          label="לילה 12 שעות (18:45-06:45)"
          description="אם תסמן, ייתכן שתשובץ למשמרת ארוכה בימים שסימנת בהם לילה."
        />
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
