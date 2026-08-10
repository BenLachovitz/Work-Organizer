import { useState } from 'react';
import { Badge, Button, Card, cn } from '@/components/ui';
import { HEBREW_DAYS, formatDeadline, formatWeekRange, timeUntil } from '@/lib/dates';
import {
  morningTargetForDay,
  segmentFloors,
  type MorningTarget,
  type MorningTargetOverrides,
} from '@/lib/shifts';
import type { RosterWeek } from '@/types/database';

/** Mon-Fri only -- the weekend always runs 2 in the morning regardless of
 *  the week setting or any override (§1). */
const OVERRIDABLE_DAYS = [1, 2, 3, 4, 5] as const;

export function WeekControlsPanel({
  weeks,
  archive,
  selected,
  onSelect,
  week,
  onSetMorningTarget,
  morningTargetOverrides,
  onSetDayOverride,
  onSetStatus,
  saving,
}: {
  /** Live weeks: the current one and anything after it. */
  weeks: RosterWeek[];
  /** Finished weeks. RLS makes these manager-only. */
  archive: RosterWeek[];
  selected: string;
  onSelect: (weekStart: string) => void;
  week: RosterWeek | null;
  onSetMorningTarget: (t: MorningTarget) => void;
  /** Per-day exceptions to the week's own morning target, for THIS week only
   *  (§1) -- e.g. a holiday week needing Mon-Wed at 2 but Thu-Fri at 3. */
  morningTargetOverrides: MorningTargetOverrides;
  onSetDayOverride: (dayIndex: number, target: MorningTarget) => void;
  onSetStatus: (s: RosterWeek['status']) => void;
  saving: boolean;
}) {
  const [showArchive, setShowArchive] = useState(false);
  const [showPerDay, setShowPerDay] = useState(false);
  const deadline = week ? new Date(week.submission_deadline) : null;
  const left = deadline ? timeUntil(deadline) : null;
  const target = (week?.morning_target_slots ?? 2) as MorningTarget;
  // Day index 1 (Monday) stands for a working day; the setting only ever
  // differs between Mon-Fri and the weekend.
  const workingFloor = segmentFloors(target, 1).S1;

  return (
    <Card className="space-y-4">
      {/* ---------------- week picker ---------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
            {showArchive ? 'שבועות אחרים' : 'שבועות פעילים'}
            {!showArchive && (
              <span className="font-normal text-slate-400 dark:text-slate-500"> · נוכחי והבא</span>
            )}
          </p>
          {archive.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchive((v) => !v)}
              className="text-xs font-semibold text-brand-600 hover:text-brand-700"
            >
              {showArchive ? '← חזרה לפעילים' : `שבועות אחרים (${archive.length}) →`}
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {(showArchive ? archive : weeks).map((w) => (
            <button
              key={w.week_start}
              type="button"
              onClick={() => onSelect(w.week_start)}
              className={cn(
                'shrink-0 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
                w.week_start === selected
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
              )}
            >
              {formatWeekRange(w.week_start)}
            </button>
          ))}
          {showArchive && archive.length === 0 && (
            <p className="py-2 text-sm text-slate-400 dark:text-slate-500">
              אין עדיין שבועות שהסתיימו
            </p>
          )}
        </div>

        {showArchive && (
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            שבועות שאינם הנוכחי או הבא. שבועות שהסתיימו גלויים לך בלבד - מאבטחים אינם רואים אותם
            כלל.
          </p>
        )}
      </div>

      {week && (
        <>
          {/* ---------------- status ---------------- */}
          <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800">
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                {left ? `נותרו ${left} להגשה` : 'חלון ההגשה סגור'}
              </p>
              {deadline && (
                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                  {formatDeadline(deadline)}
                </p>
              )}
            </div>
            <Badge tone={week.status === 'open' ? 'green' : 'slate'}>
              {week.status === 'open'
                ? 'פתוח'
                : week.status === 'locked'
                  ? 'נעול'
                  : week.status === 'generated'
                    ? 'נוצר סידור'
                    : 'פורסם'}
            </Badge>
          </div>

          {/* ---------------- morning capacity ---------------- */}
          <div>
            <p className="mb-1 text-sm font-bold text-slate-700 dark:text-slate-300">
              יעד משמרת בוקר{' '}
              <span className="font-normal text-slate-400 dark:text-slate-500">
                · ימי שני-שישי
              </span>
            </p>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              מספר המאבטחים הרצוי במשמרת הבוקר בימי העבודה. הרצפה נגזרת אוטומטית.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {([2, 3] as MorningTarget[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={saving}
                  onClick={() => onSetMorningTarget(t)}
                  className={cn(
                    'rounded-xl border-2 px-3 py-2.5 text-center transition-all disabled:opacity-50',
                    target === t
                      ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50'
                      : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                  )}
                >
                  <span className="block text-lg font-extrabold text-slate-900 dark:text-slate-100">
                    {t}
                  </span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    רצפה {segmentFloors(t, 1).S1}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              ימי שני-שישי: יעד {target}, לפחות {workingFloor} מאבטחים במשמרת.
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              שבת וראשון הם ימי מנוחה - יעד הבוקר בהם תמיד 2, גם כשנבחר 3.
            </p>
          </div>

          {/* ---------------- per-day override ---------------- */}
          <div>
            <button
              type="button"
              onClick={() => setShowPerDay((v) => !v)}
              className="flex w-full items-center justify-between text-start"
            >
              <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                החרגה ליום ספציפי
                {Object.keys(morningTargetOverrides).length > 0 && (
                  <span className="ms-1.5 font-normal text-brand-600 dark:text-brand-400">
                    ({Object.keys(morningTargetOverrides).length} ימים הוחרגו)
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'text-slate-400 transition-transform dark:text-slate-500',
                  showPerDay && 'rotate-180',
                )}
              >
                ▾
              </span>
            </button>

            {showPerDay && (
              <div className="mt-2 space-y-1.5">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  לשבוע חריג (למשל חג) אפשר לקבוע יעד שונה מהיעד הרגיל של השבוע ליום ספציפי. יום
                  שלא הוחרג ימשיך אחרי היעד הרגיל למעלה, גם אם הוא ישתנה בהמשך.
                </p>
                {OVERRIDABLE_DAYS.map((dayIndex) => {
                  const effective = morningTargetForDay(target, dayIndex, morningTargetOverrides);
                  const isOverridden = morningTargetOverrides[String(dayIndex)] != null;
                  return (
                    <div
                      key={dayIndex}
                      className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800"
                    >
                      <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                        יום {HEBREW_DAYS[dayIndex]}
                        {isOverridden && (
                          <span className="ms-1.5 text-[10px] font-bold text-brand-600 dark:text-brand-400">
                            הוחרג
                          </span>
                        )}
                      </span>
                      <div className="flex gap-1.5">
                        {([2, 3] as MorningTarget[]).map((t) => (
                          <button
                            key={t}
                            type="button"
                            disabled={saving}
                            onClick={() => onSetDayOverride(dayIndex, t)}
                            className={cn(
                              'rounded-lg border-2 px-2.5 py-1 text-sm font-bold transition-all disabled:opacity-50',
                              effective === t
                                ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600',
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ---------------- lock control ---------------- */}
          <div className="flex gap-2">
            {week.status === 'open' ? (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                loading={saving}
                onClick={() => onSetStatus('locked')}
              >
                נעל הגשות עכשיו
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                loading={saving}
                onClick={() => onSetStatus('open')}
              >
                פתח הגשות מחדש
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            נעילה חוסמת עריכה של מאבטחים ברמת מסד הנתונים, לא רק בממשק.
            {week.status !== 'open' && new Date(week.submission_deadline) <= new Date() && (
              <> פתיחה מחדש תאריך את מועד הסגירה ב-24 שעות מעכשיו.</>
            )}
          </p>
        </>
      )}
    </Card>
  );
}
