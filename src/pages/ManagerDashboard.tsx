import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CoverageMatrix } from '@/components/manager/CoverageMatrix';
import { TeamTable } from '@/components/manager/TeamTable';
import { WeekControlsPanel } from '@/components/manager/WeekControlsPanel';
import { RosterGrid } from '@/components/RosterGrid';
import { RosterEditor } from '@/components/manager/RosterEditor';
import { RosterExport } from '@/components/manager/RosterExport';
import { CoverageReportPanel } from '@/components/manager/CoverageReportPanel';
import { RunVersions } from '@/components/manager/RunVersions';
import { Alert, Button, ButtonLink, Card, Spinner } from '@/components/ui';
import {
  buildSolverInput,
  useCarryIn,
  useDeleteRun,
  useGenerateSchedule,
  usePublishRun,
  useSaveRunAssignments,
  useScheduleRuns,
  useUnpublishRun,
} from '@/hooks/useGenerateSchedule';
import { useSplitWeeks } from '@/hooks/useWeeks';
import { useManagerSubmissionsRealtime, useRosterRealtime } from '@/hooks/useRosterRealtime';
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
  const unpublish = useUnpublishRun();
  const deleteRun = useDeleteRun();
  const [editing, setEditing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { data: runsRaw } = useScheduleRuns(selected);
  const { data: carryIn } = useCarryIn(selected);
  // Not for the manager's own edits -- the mutation already invalidates those --
  // but so a second device, or the phone in their pocket, stays truthful.
  useRosterRealtime(selected || null);
  // A guard submitting availability, or writing a note (§3.6), previously sat
  // invisible until the manager reloaded the page.
  useManagerSubmissionsRealtime(selected || null);

  const runsData = runsRaw ?? { runs: [], assignments: [] };
  // The manager may be looking at any version. Default to the published one if
  // there is one, otherwise the newest draft; fall back if the chosen run was
  // just deleted.
  const defaultRun = runsData.runs.find((r) => r.is_published) ?? runsData.runs[0] ?? null;
  const latestRun =
    runsData.runs.find((r) => r.id === selectedRunId) ?? defaultRun;

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

        {/* Team CRUD (add/remove employees, edit their baseline כמות) lives on
            its own page -- a config screen, not part of the weekly workflow
            this dashboard is otherwise about. */}
        <ButtonLink to="/manage/team" variant="secondary" fullWidth>
          ניהול צוות - הוספה, הסרה ועדכון ברירות מחדל
        </ButtonLink>

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
                // saw -- including last Saturday's shifts, or a manual Sunday
                // assignment could create a clopen across the week boundary
                // that nothing would catch.
                solverInput={buildSolverInput(
                  selected,
                  (week?.morning_target_slots ?? 2) as MorningTarget,
                  data,
                  carryIn ?? {},
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

            {/* Only for a published run, and never mid-edit: an image of a draft
                is indistinguishable from the real thing once it is in the group
                chat, and no later edit catches up with it. */}
            {latestRun.is_published && !editing && (
              <RosterExport
                weekStart={selected}
                morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
                assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                guards={data?.guards ?? []}
              />
            )}

            {(publish.isError || saveEdits.isError || deleteRun.isError || unpublish.isError) && (
              <Alert tone="error" title="הפעולה נכשלה">
                {[publish.error, saveEdits.error, deleteRun.error, unpublish.error]
                  .filter((e): e is Error => e instanceof Error)
                  .map((e) => e.message)
                  .join(' · ') || 'נסה שוב.'}
              </Alert>
            )}

            <RunVersions
              runs={runsData.runs}
              selectedId={latestRun.id}
              onSelect={(id) => {
                setSelectedRunId(id);
                setEditing(false);
              }}
              onPublish={(id) => publish.mutate({ runId: id, weekStart: selected })}
              onUnpublish={(id) => unpublish.mutate({ runId: id, weekStart: selected })}
              onEdit={(id) => {
                setSelectedRunId(id);
                setEditing(true);
              }}
              onDelete={(id) =>
                deleteRun.mutate(
                  { runId: id, weekStart: selected },
                  // The deleted run may have been the one on screen; clearing
                  // the selection lets it fall back to whatever remains.
                  { onSuccess: () => setSelectedRunId(null) },
                )
              }
              busy={publish.isPending || unpublish.isPending || deleteRun.isPending}
              disabled={editing}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
