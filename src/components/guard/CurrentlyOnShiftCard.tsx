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
  phoneNumber: string | null;
}

/** Hand-drawn to match this app's existing icon convention (no icon library
 *  is installed) -- a plain phone-receiver glyph, not any brand's mark. */
function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

/** A plain chat-bubble glyph -- deliberately generic, not a reproduction of
 *  WhatsApp's own trademarked logo, same hand-drawn convention as every
 *  other icon in this app. The emerald tint plus the aria-label are what
 *  say "WhatsApp" here, not the shape itself. */
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 2a8 8 0 00-6.922 11.978L2 18l4.2-1.046A8 8 0 1010 2zm-3.5 7a1 1 0 112 0 1 1 0 01-2 0zm3.5-1a1 1 0 100 2 1 1 0 000-2zm3.5 1a1 1 0 11-2 0 1 1 0 012 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const ICON_LINK_CLASS =
  'grid shrink-0 place-items-center rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white';

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
    const byId = new Map(guards.map((g) => [g.id, g]));

    const entries: OnShiftEntry[] = [];
    for (const week of weeks) {
      for (const a of week.assignments) {
        // guard_id is null for a placeholder row (§12.9) -- nothing to show
        // a name for, and this card is specifically about identifying a
        // person.
        if (!a.guard_id || !relevantDates.has(a.target_date)) continue;
        if (!isShiftActiveAt(a.target_date, a.shift, now)) continue;
        const guard = byId.get(a.guard_id);
        if (!guard) continue;
        const def = SHIFTS[a.shift];
        entries.push({
          guardId: a.guard_id,
          name: guard.display_name,
          he: def.he,
          label: def.label,
          colorVar: def.colorVar,
          phoneNumber: guard.phone_number,
        });
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
                className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={cn('size-2.5 shrink-0 rounded-full ring-1 ring-white/40')}
                    style={{ backgroundColor: entry.colorVar }}
                    aria-hidden="true"
                  />
                  <p className="truncate text-sm font-bold">{entry.name}</p>
                </div>

                {entry.phoneNumber && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <a
                      href={`tel:${entry.phoneNumber}`}
                      className={ICON_LINK_CLASS}
                      aria-label={`התקשרות אל ${entry.name}`}
                    >
                      <PhoneIcon className="size-4" />
                    </a>
                    <a
                      href={`https://wa.me/${entry.phoneNumber.replace('+', '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(ICON_LINK_CLASS, 'hover:text-emerald-300')}
                      aria-label={`וואטסאפ עם ${entry.name}`}
                    >
                      <ChatIcon className="size-4" />
                    </a>
                  </div>
                )}

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
