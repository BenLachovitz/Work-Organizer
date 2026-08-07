import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, ButtonLink, Card, Spinner, cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveWeek } from '@/hooks/useWeeks';
import { useGuardWeek, useVisibleRosters } from '@/hooks/useGuardPortal';
import { useRosterRealtime } from '@/hooks/useRosterRealtime';
import {
  HEBREW_DAYS,
  addDays,
  dayIndex,
  formatDayMonth,
  formatDeadline,
  formatWeekRange,
  timeUntil,
  todayInIsrael,
  weekStartOf,
} from '@/lib/dates';
import { SHIFTS } from '@/lib/shifts';

/**
 * Two independent cycles share this page, and they must not be confused:
 *
 *   ROSTERS      what I am working. Rolls over on Sunday. Comes from
 *                useVisibleRosters(), which asks RLS rather than guessing.
 *   SUBMISSIONS  which week I am filling in. Opens Saturday 20:00, closes
 *                Wednesday 19:00. Comes from useActiveWeek().
 *
 * They are usually different weeks. An earlier version derived the roster from
 * the submission week, so a published roster went unseen whenever no submission
 * window happened to be open.
 */
export function GuardHome() {
  const { profile } = useAuth();
  const { data: active, isLoading: weekLoading } = useActiveWeek();
  const { data: guardWeek, isLoading: dataLoading } = useGuardWeek(active.weekStart);
  const { data: rosters, isLoading: rostersLoading } = useVisibleRosters();
  const { lastChangeAt } = useRosterRealtime(weekStartOf(todayInIsrael()));

  if (weekLoading || dataLoading) {
    return (
      <AppShell title="הסידור שלי">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  const left = active.deadline ? timeUntil(active.deadline) : null;
  const submitted = guardWeek?.hasSubmitted ?? false;
  const slotCount = guardWeek?.preferences.length ?? 0;
  const currentStart = weekStartOf(todayInIsrael());

  // Oldest first: the week in progress on top, the one after it below.
  const weeks = rosters?.weeks ?? [];

  return (
    <AppShell title="הסידור שלי" subtitle={profile?.display_name}>
      <div className="space-y-4">
        {lastChangeAt && (
          <Alert tone="info" title="הסידור עודכן">
            המנהל שינה את הסידור זה עתה. המשמרות שלך מעודכנות למטה.
          </Alert>
        )}

        {/* ---------------- my shifts, one card per published week ---------------- */}
        {rostersLoading ? (
          <Card>
            <Spinner className="size-6 text-brand-600" />
          </Card>
        ) : weeks.length === 0 ? (
          <Card className="bg-gradient-to-bl from-brand-600 to-brand-800 text-white ring-0">
            <p className="text-sm opacity-80">שלום {profile?.display_name}</p>
            <p className="mt-1 text-2xl font-extrabold">אין עדיין סידור מפורסם</p>
            <p className="mt-2 text-sm opacity-80">
              ברגע שהמנהל יפרסם סידור, הוא יופיע כאן אוטומטית.
            </p>
          </Card>
        ) : (
          weeks.map((wk) => {
            const mine = wk.assignments
              .filter((a) => a.guard_id === profile?.id)
              .sort((a, b) => a.target_date.localeCompare(b.target_date));
            // Label from the actual date, not from position in the list. With
            // no roster published for the current week, the first card is NEXT
            // week and calling it "current" would be a lie.
            const isCurrent = wk.weekStart === currentStart;
            const isNext = wk.weekStart === addDays(currentStart, 7);
            const label = isCurrent ? 'השבוע' : isNext ? 'שבוע הבא' : 'שבוע עתידי';

            return (
              <Card
                key={wk.runId}
                className={cn(
                  'ring-0',
                  // The week in progress leads; a future week is visibly quieter
                  // so the eye lands on what is happening now.
                  isCurrent
                    ? 'bg-gradient-to-bl from-brand-600 to-brand-800 text-white'
                    : 'bg-slate-800 text-white',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm opacity-80">{label}</p>
                  <p className="text-xs opacity-70">{formatWeekRange(wk.weekStart)}</p>
                </div>

                {mine.length === 0 ? (
                  <p className="mt-2 text-lg font-bold">אין לך משמרות בשבוע זה</p>
                ) : (
                  <>
                    <p className="mt-1 text-2xl font-extrabold">{mine.length} משמרות</p>
                    <div className="mt-3 space-y-2">
                      {mine.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center justify-between rounded-xl bg-white/10 px-3 py-2"
                        >
                          <div>
                            <p className="text-sm font-bold">
                              יום {HEBREW_DAYS[dayIndex(a.target_date)]}
                            </p>
                            <p className="text-xs opacity-75">{formatDayMonth(a.target_date)}</p>
                          </div>
                          <div className="text-end">
                            <p className="text-sm font-bold">{SHIFTS[a.shift].he}</p>
                            <p className="num text-xs opacity-75">{SHIFTS[a.shift].label}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Card>
            );
          })
        )}

        {/* ---------------- submissions: a different cycle ---------------- */}
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-slate-900">הגשת בקשות</p>
              <p className="mt-1 text-sm text-slate-500">
                {!active.week
                  ? 'אין כרגע שבוע פתוח להגשה'
                  : left
                    ? `נותרו ${left} להגשה · ${formatWeekRange(active.weekStart)}`
                    : 'ההגשות נסגרו'}
              </p>
              {active.deadline && (
                <p className="mt-0.5 text-xs text-slate-400">
                  מועד אחרון: {formatDeadline(active.deadline)}
                </p>
              )}
            </div>
            <Badge tone={active.isOpen ? 'green' : 'rose'}>
              {active.isOpen ? 'פתוח' : 'נעול'}
            </Badge>
          </div>

          {submitted ? (
            <Alert tone="success">
              {slotCount === 0
                ? 'הגשת שבוע ריק - לא תשובץ למשמרות.'
                : `הגשת ${slotCount} משמרות זמינות.`}
            </Alert>
          ) : (
            active.isOpen && (
              <Alert tone="warn" title="טרם הגשת">
                חשוב להגיש לפני מועד הסגירה, אחרת לא תשובץ לשבוע זה.
              </Alert>
            )
          )}

          <ButtonLink
            to="/preferences"
            className="mt-4"
            fullWidth
            disabled={!active.isOpen}
            variant={submitted ? 'secondary' : 'primary'}
          >
            {submitted ? 'עריכת הבקשות' : 'למילוי הבקשות'}
          </ButtonLink>
        </Card>

        {/* ---------------- weekly target ---------------- */}
        {guardWeek?.target && (
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-slate-900">כמות משמרות שהוגדרה לך</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {formatWeekRange(active.weekStart)} · נקבע על ידי המנהל
                </p>
              </div>
              <span className="text-3xl font-extrabold text-brand-600">
                {guardWeek.target.configured_kamut}
              </span>
            </div>
            {guardWeek.target.effective_kamut !== null &&
              guardWeek.target.effective_kamut < guardWeek.target.configured_kamut && (
                <Alert tone="warn" title="היעד הותאם">
                  לפי הזמינות שהגשת, היעד בפועל לשבוע זה הוא{' '}
                  <strong>{guardWeek.target.effective_kamut}</strong>.
                </Alert>
              )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
