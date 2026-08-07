import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CoverageMatrix } from '@/components/manager/CoverageMatrix';
import { TeamTable } from '@/components/manager/TeamTable';
import { WeekControlsPanel } from '@/components/manager/WeekControlsPanel';
import { RosterGrid } from '@/components/manager/RosterGrid';
import { RosterEditor } from '@/components/manager/RosterEditor';
import { CoverageReportPanel } from '@/components/manager/CoverageReportPanel';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import {
  buildSolverInput,
  useGenerateSchedule,
  usePublishRun,
  useSaveRunAssignments,
  useScheduleRuns,
} from '@/hooks/useGenerateSchedule';
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
  const generate = useGenerateSchedule();
  const publish = usePublishRun();
  const saveEdits = useSaveRunAssignments();
  const [editing, setEditing] = useState(false);
  const { data: runsRaw } = useScheduleRuns(selected);

  const runsData = runsRaw ?? { runs: [], assignments: [] };
  // Runs come back newest-version first, so the published one wins if there is
  // one, otherwise the newest draft.
  const latestRun = runsData.runs.find((r) => r.is_published) ?? runsData.runs[0] ?? null;

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

        {/* ---------------- generate ---------------- */}
        <Card className="space-y-3">
          <div>
            <p className="font-bold text-slate-900">יצירת סידור</p>
            <p className="mt-1 text-sm text-slate-500">
              המנוע קורא את הזמינות והכמויות שלמעלה ומחזיר סידור יחד עם דוח כיסוי. כל הרצה נשמרת
              כגרסה חדשה - אפשר לייצר שוב ולהשוות.
            </p>
          </div>

          {generate.isError && (
            <Alert tone="error" title="היצירה נכשלה">
              <span className="whitespace-pre-line">
                {generate.error instanceof Error ? generate.error.message : 'נסה שוב.'}
              </span>
            </Alert>
          )}

          {generate.isSuccess && generate.data && (
            <Alert tone="success" title={`נוצרה גרסה ${generate.data.version}`}>
              {generate.data.engine === 'cp-sat'
                ? `מנוע CP-SAT · ${generate.data.status}`
                : 'מנוע מקומי (mock)'}{' '}
              · ניקוד {generate.data.objective}
            </Alert>
          )}

          <Button
            fullWidth
            size="lg"
            loading={generate.isPending}
            disabled={!data || rows.length === 0}
            onClick={() =>
              data &&
              generate.mutate({
                weekStart: selected,
                morningTarget: (week?.morning_target_slots ?? 2) as MorningTarget,
                data,
              })
            }
          >
            {generate.isPending ? 'מחשב סידור…' : 'צור סידור אוטומטי'}
          </Button>
        </Card>

        {/* ---------------- result ---------------- */}
        {latestRun && (
          <>
            <CoverageReportPanel report={latestRun.coverage_report} guards={data?.guards ?? []} />

            {editing && data ? (
              <RosterEditor
                weekStart={selected}
                morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
                assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                guards={data.guards}
                // The referee must judge an edit against exactly what the solver
                // saw, or a hand edit could be called illegal for the wrong reason.
                solverInput={buildSolverInput(
                  selected,
                  (week?.morning_target_slots ?? 2) as MorningTarget,
                  data,
                  {},
                )}
                saving={saveEdits.isPending}
                onCancel={() => setEditing(false)}
                onSave={(draft) =>
                  saveEdits.mutate(
                    {
                      runId: latestRun.id,
                      weekStart: selected,
                      assignments: draft.map((d) => ({
                        date: d.date,
                        shift: d.shift,
                        guard_id: d.guard_id,
                      })),
                    },
                    { onSuccess: () => setEditing(false) },
                  )
                }
              />
            ) : (
              <RosterGrid
                weekStart={selected}
                morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
                assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                guards={data?.guards ?? []}
              />
            )}

            <Card className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-slate-900">
                    גרסה {latestRun.version}
                    {latestRun.is_published && (
                      <Badge tone="green" className="ms-2">
                        מפורסם
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500">
                    {latestRun.solver_status} · ניקוד {latestRun.objective_value}
                  </p>
                </div>
              </div>

              {publish.isError && (
                <Alert tone="error" title="הפרסום נכשל">
                  {publish.error instanceof Error ? publish.error.message : 'נסה שוב.'}
                </Alert>
              )}

              {saveEdits.isError && (
                <Alert tone="error" title="שמירת העריכה נכשלה">
                  {saveEdits.error instanceof Error ? saveEdits.error.message : 'נסה שוב.'}
                </Alert>
              )}

              {!latestRun.is_published ? (
                <>
                  {!editing && (
                    <Button variant="secondary" fullWidth onClick={() => setEditing(true)}>
                      ערוך את הסידור
                    </Button>
                  )}
                  <Button
                    fullWidth
                    size="lg"
                    loading={publish.isPending}
                    disabled={editing}
                    onClick={() =>
                      publish.mutate({ runId: latestRun.id, weekStart: selected })
                    }
                  >
                    פרסם לצוות
                  </Button>
                  <p className="text-xs text-slate-500">
                    פרסום הופך את הסידור לגלוי לכל המאבטחים בטלפון. אפשר לפרסם גרסה אחרת אחר כך -
                    היא תחליף את הקודמת.
                  </p>
                </>
              ) : (
                <Alert tone="success">
                  הסידור פורסם והוא גלוי כעת לכל המאבטחים.
                </Alert>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
