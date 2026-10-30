import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CurrentlyOnShiftCard } from '@/components/guard/CurrentlyOnShiftCard';
import { Alert, Badge, Button, ButtonLink, Card, Spinner, cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveWeek } from '@/hooks/useWeeks';
import { useGuardWeek, useVisibleRosters } from '@/hooks/useGuardPortal';
import { useNotifications } from '@/hooks/useNotifications';
import { usePasskey } from '@/hooks/usePasskey';
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
  const { lastChangeAt } = useRosterRealtime((rosters?.weeks ?? []).map((w) => w.weekStart));

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
            בוצע שינוי בסידור זה עתה. המשמרות שלך מעודכנות למטה.
          </Alert>
        )}

        <NotificationPrompt guardId={profile?.id} />
        <PasskeyPrompt guardId={profile?.id} />

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
              ברגע שיפורסם סידור, הוא יופיע כאן אוטומטית.
            </p>
          </Card>
        ) : (
          weeks.map((wk) => {
            const mine = wk.assignments
              .filter((a) => a.guard_id === profile?.id)
              .sort((a, b) => a.target_date.localeCompare(b.target_date));
            // Label from the actual date, not from position in the list. With
            // no roster published for the current week, the first card is NEXT
            // week and calling it "current" would be a lie -- and during the
            // Sunday-morning grace window (useVisibleRosters/
            // guardVisibleWeekFloor), the first card can genuinely be LAST
            // week instead, which needs its own label rather than falling
            // into "future".
            const isCurrent = wk.weekStart === currentStart;
            const isNext = wk.weekStart === addDays(currentStart, 7);
            const label = isCurrent
              ? 'השבוע'
              : isNext
                ? 'שבוע הבא'
                : wk.weekStart < currentStart
                  ? 'שבוע שעבר'
                  : 'שבוע עתידי';

            return (
              <Card
                key={wk.runId}
                className={cn(
                  'text-white ring-0',
                  // Both are gradients rather than flat colours: a gradient sets
                  // background-IMAGE, so it cannot collide with a background-
                  // COLOR utility the way `bg-slate-800` did. The week in
                  // progress leads in brand colour; a future week is quieter so
                  // the eye lands on what is happening now.
                  isCurrent
                    ? 'bg-gradient-to-bl from-brand-600 to-brand-800'
                    : 'bg-gradient-to-bl from-slate-600 to-slate-800',
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

        <CurrentlyOnShiftCard weeks={weeks} guards={rosters?.guards ?? []} />

        {/* ---------------- submissions: a different cycle ---------------- */}
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-slate-900 dark:text-slate-100">הגשת בקשות</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {!active.week
                  ? 'אין כרגע שבוע פתוח להגשה'
                  : left
                    ? `נותרו ${left} להגשה · ${formatWeekRange(active.weekStart)}`
                    : 'ההגשות נסגרו'}
              </p>
              {active.deadline && (
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
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
      </div>
    </AppShell>
  );
}

const NOTIF_PROMPT_DISMISSED_KEY = 'notif-prompt-dismissed';

/**
 * One-time nudge to enable push notifications (spec 12.10) -- shown whenever
 * this device isn't actually subscribed yet, not just while permission is
 * still 'default'. Gating on 'default' alone used to hide this card forever
 * the instant the OS permission prompt was granted, even if the subscribe
 * call or the push_subscriptions upsert that follows it then failed -- a
 * guard could grant permission, hit a silent error, and have no way back to
 * retry (permission never returns to 'default' on its own). 'denied' is
 * still a dead end -- requestPermission() won't even re-prompt -- so that
 * case alone stays hidden. Enable-only otherwise, deliberately: these
 * notifications carry real schedule-affecting updates, so there is no in-app
 * way to turn them back off once granted -- the header's mute/disable toggle
 * was removed for exactly this reason. Dismissing this card just hides it;
 * it doesn't deny permission. GuardHome, not a more general spot, because
 * this is where a guard actually is around deadline time -- the same
 * reasoning §10.4 gives for putting the PWA install nudge where it is.
 */
function NotificationPrompt({ guardId }: { guardId: string | undefined }) {
  const { supported, checked, subscribed, permission, busy, error, enable } =
    useNotifications(guardId);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(NOTIF_PROMPT_DISMISSED_KEY) === '1',
  );

  if (!supported || !checked || subscribed || dismissed || permission === 'denied') return null;

  const dismiss = () => {
    localStorage.setItem(NOTIF_PROMPT_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Card className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-bold text-slate-900 dark:text-slate-100">קבלת תזכורות</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          הפעל התראות כדי לקבל תזכורת לפני סגירת ההגשה לשבוע.
        </p>
        {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={busy} onClick={enable}>
            הפעלת התראות
          </Button>
          <Button size="sm" variant="secondary" onClick={dismiss}>
            לא עכשיו
          </Button>
        </div>
      </div>
    </Card>
  );
}

const PASSKEY_PROMPT_DISMISSED_KEY = 'passkey-prompt-dismissed';

/**
 * Passive nudge to set up Face ID/fingerprint login, same pattern as
 * NotificationPrompt above: shown only while the device supports it AND this
 * guard has no passkey registered on it yet. Dismissing it hides the card for
 * good. The main setup path is now the Login page's hybrid passkey button,
 * which triggers registration directly and immediately after a fresh login
 * (see Login.tsx) rather than routing through here -- this card is what's
 * left for a guard who logs in normally without ever touching that button.
 */
function PasskeyPrompt({ guardId }: { guardId: string | undefined }) {
  const { supported, hasPasskey, busy, error, register } = usePasskey(guardId);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(PASSKEY_PROMPT_DISMISSED_KEY) === '1',
  );

  if (!supported || hasPasskey || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(PASSKEY_PROMPT_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Card className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-bold text-slate-900 dark:text-slate-100">כניסה מהירה יותר</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          הפעל כניסה עם Face ID או טביעת אצבע במקום קוד עובד וסיסמה בפעם הבאה.
        </p>
        {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={busy} onClick={register}>
            הפעלה
          </Button>
          <Button size="sm" variant="secondary" onClick={dismiss}>
            לא עכשיו
          </Button>
        </div>
      </div>
    </Card>
  );
}
