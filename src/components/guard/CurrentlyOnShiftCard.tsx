import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import type { WeekRoster } from '@/hooks/useGuardPortal';
import { addDays, todayInIsrael } from '@/lib/dates';
import { SHIFTS, isShiftActiveAt } from '@/lib/shifts';
import type { Profile } from '@/types/database';

/** How often the card re-checks the clock -- finer than the shift grid's own
 *  hour-granularity boundaries (all on the :45), so a shift change is never
 *  more than a minute stale without needing a page reload. */
const REFRESH_MS = 60_000;

interface OnShiftEntry {
  guardId: string;
  name: string;
  label: string;
}

/**
 * "Who's physically on site right now" -- a quick-glance answer to "can I
 * come use the gym" without reading the roster grid's current cell by hand.
 *
 * Takes the same `weeks`/`guards` useVisibleRosters() already returns to its
 * caller (GuardHome) -- no separate query. Only today's and yesterday's
 * assignments can possibly be active "now": the longest shift (Kippur's 16h)
 * starting today ends by tomorrow 06:45, and nothing starts before today's
 * own 06:45.
 */
export function CurrentlyOnShiftCard({
  weeks,
  guards,
}: {
  weeks: WeekRoster[];
  guards: Profile[];
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const onShift = useMemo<OnShiftEntry[]>(() => {
    const todayKey = todayInIsrael();
    const relevantDates = new Set([todayKey, addDays(todayKey, -1)]);
    const names = new Map(guards.map((g) => [g.id, g.display_name]));

    const entries: OnShiftEntry[] = [];
    for (const week of weeks) {
      for (const a of week.assignments) {
        // guard_id is null for a placeholder row (§12.9) -- nothing to show
        // a name for, and this card is specifically about identifying a
        // person.
        if (!a.guard_id || !relevantDates.has(a.target_date)) continue;
        if (!isShiftActiveAt(a.target_date, a.shift, now)) continue;
        const name = names.get(a.guard_id);
        if (!name) continue;
        entries.push({ guardId: a.guard_id, name, label: SHIFTS[a.shift].label });
      }
    }
    return entries;
  }, [weeks, guards, now]);

  return (
    <Card>
      <p className="mb-2 text-sm font-bold text-slate-500 dark:text-slate-400">כרגע במשמרת</p>
      {onShift.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">אין מידע על מי נמצא כרגע באתר.</p>
      ) : (
        <ul className="space-y-1.5">
          {onShift.map((entry) => (
            <li
              key={entry.guardId}
              className="flex items-center justify-between gap-2 text-[15px] font-semibold text-slate-800 dark:text-slate-100"
            >
              <span>{entry.name}</span>
              <span className="num text-sm font-normal text-slate-500 dark:text-slate-400">
                {entry.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
