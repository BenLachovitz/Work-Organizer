import { Badge, Button, Card, cn } from '@/components/ui';
import { formatDeadline, formatWeekRange, timeUntil } from '@/lib/dates';
import { segmentFloors, type MorningTarget } from '@/lib/shifts';
import type { RosterWeek } from '@/types/database';

export function WeekControlsPanel({
  weeks,
  selected,
  onSelect,
  week,
  onSetMorningTarget,
  onSetStatus,
  saving,
}: {
  weeks: RosterWeek[];
  selected: string;
  onSelect: (weekStart: string) => void;
  week: RosterWeek | null;
  onSetMorningTarget: (t: MorningTarget) => void;
  onSetStatus: (s: RosterWeek['status']) => void;
  saving: boolean;
}) {
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
        <p className="mb-2 text-sm font-bold text-slate-700">שבוע</p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {weeks.map((w) => (
            <button
              key={w.week_start}
              type="button"
              onClick={() => onSelect(w.week_start)}
              className={cn(
                'shrink-0 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
                w.week_start === selected
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
              )}
            >
              {formatWeekRange(w.week_start)}
            </button>
          ))}
        </div>
      </div>

      {week && (
        <>
          {/* ---------------- status ---------------- */}
          <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800">
                {left ? `נותרו ${left} להגשה` : 'חלון ההגשה סגור'}
              </p>
              {deadline && (
                <p className="mt-0.5 truncate text-xs text-slate-500">
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
            <p className="mb-1 text-sm font-bold text-slate-700">
              יעד משמרת בוקר <span className="font-normal text-slate-400">· ימי שני-שישי</span>
            </p>
            <p className="mb-2 text-xs text-slate-500">
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
                      ? 'border-brand-600 bg-brand-50'
                      : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <span className="block text-lg font-extrabold text-slate-900">{t}</span>
                  <span className="block text-[11px] text-slate-500">
                    רצפה {segmentFloors(t, 1).S1}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              ימי שני-שישי: יעד {target}, לפחות {workingFloor} מאבטחים במשמרת.
            </p>
            <p className="mt-1 text-xs text-amber-700">
              שבת וראשון הם ימי מנוחה - יעד הבוקר בהם תמיד 2, גם כשנבחר 3.
            </p>
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
          <p className="text-xs text-slate-400">
            נעילה חוסמת עריכה של מאבטחים ברמת מסד הנתונים, לא רק בממשק.
          </p>
        </>
      )}
    </Card>
  );
}
