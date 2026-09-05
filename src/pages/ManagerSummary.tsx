import { useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CoverageMatrix } from '@/components/manager/CoverageMatrix';
import { TeamTable, summarizeTeam } from '@/components/manager/TeamTable';
import { WeekSelectCard } from '@/components/manager/WeekSelectCard';
import { Alert, ButtonLink, Card, Collapsible, Spinner } from '@/components/ui';
import { useManagerWeekSelection } from '@/hooks/useWeeks';
import { useManagerSubmissionsRealtime } from '@/hooks/useRosterRealtime';
import {
  buildCoverage,
  buildGuardRows,
  useManagerWeek,
  useMorningTargetOverrides,
  useSegmentTargetOverrides,
  useSetGuardTarget,
} from '@/hooks/useManager';
import { formatWeekRange, weekDates } from '@/lib/dates';
import type { MorningTarget } from '@/lib/shifts';
import { useViewMode } from '@/contexts/ViewModeContext';
import { visibleToViewMode } from '@/lib/viewMode';

/**
 * "How is this week actually looking" -- what the team said it can work
 * (CoverageMatrix, formerly "זמינות הצוות" on the main dashboard) and each
 * guard's own כמות (TeamTable, "הצוות והכמות") -- pulled off the main
 * workflow page and onto its own read-focused page, each collapsible so a
 * manager who only needs one of the two isn't forced to scroll past both.
 * Reached from ManagerDashboard's nav row, carrying the week already being
 * looked at via ?week=, same as ManagerPreferences already does.
 */
export function ManagerSummary() {
  const { weeks, selected, setSelected, nextStart, isLoading: weeksLoading } =
    useManagerWeekSelection();
  const { data, isLoading, error } = useManagerWeek(selected);
  const { data: morningTargetOverridesRaw } = useMorningTargetOverrides(selected);
  const morningTargetOverrides = morningTargetOverridesRaw ?? {};
  const { data: segmentTargetOverridesRaw } = useSegmentTargetOverrides(selected);
  const segmentTargetOverrides = segmentTargetOverridesRaw ?? {};
  const setTarget = useSetGuardTarget();
  const { viewMode } = useViewMode();
  // A guard submitting availability, or writing a note, previously sat
  // invisible here until the manager reloaded the page -- same reasoning as
  // ManagerDashboard's own subscription.
  useManagerSubmissionsRealtime(selected || null);

  const week = weeks.find((w) => w.week_start === selected) ?? null;
  const dates = useMemo(() => (selected ? weekDates(selected) : []), [selected]);
  const rows = useMemo(
    () =>
      data ? buildGuardRows(data).filter((r) => visibleToViewMode(r.guard, viewMode)) : [],
    [data, viewMode],
  );
  const coverage = useMemo(() => (data ? buildCoverage(data, dates) : []), [data, dates]);

  if (weeksLoading) {
    return (
      <AppShell title="סיכום שבועי">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (!weeks.length) {
    return (
      <AppShell title="סיכום שבועי">
        <Card>
          <p className="font-bold text-slate-900 dark:text-slate-100">אין שבועות מוגדרים</p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="סיכום שבועי" subtitle={selected ? formatWeekRange(selected) : undefined}>
      <div className="space-y-4">
        <ButtonLink to="/manage" variant="ghost" size="sm">
          → חזרה לניהול
        </ButtonLink>

        <WeekSelectCard
          id="summary-week-select"
          weeks={weeks}
          selected={selected}
          nextStart={nextStart}
          onSelect={setSelected}
        />

        {isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-7 text-brand-600" />
          </div>
        ) : error ? (
          <Alert tone="error" title="שגיאה בטעינת הנתונים">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          <>
            <Collapsible
              variant="card"
              title="זמינות הצוות"
              summary="כמה מאבטחים סימנו שהם יכולים לעבוד בכל משמרת"
              defaultExpanded
              bodyClassName=""
            >
              <CoverageMatrix
                cells={coverage}
                dates={dates}
                morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
                morningTargetOverrides={morningTargetOverrides}
                segmentTargetOverrides={segmentTargetOverrides}
              />
            </Collapsible>

            <Collapsible
              variant="card"
              title="הצוות והכמות"
              summary={summarizeTeam(rows)}
              defaultExpanded
              bodyClassName=""
            >
              <TeamTable
                rows={rows}
                savingGuardId={setTarget.isPending ? setTarget.variables?.guardId : null}
                onSetKamut={(guardId, kamut) =>
                  setTarget.mutate({ weekStart: selected, guardId, kamut })
                }
              />
            </Collapsible>

            {setTarget.isError && (
              <Alert tone="error" title="שמירת הכמות נכשלה">
                {setTarget.error instanceof Error ? setTarget.error.message : 'נסה שוב.'}
              </Alert>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
