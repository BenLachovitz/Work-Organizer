import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RosterGrid } from '@/components/RosterGrid';
import { RosterEditor } from '@/components/manager/RosterEditor';
import { RosterExport } from '@/components/manager/RosterExport';
import { RosterPublishNotify } from '@/components/manager/RosterPublishNotify';
import { CoverageReportPanel } from '@/components/manager/CoverageReportPanel';
import { RunVersions } from '@/components/manager/RunVersions';
import { WeekSelectCard } from '@/components/manager/WeekSelectCard';
import { Alert, Button, ButtonLink, Card, Collapsible, Spinner } from '@/components/ui';
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
import { useManagerWeekSelection } from '@/hooks/useWeeks';
import { useRosterRealtime } from '@/hooks/useRosterRealtime';
import {
  useManagerWeek,
  useMorningTargetOverrides,
  useSegmentTargetOverrides,
} from '@/hooks/useManager';
import { formatWeekRange } from '@/lib/dates';
import type { DoubleShiftHours, MorningTarget } from '@/lib/shifts';

/**
 * The generate -> review -> publish workflow, pulled off the main dashboard
 * onto its own page -- the generate button and every card in its result
 * pipeline (coverage report, export, publish-announce, run versions) are
 * each collapsible here, so a manager who already reviewed one can collapse
 * it while working through the rest. The roster grid/editor itself stays
 * uncollapsed -- it's the one thing this page exists to show, and RosterGrid
 * is shared with guard-facing pages that render it plainly, so it keeps that
 * same always-visible treatment here too. Reached from ManagerDashboard's
 * nav row, carrying the week already being looked at via ?week=.
 */
export function ManagerRoster() {
  const { weeks, selected, setSelected, nextStart, isLoading: weeksLoading } =
    useManagerWeekSelection();
  const { data, isLoading, error } = useManagerWeek(selected);
  const { data: morningTargetOverridesRaw } = useMorningTargetOverrides(selected);
  const morningTargetOverrides = morningTargetOverridesRaw ?? {};
  const { data: segmentTargetOverridesRaw } = useSegmentTargetOverrides(selected);
  const segmentTargetOverrides = segmentTargetOverridesRaw ?? {};
  const generate = useGenerateSchedule();
  const publish = usePublishRun();
  const saveEdits = useSaveRunAssignments();
  const unpublish = useUnpublishRun();
  const deleteRun = useDeleteRun();
  const [editing, setEditing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { data: runsRaw } = useScheduleRuns(selected);
  const { data: carryIn } = useCarryIn(selected);
  // A second device, or the phone in the manager's own pocket, stays
  // truthful about the roster while this page is open -- same reasoning as
  // ManagerDashboard's own subscription (not needed for the manager's own
  // edits, since the mutation already invalidates those).
  useRosterRealtime(selected ? [selected] : []);

  const runsData = runsRaw ?? { runs: [], assignments: [] };
  const defaultRun = runsData.runs.find((r) => r.is_published) ?? runsData.runs[0] ?? null;
  const latestRun = runsData.runs.find((r) => r.id === selectedRunId) ?? defaultRun;

  const week = weeks.find((w) => w.week_start === selected) ?? null;
  const morningTarget = (week?.morning_target_slots ?? 2) as MorningTarget;
  const doubleShiftHours = (week?.double_shift_display_hours ?? 12) as DoubleShiftHours;

  if (weeksLoading) {
    return (
      <AppShell title="יצירת סידור">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (!weeks.length) {
    return (
      <AppShell title="יצירת סידור">
        <Card>
          <p className="font-bold text-slate-900 dark:text-slate-100">אין שבועות מוגדרים</p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="יצירת סידור" subtitle={selected ? formatWeekRange(selected) : undefined}>
      <div className="space-y-4">
        <ButtonLink to="/manage" variant="ghost" size="sm">
          → חזרה לניהול
        </ButtonLink>

        <WeekSelectCard
          id="roster-week-select"
          weeks={weeks}
          selected={selected}
          nextStart={nextStart}
          onSelect={(weekStart) => {
            setSelected(weekStart);
            setSelectedRunId(null);
            setEditing(false);
          }}
        />

        {isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-7 text-brand-600" />
          </div>
        ) : error || !data ? (
          <Alert tone="error" title="שגיאה בטעינת הנתונים">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          <>
            <Collapsible
              variant="card"
              title="יצירת סידור"
              summary="המנוע קורא את הזמינות והכמויות ומחזיר סידור יחד עם דוח כיסוי. כל הרצה נשמרת כגרסה חדשה - אפשר לייצר שוב ולהשוות."
              defaultExpanded
            >
              <div className="space-y-3">
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
                  disabled={data.guards.length === 0}
                  onClick={() =>
                    generate.mutate({
                      weekStart: selected,
                      morningTarget,
                      data,
                      morningTargetOverrides,
                      secondaryTargetOverrides: segmentTargetOverrides,
                    })
                  }
                >
                  {generate.isPending ? 'מחשב סידור…' : 'צור סידור אוטומטי'}
                </Button>
              </div>
            </Collapsible>

            {latestRun && (
              <>
                <CoverageReportPanel report={latestRun.coverage_report} guards={data.guards} />

                {editing ? (
                  <RosterEditor
                    weekStart={selected}
                    morningTarget={morningTarget}
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
                    doubleShiftHours={doubleShiftHours}
                    assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                    guards={data.guards}
                    // The referee must judge an edit against exactly what the solver
                    // saw -- including last Saturday's shifts, or a manual Sunday
                    // assignment could create a clopen across the week boundary
                    // that nothing would catch.
                    solverInput={buildSolverInput(
                      selected,
                      morningTarget,
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
                            occupies_slot: d.occupiesSlot,
                          })),
                        },
                        { onSuccess: () => setEditing(false) },
                      )
                    }
                  />
                ) : (
                  <RosterGrid
                    weekStart={selected}
                    morningTarget={morningTarget}
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
                    doubleShiftHours={doubleShiftHours}
                    assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                    guards={data.guards}
                  />
                )}

                {/* Available for any selected version, draft or published --
                    only gated on not-mid-edit, since the on-screen grid it
                    mirrors is itself mid-edit and would be stale to export. */}
                {!editing && (
                  <RosterExport
                    weekStart={selected}
                    morningTarget={morningTarget}
                    morningTargetOverrides={morningTargetOverrides}
                    segmentTargetOverrides={segmentTargetOverrides}
                    doubleShiftHours={doubleShiftHours}
                    assignments={runsData.assignments.filter((a) => a.run_id === latestRun.id)}
                    guards={data.guards}
                  />
                )}

                {/* Same gate as RosterExport just above -- announcing a draft
                    makes no sense, and mid-edit the "published" roster on
                    screen may not match what is actually live. */}
                {latestRun.is_published && !editing && <RosterPublishNotify weekStart={selected} />}

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
