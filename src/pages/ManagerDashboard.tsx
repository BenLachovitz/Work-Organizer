import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CoverageMatrix } from '@/components/manager/CoverageMatrix';
import { TeamTable } from '@/components/manager/TeamTable';
import { WeekControlsPanel } from '@/components/manager/WeekControlsPanel';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { useSplitWeeks } from '@/hooks/useWeeks';
import {
  buildCoverage,
  buildGuardRows,
  useManagerWeek,
  useRosterCodeStatus,
  useSetGuardTarget,
  useUpdateWeek,
} from '@/hooks/useManager';
import { formatWeekRange, weekDates } from '@/lib/dates';
import type { MorningTarget } from '@/lib/shifts';

export function ManagerDashboard() {
  const { data: weeks, live, archive, isLoading: weeksLoading } = useSplitWeeks();
  const [selected, setSelected] = useState<string>('');

  // Default to the first week still accepting submissions -- that is the one a
  // manager is almost always here to work on.
  useEffect(() => {
    if (selected || !live.length) return;
    const now = Date.now();
    const open = live.find(
      (w) => w.status === 'open' && new Date(w.submission_deadline).getTime() > now,
    );
    setSelected(open?.week_start ?? live[0]!.week_start);
  }, [live, selected]);

  const { data, isLoading, error } = useManagerWeek(selected);
  const { data: codes } = useRosterCodeStatus();
  const updateWeek = useUpdateWeek();
  const setTarget = useSetGuardTarget();

  const week = weeks?.find((w) => w.week_start === selected) ?? null;
  const dates = useMemo(() => (selected ? weekDates(selected) : []), [selected]);
  const rows = useMemo(() => (data ? buildGuardRows(data) : []), [data]);
  const coverage = useMemo(() => (data ? buildCoverage(data, dates) : []), [data, dates]);

  const unregistered = (codes ?? []).filter((c) => !c.is_claimed);

  if (weeksLoading || (selected && isLoading)) {
    return (
      <AppShell title="ניהול">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell title="ניהול">
        <Alert tone="error" title="שגיאה בטעינת הנתונים">
          {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
        </Alert>
      </AppShell>
    );
  }

  if (!weeks?.length) {
    return (
      <AppShell title="ניהול">
        <Card>
          <p className="font-bold text-slate-900">אין שבועות מוגדרים</p>
          <p className="mt-1 text-sm text-slate-500">
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
          onSetMorningTarget={(t: MorningTarget) =>
            updateWeek.mutate({ weekStart: selected, morningTarget: t })
          }
          onSetStatus={(s) => updateWeek.mutate({ weekStart: selected, status: s })}
        />

        {updateWeek.isError && (
          <Alert tone="error" title="העדכון נכשל">
            {updateWeek.error instanceof Error ? updateWeek.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {notSubmitted.length > 0 && (
          <Alert tone="warn" title={`${notSubmitted.length} מאבטחים טרם הגישו`}>
            {notSubmitted.map((r) => r.guard.display_name).join(', ')}
          </Alert>
        )}

        {unregistered.length > 0 && (
          <Alert tone="info" title={`${unregistered.length} קודים טרם נרשמו למערכת`}>
            {unregistered.map((c) => `${c.display_name} (${c.employee_code})`).join(', ')}
          </Alert>
        )}

        <CoverageMatrix
          cells={coverage}
          dates={dates}
          morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
        />

        <TeamTable
          rows={rows}
          savingGuardId={setTarget.isPending ? setTarget.variables?.guardId : null}
          onSetKamut={(guardId, kamut) =>
            setTarget.mutate({ weekStart: selected, guardId, kamut })
          }
        />

        {setTarget.isError && (
          <Alert tone="error" title="שמירת הכמות נכשלה">
            {setTarget.error instanceof Error ? setTarget.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {/* ---------------- generate (Step E) ---------------- */}
        <Card>
          <p className="font-bold text-slate-900">יצירת סידור</p>
          <p className="mt-1 text-sm text-slate-500">
            מנוע השיבוץ (Google OR-Tools) ייבנה בשלב הבא. הוא יקרא את הזמינות והכמויות שלמעלה
            ויחזיר סידור מיטבי יחד עם דוח כיסוי.
          </p>
          <Button className="mt-3" fullWidth disabled>
            צור סידור אוטומטי · בקרוב
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}
