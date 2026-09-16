import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Collapsible, cn } from '@/components/ui';
import { formatDayMonth, type DateKey } from '@/lib/dates';
import { getYomKippurWeekInfo } from '@/lib/holidays';
import { requiredBases } from '@/lib/shifts';
import { useSetKippurGuards, type ManagerWeekData } from '@/hooks/useManager';
import type { RosterWeek } from '@/types/database';

const GUARD_COUNTS = [2, 3] as const;

/** Does this guard's submitted availability already cover everything one
 *  half of the Kippur block needs on `date`? */
function isEligibleFor(
  guardId: string,
  preferences: ManagerWeekData['preferences'],
  date: DateKey,
  shift: 'kippur_day1' | 'kippur_day2',
): boolean {
  const marked = new Set(
    preferences
      .filter((p) => p.guard_id === guardId && p.target_date === date)
      .map((p) => p.shift),
  );
  return requiredBases(shift).every((b) => marked.has(b));
}

/**
 * Guard-picker for this week's Yom Kippur special-coverage block (migration
 * 55, src/lib/holidays.ts) -- only rendered once the standing feature switch
 * is on (ManagerSettings' KippurHandlingSettings) AND the currently selected
 * week actually contains Yom Kippur eve + day, the same "the system figures
 * out which week" contract the feature was asked for.
 *
 * Deliberately a manager PICK, not a solver decision: generation
 * (useGenerateSchedule.ts) reads whichever guards are saved here and folds
 * them into every generated draft automatically from then on, so this only
 * needs setting once per year, before the week is first generated.
 */
export function KippurPanel({
  weekStart,
  week,
  data,
  onSetGuardCount,
  saving,
}: {
  weekStart: DateKey;
  week: RosterWeek | null;
  data: ManagerWeekData;
  onSetGuardCount: (count: 2 | 3 | null) => void;
  saving: boolean;
}) {
  const kippurInfo = getYomKippurWeekInfo(weekStart);
  const setGuards = useSetKippurGuards();
  const guardCount = (week?.kippur_guard_count ?? null) as 2 | 3 | null;

  const [selection, setSelection] = useState<string[]>(data.kippurGuardIds);
  // Re-sync from the server whenever the underlying saved list actually
  // changes (a real save, or switching weeks) -- but not on every render,
  // which would stomp an in-progress, unsaved pick.
  useEffect(() => {
    setSelection(data.kippurGuardIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, data.kippurGuardIds.join(',')]);

  if (!kippurInfo) return null;

  const slots = guardCount ?? 0;
  const activeGuards = data.guards;

  const eligible = (guardId: string) =>
    isEligibleFor(guardId, data.preferences, kippurInfo.erevDate, 'kippur_day1') &&
    isEligibleFor(guardId, data.preferences, kippurInfo.dayDate, 'kippur_day2');

  const filled = selection.filter(Boolean);
  const distinct = new Set(filled).size === filled.length;
  const complete = slots > 0 && filled.length === slots && distinct;
  const allEligible = complete && filled.every(eligible);
  const dirty = JSON.stringify([...filled].sort()) !== JSON.stringify([...data.kippurGuardIds].sort());

  const save = () => {
    if (!allEligible) return;
    setGuards.mutate({ weekStart, guardIds: filled });
  };

  return (
    <Collapsible
      variant="card"
      title="יום כיפור"
      summary={
        guardCount
          ? `${guardCount} מאבטחים · ${formatDayMonth(kippurInfo.erevDate)}-${formatDayMonth(kippurInfo.dayDate)}`
          : 'לא הוגדר'
      }
      defaultExpanded={!guardCount}
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          השבוע הזה כולל את ערב יום כיפור ({formatDayMonth(kippurInfo.erevDate)}) ואת יום כיפור עצמו
          ({formatDayMonth(kippurInfo.dayDate)}). המאבטחים שייבחרו כאן ישובצו אוטומטית לרצף המלא --
          מהצהריים המוקדם של ערב החג ועד סוף אחה"צ של יום כיפור, ללא משמרת הלילה -- בכל יצירת סידור
          לשבוע זה, ויתפסו 2 משמרות מהמכסה השבועית שלהם.
        </p>

        <div>
          <p className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-300">מספר מאבטחים</p>
          <div className="grid grid-cols-2 gap-2">
            {GUARD_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={saving}
                onClick={() => onSetGuardCount(guardCount === n ? null : n)}
                className={cn(
                  'rounded-xl border-2 px-3 py-2.5 text-center transition-all disabled:opacity-50',
                  guardCount === n
                    ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50'
                    : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                )}
              >
                <span className="block text-lg font-extrabold text-slate-900 dark:text-slate-100">
                  {n}
                </span>
              </button>
            ))}
          </div>
        </div>

        {slots > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-bold text-slate-700 dark:text-slate-300">מאבטחים</p>
            {Array.from({ length: slots }, (_, i) => {
              const guardId = selection[i] ?? '';
              const dup = guardId && filled.filter((g) => g === guardId).length > 1;
              return (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={guardId}
                    onChange={(e) => {
                      const next = [...selection];
                      next[i] = e.target.value;
                      setSelection(next);
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="">בחר מאבטח…</option>
                    {activeGuards.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.display_name}
                      </option>
                    ))}
                  </select>
                  {guardId && !dup && (
                    <Badge tone={eligible(guardId) ? 'green' : 'rose'}>
                      {eligible(guardId) ? 'הגיש זמינות מלאה' : 'חסרה זמינות'}
                    </Badge>
                  )}
                  {dup && <Badge tone="amber">כפול</Badge>}
                </div>
              );
            })}
            {!allEligible && complete && (
              <Alert tone="error">
                יש לוודא שכל המאבטח שנבחר הגיש זמינות ל
                {requiredBases('kippur_day1').join('+')} בערב החג ול
                {requiredBases('kippur_day2').join('+')} ביום החג עצמו לפני השמירה.
              </Alert>
            )}
          </div>
        )}

        {setGuards.isError && (
          <Alert tone="error">
            {setGuards.error instanceof Error ? setGuards.error.message : 'השמירה נכשלה.'}
          </Alert>
        )}

        {slots > 0 && (
          <Button
            fullWidth
            size="sm"
            disabled={!dirty || !allEligible}
            loading={setGuards.isPending}
            onClick={save}
          >
            שמירה
          </Button>
        )}
      </div>
    </Collapsible>
  );
}
