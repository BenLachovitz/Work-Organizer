import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { GuardPreferenceDetail } from '@/components/manager/GuardPreferenceDetail';
import { GuardPreferenceEditor } from '@/components/manager/GuardPreferenceEditor';
import { Alert, Badge, Button, ButtonLink, Card, Spinner } from '@/components/ui';
import { useSplitWeeks } from '@/hooks/useWeeks';
import {
  useManagerDeleteSubmission,
  useManagerSavePreferences,
  useManagerWeek,
} from '@/hooks/useManager';
import { formatWeekRange } from '@/lib/dates';
import type { WishPreference } from '@/types/database';
import { useViewMode } from '@/contexts/ViewModeContext';
import { visibleToViewMode } from '@/lib/viewMode';

const STATE_BADGE = {
  filled: { tone: 'green' as const, label: 'הגיש' },
  empty: { tone: 'amber' as const, label: 'הגיש ריק' },
  none: { tone: 'rose' as const, label: 'טרם הגיש' },
};

/**
 * The detail TeamTable never shows: exactly which day/shift each guard
 * marked, not just aggregate counts (§ available days, slot count, עדיפות
 * count). Reached from ManagerDashboard with the week it was already looking
 * at carried over via ?week=, so the manager doesn't have to re-pick it.
 *
 * Per guard, two modes: a compact read-only breakdown (GuardPreferenceDetail)
 * by default, swapped for GuardPreferenceEditor -- a minimal click-to-toggle
 * grid, deliberately not the guard-facing WeeklyPreferenceForm -- when
 * "עריכה" is clicked. Cancelling a submission outright is a separate, small
 * action in the card header rather than living inside the editor, since it
 * is a distinct action from correcting availability. Saves/deletes go
 * through the manager-keyed RPCs (migration 32), not the guard-keyed ones
 * the guard's own /preferences page uses.
 */
export function ManagerPreferences() {
  const [searchParams] = useSearchParams();
  const { live, archive, nextStart, isLoading: weeksLoading } = useSplitWeeks();
  const weeks = [...live, ...archive];

  const [selected, setSelected] = useState(searchParams.get('week') ?? '');
  useEffect(() => {
    if (selected || !live.length) return;
    const fromQuery = searchParams.get('week');
    const next = live.find((w) => w.week_start === nextStart);
    setSelected(fromQuery || next?.week_start || live[0]!.week_start);
    // Only ever bootstraps the initial selection -- searchParams is
    // intentionally excluded so switching weeks via the dropdown below
    // doesn't get overridden by a stale query string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, selected, nextStart]);

  const { data, isLoading, error } = useManagerWeek(selected);
  const { viewMode } = useViewMode();
  const save = useManagerSavePreferences();
  const del = useManagerDeleteSubmission();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const prefsByGuard = useMemo(() => {
    const map = new Map<string, WishPreference[]>();
    for (const p of data?.preferences ?? []) {
      const list = map.get(p.guard_id) ?? [];
      list.push(p);
      map.set(p.guard_id, list);
    }
    return map;
  }, [data]);
  const subByGuard = useMemo(
    () => new Map((data?.submissions ?? []).map((s) => [s.guard_id, s])),
    [data],
  );
  const targetByGuard = useMemo(
    () => new Map((data?.targets ?? []).map((t) => [t.guard_id, t])),
    [data],
  );

  if (weeksLoading) {
    return (
      <AppShell title="העדפות הצוות">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (!weeks.length) {
    return (
      <AppShell title="העדפות הצוות">
        <Card>
          <p className="font-bold text-slate-900 dark:text-slate-100">אין שבועות מוגדרים</p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="העדפות הצוות" subtitle={selected ? formatWeekRange(selected) : undefined}>
      <div className="space-y-4">
        <ButtonLink to="/manage" variant="ghost" size="sm">
          → חזרה לניהול
        </ButtonLink>

        <Card className="flex items-center gap-3">
          <label
            htmlFor="pref-week-select"
            className="shrink-0 text-sm font-bold text-slate-700 dark:text-slate-300"
          >
            שבוע
          </label>
          <select
            id="pref-week-select"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setEditingId(null);
              setConfirmDeleteId(null);
            }}
            className="w-full min-w-0 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {weeks.map((w) => (
              <option key={w.week_start} value={w.week_start}>
                {formatWeekRange(w.week_start)}
                {w.week_start === nextStart ? ' (הבא)' : ''}
              </option>
            ))}
          </select>
        </Card>

        {(save.isError || del.isError) && (
          <Alert tone="error" title="הפעולה נכשלה">
            {[save.error, del.error]
              .filter((e): e is Error => e instanceof Error)
              .map((e) => e.message)
              .join(' · ') || 'נסה שוב.'}
          </Alert>
        )}

        {isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-7 text-brand-600" />
          </div>
        ) : error ? (
          <Alert tone="error" title="שגיאה בטעינת הנתונים">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          <div className="space-y-3">
            {(data?.guards ?? [])
              .filter((guard) => visibleToViewMode(guard, viewMode))
              .map((guard) => {
              const prefs = prefsByGuard.get(guard.id) ?? [];
              const sub = subByGuard.get(guard.id);
              const configuredKamut = targetByGuard.get(guard.id)?.configured_kamut ?? 0;
              const state = !sub ? 'none' : prefs.length === 0 ? 'empty' : 'filled';
              const badge = STATE_BADGE[state];
              const isEditing = editingId === guard.id;
              const confirmingDelete = confirmDeleteId === guard.id;

              return (
                <Card key={guard.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-bold text-slate-900 dark:text-slate-100">
                        {guard.display_name}
                      </span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {sub && !isEditing && (
                        <Button
                          size="sm"
                          variant={confirmingDelete ? 'danger' : 'ghost'}
                          loading={confirmingDelete && del.isPending}
                          onClick={() =>
                            confirmingDelete
                              ? del.mutate(
                                  { weekStart: selected, guardId: guard.id },
                                  { onSuccess: () => setConfirmDeleteId(null) },
                                )
                              : setConfirmDeleteId(guard.id)
                          }
                        >
                          {confirmingDelete ? 'לחץ שוב לביטול' : 'ביטול הגשה'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={isEditing ? 'secondary' : 'ghost'}
                        onClick={() => {
                          setEditingId(isEditing ? null : guard.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        {isEditing ? 'סגירה' : 'עריכה'}
                      </Button>
                    </div>
                  </div>

                  {isEditing ? (
                    <GuardPreferenceEditor
                      key={`${guard.id}:${selected}:${sub?.updated_at ?? 'new'}`}
                      weekStart={selected}
                      initialPreferences={prefs}
                      configuredKamut={configuredKamut}
                      initialRequestedShifts={sub?.requested_shifts ?? null}
                      saving={save.isPending}
                      onSave={(slots, requestedShifts) =>
                        save.mutate(
                          // Notes aren't editable from this quick editor -- pass
                          // the guard's existing note through unchanged, since
                          // the save RPC always overwrites the column (it can't
                          // tell "no change" from "clear it").
                          {
                            weekStart: selected,
                            guardId: guard.id,
                            slots,
                            notes: sub?.notes ?? '',
                            requestedShifts,
                          },
                          { onSuccess: () => setEditingId(null) },
                        )
                      }
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <GuardPreferenceDetail
                      weekStart={selected}
                      preferences={prefs}
                      notes={sub?.notes ?? null}
                      requestedShifts={sub?.requested_shifts ?? null}
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
