import { AppShell } from '@/components/layout/AppShell';
import { ShiftLegend } from '@/components/ShiftChip';
import { Badge, Card, EmptyState, Spinner, cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveWeek, useRosterWeeks } from '@/hooks/useWeeks';
import { usePublishedRoster } from '@/hooks/useGuardPortal';
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
 * Shows the CURRENT week rather than the submission week -- a guard opening
 * this mid-week wants to know who is on tonight, not what they asked for next
 * week. Past weeks are invisible to guards by RLS (manager-only archive).
 */
export function RosterView() {
  const { profile } = useAuth();
  const { data: weeks } = useRosterWeeks();
  const { data: active } = useActiveWeek();

  const currentStart = weekStartOf(todayInIsrael());
  // Prefer the week in progress; fall back to whatever is open.
  const weekStart =
    weeks?.find((w) => w.week_start === currentStart)?.week_start ?? active.weekStart;

  const { data, isLoading } = usePublishedRoster(weekStart);

  if (isLoading) {
    return (
      <AppShell title="סידור שבועי">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  const assignments = data?.assignments ?? [];
  const guards = data?.guards ?? [];
  const dates = weekDates(weekStart);
  const nameOf = (id: string) => guards.find((g) => g.id === id)?.display_name ?? '—';

  if (assignments.length === 0) {
    return (
      <AppShell title="סידור שבועי" subtitle={formatWeekRange(weekStart)}>
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

  return (
    <AppShell title="סידור שבועי" subtitle={formatWeekRange(weekStart)}>
      <div className="space-y-3">
        <Card className="py-3">
          <ShiftLegend />
        </Card>

        {dates.map((date, dayIdx) => {
          const onDay = assignments
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
                              mine ? 'font-extrabold text-brand-800' : 'font-semibold text-slate-800',
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
