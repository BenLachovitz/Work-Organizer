import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CoverageMatrix } from '@/components/manager/CoverageMatrix';
import { TeamTable } from '@/components/manager/TeamTable';
import { WeekControlsPanel } from '@/components/manager/WeekControlsPanel';
import { SubmissionWindowSettings } from '@/components/manager/SubmissionWindowSettings';
import { DefaultMorningTargetSettings } from '@/components/manager/DefaultMorningTargetSettings';
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
  useMorningTargetOverrides,
  useRosterCodeStatus,
  useSegmentTargetOverrides,
  useSetGuardTarget,
  useUpdateMorningTargetOverride,
  useUpdateSegmentTargetOverride,
  useUpdateWeek,
} from '@/hooks/useManager';
import { formatWeekRange, weekDates } from '@/lib/dates';
import type { MorningTarget } from '@/lib/shifts';
import { useViewMode } from '@/contexts/ViewModeContext';
import { visibleToViewMode } from '@/lib/viewMode';

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
  const { data: codes } = useRosterCodeStatus();
  const { data: morningTargetOverridesRaw } = useMorningTargetOverrides(selected);
  const morningTargetOverrides = morningTargetOverridesRaw ?? {};
  const updateDayOverride = useUpdateMorningTargetOverride();
  const { data: segmentTargetOverridesRaw } = useSegmentTargetOverrides(selected);
  const segmentTargetOverrides = segmentTargetOverridesRaw ?? {};
  const updateSegmentDayOverride = useUpdateSegmentTargetOverride();
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
  useRosterRealtime(selected ? [selected] : []);
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

  const { viewMode } = useViewMode();
  const week = weeks?.find((w) => w.week_start === selected) ?? null;
  const dates = useMemo(() => (selected ? weekDates(selected) : []), [selected]);
  // Filtered for DISPLAY only -- generation, RosterGrid and export below all
  // keep reading `data.guards` unfiltered, since the view-mode toggle changes
  // what the manager sees in these lists, never who gets scheduled.
  const rows = useMemo(
    () =>
      data
        ? buildGuardRows(data).filter((r) => visibleToViewMode(r.guard, viewMode))
        : [],
    [data, viewMode],
  );
  const coverage = useMemo(() => (data ? buildCoverage(data, dates) : []), [data, dates]);

  const unregistered = (codes ?? [])
    .filter((c) => !c.is_claimed)
    .filter((c) => visibleToViewMode(c, viewMode));

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
          onSetStatus={(s) => updateWeek.mutate({ weekStart: selected, status: s })}
        />

        <DefaultMorningTargetSettings />

        <SubmissionWindowSettings />

        {updateWeek.isError && (
          <Alert tone="error" title="העדכון נכשל">
            {updateWeek.error instanceof Error ? updateWeek.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {/* Week-detail content only, gated on the SELECTED week's own fetch --
            WeekControlsPanel and the settings cards above stay mounted while
            it loads or errors, instead of the whole page unmounting and
            remounting. WeekControlsPanel's "show archive" toggle is local
            component state; a remount was resetting it to the live-weeks
            view every time a different week (especially an archived one)
            was picked, which is exactly the wrong moment for it to reset. */}
        {selected && isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-7 text-brand-600" />
          </div>
        ) : error ? (
          <Alert tone="error" title="שגיאה בטעינת הנתונים">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          <>
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
              morningTargetOverrides={morningTargetOverrides}
              segmentTargetOverrides={segmentTargetOverrides}
            />

            <TeamTable
              rows={rows}
              savingGuardId={setTarget.isPending ? setTarget.variables?.guardId : null}
              onSetKamut={(guardId, kamut) =>
                setTarget.mutate({ weekStart: selected, guardId, kamut })
              }
            />

            {/* TeamTable above only shows aggregate counts per guard. This page
                shows the actual day/shift breakdown and lets the manager edit
                a guard's availability and עדיפות marks on their behalf --
                carries the currently selected week over via ?week=. */}
            <ButtonLink to={`/manage/preferences?week=${selected}`} variant="secondary" fullWidth>
              העדפות הצוות - צפייה ועריכה לפי יום ומשמרת
            </ButtonLink>

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
                <p className="font-bold text-slate-900 dark:text-slate-100">יצירת סידור</p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  המנוע קורא את הזמינות והכמויות שלמעלה ומחזיר סידור יחד עם דוח כיסוי. כל הרצה
                  נשמרת כגרסה חדשה - אפשר לייצר שוב ולהשוות.
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
                    morningTargetOverrides,
                    secondaryTargetOverrides: segmentTargetOverrides,
                  })
                }
              >
                {generate.isPending ? 'מחשב סידור…' : 'צור סידור אוטומטי'}
              </Button>
            </Card>

            {/* ---------------- result ---------------- */}
            {latestRun && (
              <>
                <CoverageReportPanel
                  report={latestRun.coverage_report}
                  guards={data?.guards ?? []}
                />

                {editing && data ? (
                  <RosterEditor
                    weekStart={selected}
                    morningTarget={(week?.morning_target_slots ?? 2) as MorningTarget}
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
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
                      morningTargetOverrides,
                      segmentTargetOverrides,
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
                            note_before: d.noteBefore,
                            note_after: d.noteAfter,
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
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
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
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
                    assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                    guards={data?.guards ?? []}
                  />
                )}

                {(publish.isError ||
                  saveEdits.isError ||
                  deleteRun.isError ||
                  unpublish.isError) && (
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
          </>
        )}
      </div>
    </AppShell>
  );
}
