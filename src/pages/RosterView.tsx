import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RosterGrid } from '@/components/RosterGrid';
import { Alert, Card, EmptyState, Spinner, cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useVisibleRosters } from '@/hooks/useGuardPortal';
import { useRosterRealtime } from '@/hooks/useRosterRealtime';
import {
  HEBREW_DAYS,
  dayIndex,
  formatDayMonth,
  formatWeekRange,
  todayInIsrael,
  weekStartOf,
} from '@/lib/dates';
import { SHIFTS } from '@/lib/shifts';

/**
 * The published roster as a guard sees it -- in the SAME grid the manager builds
 * it in, and the same shape as the spreadsheet the team already reads. The
 * component is shared rather than duplicated, so the two views cannot drift.
 *
 * The guard's own shifts are ringed, and a summary underneath lists just theirs,
 * because a grid answers "who is on Tuesday night" well and "when am I working"
 * poorly. Both questions get asked.
 */
export function RosterView() {
  const { profile } = useAuth();
  const { data, isLoading } = useVisibleRosters();
  const { lastChangeAt } = useRosterRealtime(weekStartOf(todayInIsrael()));

  const weeks = data?.weeks ?? [];
  const guards = data?.guards ?? [];
  const currentStart = weekStartOf(todayInIsrael());
  const today = todayInIsrael();

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected || weeks.length === 0) return;
    setSelected(weeks.find((w) => w.weekStart === currentStart)?.weekStart ?? weeks[0]!.weekStart);
  }, [weeks, selected, currentStart]);

  if (isLoading) {
    return (
      <AppShell title="סידור שבועי">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (weeks.length === 0) {
    return (
      <AppShell title="סידור שבועי">
        <Card className="p-0">
          <EmptyState
            icon="🗓️"
            title="טרם פורסם סידור"
            description="לאחר שיפורסם הסידור, הוא יופיע כאן אוטומטית."
          />
        </Card>
      </AppShell>
    );
  }

  const week = weeks.find((w) => w.weekStart === selected) ?? weeks[0]!;
  const mine = week.assignments
    .filter((a) => a.guard_id === profile?.id)
    .sort((a, b) => a.target_date.localeCompare(b.target_date));

  return (
    <AppShell title="סידור שבועי" subtitle={formatWeekRange(week.weekStart)}>
      <div className="space-y-3">
        {lastChangeAt && (
          <Alert tone="info">
            הסידור עודכן זה עתה (
            {lastChangeAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}).
          </Alert>
        )}

        {weeks.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {weeks.map((w) => (
              <button
                key={w.runId}
                type="button"
                onClick={() => setSelected(w.weekStart)}
                className={cn(
                  'shrink-0 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
                  w.weekStart === week.weekStart
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                )}
              >
                {w.weekStart === currentStart ? 'השבוע' : formatWeekRange(w.weekStart)}
              </button>
            ))}
          </div>
        )}

        <RosterGrid
          title="הסידור השבועי"
          weekStart={week.weekStart}
          morningTarget={week.morningTarget}
          assignments={week.assignments}
          guards={guards}
          highlightGuardId={profile?.id}
          todayDate={week.weekStart === currentStart ? today : undefined}
        />

        {/* A grid answers "who is on Tuesday night" but scanning it for your own
            name across 21 cells is work. This does that scan for you. */}
        <Card className="p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <p className="font-bold text-slate-900 dark:text-slate-100">המשמרות שלי</p>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {mine.length === 0
                ? 'אין לך משמרות בשבוע זה'
                : `${mine.length} משמרות · מסומנות במסגרת בטבלה`}
            </p>
          </div>
          {mine.length > 0 && (
            <div className="divide-y divide-slate-50 dark:divide-slate-800">
              {mine.map((a) => {
                const def = SHIFTS[a.shift];
                const isToday = a.target_date === today;
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5',
                      isToday && 'bg-brand-50/70 dark:bg-brand-950/50',
                    )}
                  >
                    <span
                      className="w-1.5 self-stretch rounded-full"
                      style={{ backgroundColor: def.colorVar }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        יום {HEBREW_DAYS[dayIndex(a.target_date)]}
                        {isToday && (
                          <span className="ms-2 text-xs text-brand-700 dark:text-brand-400">
                            היום
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {formatDayMonth(a.target_date)}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        {def.he}
                      </p>
                      <p className="num text-[10px] text-slate-400 dark:text-slate-500">
                        {def.label}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
