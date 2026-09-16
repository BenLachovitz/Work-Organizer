import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { KippurPanel } from '@/components/manager/KippurPanel';
import { WeekControlsPanel } from '@/components/manager/WeekControlsPanel';
import { WeekExceptionsPanel } from '@/components/manager/WeekExceptionsPanel';
import { Alert, Card, Spinner } from '@/components/ui';
import { useSplitWeeks } from '@/hooks/useWeeks';
import { useManagerSubmissionsRealtime } from '@/hooks/useRosterRealtime';
import {
  buildGuardRows,
  useManagerWeek,
  useMorningTargetOverrides,
  useSegmentTargetOverrides,
  useUpdateMorningTargetOverride,
  useUpdateSegmentTargetOverride,
  useUpdateWeek,
} from '@/hooks/useManager';
import { formatWeekRange } from '@/lib/dates';
import { useSchedulerSettings } from '@/hooks/useSchedulerSettings';
import type { MorningTarget } from '@/lib/shifts';
import { useViewMode } from '@/contexts/ViewModeContext';
import { visibleToViewMode } from '@/lib/viewMode';

/**
 * The manager's landing page: which week, is it open, and who hasn't
 * submitted yet -- the things worth seeing on every visit without a click.
 * Everything else that used to live here (team availability, the כמות table,
 * generating/reviewing/publishing a roster, team CRUD, guard-preference
 * detail, standing scheduler defaults) now lives on its own page, reached
 * from the nav list below -- each carries the currently selected week over
 * via ?week= where it's relevant, so switching pages doesn't mean re-picking
 * the week.
 */
