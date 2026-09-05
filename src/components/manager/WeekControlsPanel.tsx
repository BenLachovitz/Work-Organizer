import { useState } from 'react';
import { Badge, Button, Card, cn } from '@/components/ui';
import { formatDeadline, formatWeekRange, timeUntil } from '@/lib/dates';
import type { RosterWeek } from '@/types/database';

/**
 * Core weekly workflow only: which week is selected, its submission status,
 * and the lock/reopen control -- the pieces a manager needs visible every
 * single week without an extra click. This week's coverage-target exceptions
 * (morning target, per-day overrides, double-shift display hours) live in
 * the separate, collapsed-by-default WeekExceptionsPanel right below this
 * one -- split out so this panel stays a quick glance, not a scroll.
 */
export function WeekControlsPanel({
  weeks,
  archive,
  selected,
  onSelect,
  week,
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
  onSetStatus: (s: RosterWeek['status']) => void;
  saving: boolean;
}) {
  const [showArchive, setShowArchive] = useState(false);
  const deadline = week ? new Date(week.submission_deadline) : null;
  const left = deadline ? timeUntil(deadline) : null;

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
