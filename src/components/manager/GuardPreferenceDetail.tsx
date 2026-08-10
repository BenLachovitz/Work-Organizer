import { cn } from '@/components/ui';
import { HEBREW_DAYS, weekDates, type DateKey } from '@/lib/dates';
import { BASE_SHIFTS, SHIFTS, isWeekendDay } from '@/lib/shifts';
import type { WishPreference } from '@/types/database';

/**
 * Read-only day-by-day, shift-by-shift render of one guard's committed
 * preferences for a week -- the detail TeamTable's aggregate counts
 * (availableDays, slotCount, preferredCount...) never show. Deliberately not
 * the interactive WeeklyPreferenceForm: that component is built to edit ONE
 * guard's week at a time with a deadline card, 12h summary, notes textarea
 * and submit button -- too heavy for scanning several guards at once. Edit
 * mode (ManagerPreferences.tsx) swaps this out for the real form instead of
 * extending this one to also handle writes.
 */
export function GuardPreferenceDetail({
  weekStart,
  preferences,
  notes,
}: {
  weekStart: DateKey;
  preferences: WishPreference[];
  notes: string | null;
}) {
  const dates = weekDates(weekStart);
  const byDateShift = new Map(preferences.map((p) => [`${p.target_date}|${p.shift}`, p]));

  if (preferences.length === 0) {
    return (
      <p className="text-sm text-slate-400 dark:text-slate-500">לא סומנה זמינות השבוע.</p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {dates.map((date, dayIdx) => {
          const daySlots = BASE_SHIFTS.filter((s) => byDateShift.has(`${date}|${s}`));
          if (daySlots.length === 0) return null;
          return (
            <div
              key={date}
              className={cn(
                'flex flex-wrap items-center gap-2 py-2',
                isWeekendDay(dayIdx) && 'bg-amber-50/40 dark:bg-amber-950/20',
              )}
            >
              <span className="w-14 shrink-0 text-xs font-bold text-slate-700 dark:text-slate-300">
                {HEBREW_DAYS[dayIdx]}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {daySlots.map((shift) => {
                  const pref = byDateShift.get(`${date}|${shift}`)!;
                  const def = SHIFTS[shift];
                  return (
                    <span
                      key={shift}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-white"
                      style={{ backgroundColor: def.colorVar }}
                    >
                      {pref.strength === 2 && <span aria-label="עדיפות">★</span>}
                      <span>{def.he}</span>
                      {pref.allows_12h && <span className="opacity-80">12ש׳</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {notes && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {notes}
        </p>
      )}
    </div>
  );
}
