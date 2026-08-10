import { useEffect, useMemo, useState } from 'react';
import { Button, Stepper, cn } from '@/components/ui';
import { HEBREW_DAYS, formatDayMonth, weekDates, type DateKey } from '@/lib/dates';
import {
  BASE_SHIFTS,
  SHIFTS,
  isWeekendDay,
  maxFeasibleShifts,
  maxRequestableShifts,
  type BaseShift,
} from '@/lib/shifts';
import {
  rowsToSelection,
  selectionToSlots,
  type Selection,
} from '@/components/guard/WeeklyPreferenceForm';
import type { WishPreference } from '@/types/database';

const slotKey = (date: DateKey, shift: BaseShift) => `${date}|${shift}`;

/** Only morning and night can extend (-> day12 / night12). */
const canExtend = (shift: BaseShift) => shift === 'morning' || shift === 'night';

/**
 * Minimal click-to-toggle editor for a manager correcting one guard's week on
 * their behalf. Deliberately NOT the guard-facing WeeklyPreferenceForm --
 * that form carries a deadline countdown, a feasible-shifts summary, and a
 * submit-confirmation step, all of which answer questions a GUARD has about
 * their own submission and none of which apply when a manager is directly
 * fixing a row. Just the shift grid, the same 12h/עדיפות toggles, and one
 * save button.
 */
export function GuardPreferenceEditor({
  weekStart,
  initialPreferences,
  configuredKamut,
  initialRequestedShifts,
  saving,
  onSave,
  onCancel,
}: {
  weekStart: DateKey;
  initialPreferences: WishPreference[];
  /** The manager-configured כמות -- needed only to bound and normalise the
   *  requested-shifts stepper below, same rules the guard-facing form uses. */
  configuredKamut: number;
  initialRequestedShifts: number | null;
  saving: boolean;
  onSave: (
    slots: ReturnType<typeof selectionToSlots>,
    requestedShifts: number | null,
  ) => void;
  onCancel: () => void;
}) {
  const [slots, setSlots] = useState<Selection>(() => rowsToSelection(initialPreferences));
  const dates = weekDates(weekStart);

  const [requestedShifts, setRequestedShifts] = useState(
    initialRequestedShifts ?? configuredKamut,
  );
  // Bounds recomputed LIVE from whatever the manager currently has toggled --
  // not the guard's original submission -- so the ceiling tracks edits made
  // in this same session, same rule (requested <= feasible) the guard-facing
  // form enforces.
  const requestedMax = useMemo(
    () =>
      Math.min(
        maxFeasibleShifts(dates, (date, shift) => slots.has(slotKey(date, shift))),
        maxRequestableShifts(configuredKamut),
      ),
    [slots, dates, configuredKamut],
  );
  useEffect(() => {
    setRequestedShifts((prev) => Math.min(prev, requestedMax));
  }, [requestedMax]);

  const toggleSlot = (date: DateKey, shift: BaseShift) => {
    setSlots((prev) => {
      const next = new Map(prev);
      const k = slotKey(date, shift);
      // Deleting the slot drops its 12h flag and its strength automatically --
      // no orphan state, same as the guard-facing form.
      if (next.has(k)) next.delete(k);
      else next.set(k, { allows12h: false, strength: 1 });
      return next;
    });
  };

  const toggle12h = (date: DateKey, shift: BaseShift) => {
    setSlots((prev) => {
      const k = slotKey(date, shift);
      const cur = prev.get(k);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(k, { ...cur, allows12h: !cur.allows12h });
      return next;
    });
  };

  const toggleStrength = (date: DateKey, shift: BaseShift) => {
    setSlots((prev) => {
      const k = slotKey(date, shift);
      const cur = prev.get(k);
      if (!cur) return prev;
      if (cur.strength === 1) {
        // Same N-1-of-N cap as the guard-facing form (spec 3.8, v2.5): always
        // leaves at least one non-preferred shift, or the solver has nothing
        // to favour a preference over.
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

  return (
    <div className="space-y-3">
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {dates.map((date, dayIdx) => {
          const daySlots = BASE_SHIFTS.filter((s) => slots.has(slotKey(date, s)));
          const extendable = daySlots.filter(canExtend) as ('morning' | 'night')[];

          return (
            <div
              key={date}
              className={cn('py-2.5', isWeekendDay(dayIdx) && 'bg-amber-50/40 dark:bg-amber-950/20')}
            >
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
                  יום {HEBREW_DAYS[dayIdx]}
                </span>
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  {formatDayMonth(date)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                {BASE_SHIFTS.map((shift) => {
                  const on = slots.has(slotKey(date, shift));
                  const def = SHIFTS[shift];
                  return (
                    <button
                      key={shift}
                      type="button"
                      onClick={() => toggleSlot(date, shift)}
                      aria-pressed={on}
                      className={cn(
                        'flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-2',
                        'transition-all duration-150',
                        on
                          ? 'border-transparent text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600',
                      )}
                      style={on ? { backgroundColor: def.colorVar } : undefined}
                    >
                      <span className="text-[13px] font-bold">{def.he}</span>
                    </button>
                  );
                })}
              </div>

              {(extendable.length > 0 || daySlots.length > 1) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {extendable.map((shift) => {
                    const on = slots.get(slotKey(date, shift))?.allows12h === true;
                    return (
                      <button
                        key={`12h-${shift}`}
                        type="button"
                        onClick={() => toggle12h(date, shift)}
                        aria-pressed={on}
                        className={cn(
                          'rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors',
                          on
                            ? 'border-transparent bg-slate-700 text-white'
                            : 'border-dashed border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:text-slate-400 dark:hover:border-slate-500',
                        )}
                      >
                        {on ? '✓' : '+'} 12 שעות {SHIFTS[shift].he}
                      </button>
                    );
                  })}

                  {daySlots.length > 1 &&
                    (() => {
                      const dayPreferredCount = daySlots.filter(
                        (s) => slots.get(slotKey(date, s))?.strength === 2,
                      ).length;
                      const atCap = dayPreferredCount >= daySlots.length - 1;
                      return daySlots.map((shift) => {
                        const preferred = slots.get(slotKey(date, shift))?.strength === 2;
                        return (
                          <button
                            key={`pref-${shift}`}
                            type="button"
                            disabled={atCap && !preferred}
                            onClick={() => toggleStrength(date, shift)}
                            aria-pressed={preferred}
                            className={cn(
                              'rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors',
                              'disabled:opacity-40',
                              preferred
                                ? 'border-transparent bg-slate-900 text-white'
                                : 'border-dashed border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:text-slate-400 dark:hover:border-slate-500',
                            )}
                          >
                            {preferred ? '★' : '☆'} עדיפות {SHIFTS[shift].he}
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

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
          כמות משמרות מבוקשת
        </span>
        <Stepper value={requestedShifts} onChange={setRequestedShifts} min={0} max={requestedMax} />
      </div>

      <div className="flex gap-2">
        <Button
          fullWidth
          loading={saving}
          onClick={() =>
            onSave(
              selectionToSlots(slots),
              // Equal-to-configured normalises to null, same rule the
              // guard-facing form applies on submit.
              requestedShifts === configuredKamut ? null : requestedShifts,
            )
          }
        >
          שמירה
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </div>
  );
}
