import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ShiftLegend } from '@/components/ShiftChip';
import { Alert, Badge, Card, EmptyState, Spinner, cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useVisibleRosters } from '@/hooks/useGuardPortal';
import { useRosterRealtime } from '@/hooks/useRosterRealtime';
import {
  HEBREW_DAYS,
  formatDayMonth,
  formatWeekRange,
  todayInIsrael,
  weekDates,
  weekStartOf,
} from '@/lib/dates';
import { SHIFTS, isWeekendDay } from '@/lib/shifts';

/**
 * The published roster as a guard sees it: the whole team, so people can see
 * who they are on with, with their own shifts highlighted.
 *
 * Which weeks appear is decided by RLS, not by this component guessing. A guard
 * gets the current week and the next one; the previous week lingers until 07:00
 * on Sunday so an in-progress night shift stays readable. A manager gets all of
 * them and can page back through the archive here too.
 */
export function RosterView() {
  const { profile } = useAuth();
  const { data, isLoading } = useVisibleRosters();
  const { lastChangeAt } = useRosterRealtime(weekStartOf(todayInIsrael()));

  const weeks = data?.weeks ?? [];
  const guards = data?.guards ?? [];
  const currentStart = weekStartOf(todayInIsrael());

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected || weeks.length === 0) return;
    // Open on the week in progress; fall back to the earliest available.
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
            description="לאחר שהמנהל יפרסם את הסידור, הוא יופיע כאן אוטומטית."
          />
        </Card>
      </AppShell>
    );
  }

  const week = weeks.find((w) => w.weekStart === selected) ?? weeks[0]!;
  const dates = weekDates(week.weekStart);
  const nameOf = (id: string) => guards.find((g) => g.id === id)?.display_name ?? '—';

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
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {w.weekStart === currentStart ? 'השבוע' : formatWeekRange(w.weekStart)}
              </button>
            ))}
          </div>
        )}

        <Card className="py-3">
          <ShiftLegend />
        </Card>

        {dates.map((date, dayIdx) => {
          const onDay = week.assignments
            .filter((a) => a.target_date === date)
            .sort((a, b) => SHIFTS[a.shift].startH - SHIFTS[b.shift].startH);
          const isToday = date === todayInIsrael();

          return (
            <Card
              key={date}
              className={cn(
                'p-0',
                isToday && 'ring-2 ring-brand-500',
                isWeekendDay(dayIdx) && 'bg-amber-50/40',
              )}
            >
              <div className="flex items-baseline gap-2 border-b border-slate-100 px-4 py-2.5">
                <span className="font-bold text-slate-900">יום {HEBREW_DAYS[dayIdx]}</span>
                <span className="text-xs text-slate-400">{formatDayMonth(date)}</span>
                {isToday && (
                  <Badge tone="brand" className="ms-auto">
                    היום
                  </Badge>
                )}
              </div>

              {onDay.length === 0 ? (
                <p className="px-4 py-3 text-sm text-slate-400">אין שיבוץ</p>
              ) : (
                <div className="divide-y divide-slate-50">
                  {onDay.map((a) => {
                    const mine = a.guard_id === profile?.id;
                    const def = SHIFTS[a.shift];
                    return (
                      <div
                        key={a.id}
                        className={cn(
                          'flex items-center gap-3 px-4 py-2',
                          mine && 'bg-brand-50/70',
                        )}
                      >
                        <span
                          className="w-1.5 self-stretch rounded-full"
                          style={{ backgroundColor: def.colorVar }}
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'truncate text-sm',
                              mine
                                ? 'font-extrabold text-brand-800'
                                : 'font-semibold text-slate-800',
                            )}
                          >
                            {nameOf(a.guard_id)}
                            {mine && ' (אתה)'}
                          </p>
                          {a.post && <p className="text-xs text-slate-500">{a.post}</p>}
                        </div>
                        <div className="text-end">
                          <p className="text-xs font-bold text-slate-700">{def.he}</p>
                          <p className="num text-[10px] text-slate-400">{def.label}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </AppShell>
  );
}
