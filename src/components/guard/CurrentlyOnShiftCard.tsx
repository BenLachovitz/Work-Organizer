import { useEffect, useMemo, useState } from 'react';
import { Card, cn } from '@/components/ui';
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
  he: string;
  label: string;
  colorVar: string;
}

/**
 * "Who's physically on site right now" -- a quick-glance answer to "can I
 * come use the gym" without reading the roster grid's current cell by hand.
 * Styled after GuardHome's own "my shifts" week cards (gradient Card, white
 * text, per-row bg-white/10 pills) so this reads as the same family of card
 * rather than a bolted-on widget.
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
        const def = SHIFTS[a.shift];
        entries.push({ guardId: a.guard_id, name, he: def.he, label: def.label, colorVar: def.colorVar });
      }
    }
    return entries;
  }, [weeks, guards, now]);

  return (
    <Card className="bg-gradient-to-bl from-brand-600 to-brand-800 text-white ring-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {/* A small pulse, not a static dot -- the one visual cue on the
              page that says "this number is live," matching the 60s
              self-refresh rather than looking like a frozen snapshot. */}
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-400" />
          </span>
          <p className="text-sm font-bold opacity-80">כרגע במשמרת</p>
        </div>
      </div>

      {onShift.length === 0 ? (
        <>
          <p className="mt-1 text-2xl font-extrabold">אין כרגע אף אחד במשמרת</p>
          <p className="mt-2 text-sm opacity-80">אין מידע על מי נמצא כרגע באתר.</p>
        </>
      ) : (
        <>
          <div className="mt-3 space-y-2">
            {onShift.map((entry) => (
              <div
                key={entry.guardId}
                className="flex items-center justify-between gap-2 rounded-xl bg-white/10 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn('size-2.5 shrink-0 rounded-full ring-1 ring-white/40')}
                    style={{ backgroundColor: entry.colorVar }}
                    aria-hidden="true"
                  />
                  <p className="truncate text-sm font-bold">{entry.name}</p>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-xs font-bold opacity-90">{entry.he}</p>
                  <p className="num text-xs opacity-70">{entry.label}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