export function ManagerDashboard() {
  const { data: weeks, live, archive, nextStart, isLoading: weeksLoading } = useSplitWeeks();
  const [selected, setSelected] = useState<string>('');

  // Default to NEXT week, not whichever happens to be "open" -- most of a
  // manager's actual work (setting כמות, generating, publishing) is for the
  // week ahead, not the one already in progress. Falls back to whatever is
  // live if next week has not been created yet.
  useEffect(() => {
    if (selected || !live.length) return;
    const next = live.find((w) => w.week_start === nextStart);
    setSelected(next?.week_start ?? live[0]!.week_start);
  }, [live, selected, nextStart]);

  const { data, isLoading, error } = useManagerWeek(selected);
  const { data: morningTargetOverridesRaw } = useMorningTargetOverrides(selected);
  const morningTargetOverrides = morningTargetOverridesRaw ?? {};
  const updateDayOverride = useUpdateMorningTargetOverride();
  const { data: segmentTargetOverridesRaw } = useSegmentTargetOverrides(selected);
  const segmentTargetOverrides = segmentTargetOverridesRaw ?? {};
  const updateSegmentDayOverride = useUpdateSegmentTargetOverride();
  const updateWeek = useUpdateWeek();
  const { data: schedulerSettings } = useSchedulerSettings();
  // A guard submitting availability, or writing a note (§3.6), previously sat
  // invisible until the manager reloaded the page.
  useManagerSubmissionsRealtime(selected || null);

  const { viewMode } = useViewMode();
  const week = weeks?.find((w) => w.week_start === selected) ?? null;
  // Filtered for DISPLAY only, same as every other manager list -- the
  // view-mode toggle changes what the manager sees, never who gets scheduled.
  const rows = useMemo(
    () =>
      data
        ? buildGuardRows(data).filter((r) => visibleToViewMode(r.guard, viewMode))
        : [],
    [data, viewMode],
  );

  if (weeksLoading) {
    return (
      <AppShell title="ניהול">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (!weeks?.length) {
    return (
      <AppShell title="ניהול">
        <Card>
          <p className="font-bold text-slate-900 dark:text-slate-100">אין שבועות מוגדרים</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            יש להוסיף שבוע חדש לפני שניתן לנהל שיבוצים.
          </p>
        </Card>
      </AppShell>
    );
  }

  const notSubmitted = rows.filter((r) => r.state === 'none');

  return (
    <AppShell title="ניהול" subtitle={selected ? formatWeekRange(selected) : undefined}>
      <div className="space-y-4">
        <WeekControlsPanel
          weeks={live}
          archive={archive}
          selected={selected}
          onSelect={setSelected}
          week={week}
          saving={updateWeek.isPending}
          onSetStatus={(s) => updateWeek.mutate({ weekStart: selected, status: s })}
        />

        <WeekExceptionsPanel
          week={week}
          saving={updateWeek.isPending}
          onSetMorningTarget={(t: MorningTarget) =>
            updateWeek.mutate({ weekStart: selected, morningTarget: t })
          }
          morningTargetOverrides={morningTargetOverrides}
          onSetDayOverride={(dayIndex, t) =>
            updateDayOverride.mutate({
              weekStart: selected,
              dayIndex,
              // Equal-to-baseline normalises to "no override row" (§1) --
              // clicking the value that already matches the week setting is
              // how a manager clears an exception for that day.
              target: t === ((week?.morning_target_slots ?? 2) as MorningTarget) ? null : t,
            })
          }
          segmentTargetOverrides={segmentTargetOverrides}
          onSetSegmentDayOverride={(dayIndex, segment, t) =>
            updateSegmentDayOverride.mutate({
              weekStart: selected,
              dayIndex,
              segment,
              // Same equal-to-baseline normalisation as morning -- S2/S3/S4's
              // baseline is always the flat 2.
              target: t === 2 ? null : t,
            })
          }
          onSetDoubleShiftHours={(h) =>
            updateWeek.mutate({ weekStart: selected, doubleShiftHours: h })
          }
        />

        {schedulerSettings?.kippur_handling_enabled && data && (
          <KippurPanel
            weekStart={selected}
            week={week}
            data={data}
            saving={updateWeek.isPending}
            onSetGuardCount={(count) =>
              updateWeek.mutate({ weekStart: selected, kippurGuardCount: count })
            }
          />
        )}

        {updateWeek.isError && (
          <Alert tone="error" title="העדכון נכשל">
            {updateWeek.error instanceof Error ? updateWeek.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {/* Gated on the SELECTED week's own fetch -- WeekControlsPanel and
            WeekExceptionsPanel above stay mounted while it loads or errors,
            instead of the whole page unmounting and remounting.
            WeekControlsPanel's "show archive" toggle is local component
            state; a remount was resetting it to the live-weeks view every
            time a different week (especially an archived one) was picked,
            which is exactly the wrong moment for it to reset. */}
        {selected && isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-7 text-brand-600" />
          </div>
        ) : error ? (
          <Alert tone="error" title="שגיאה בטעינת הנתונים">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          notSubmitted.length > 0 && (
            <Alert tone="warn" title={`${notSubmitted.length} מאבטחים טרם הגישו`}>
              {notSubmitted.map((r) => r.guard.display_name).join(', ')}
            </Alert>
          )
        )}

        <Card className="p-0">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            <NavRow
              to={`/manage/summary?week=${selected}`}
              title="סיכום שבועי"
              description="זמינות הצוות והכמות השבועית"
            />
            <NavRow
              to={`/manage/roster?week=${selected}`}
              title="יצירת סידור"
              description="יצירה, עריכה ופרסום"
            />
            <NavRow
              to={`/manage/preferences?week=${selected}`}
              title="העדפות הצוות"
              description="צפייה ועריכה לפי יום ומשמרת"
            />
            <NavRow
              to="/manage/team"
              title="ניהול צוות"
              description="הוספה, הסרה ועדכון ברירות מחדל"
            />
            <NavRow to="/manage/settings" title="הגדרות" description="ברירות מחדל למערכת" />
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

function NavRow({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
    >
      <div className="min-w-0">
        <p className="font-bold text-slate-900 dark:text-slate-100">{title}</p>
        <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      <span className="shrink-0 text-lg text-slate-400 dark:text-slate-500">‹</span>
    </Link>
  );
}
