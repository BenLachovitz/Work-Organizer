import { AppShell } from '@/components/layout/AppShell';
import { ShiftChip } from '@/components/ShiftChip';
import { Alert, Badge, ButtonLink, Card, Spinner } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveWeek } from '@/hooks/useWeeks';
import { useGuardWeek, useMySchedule } from '@/hooks/useGuardPortal';
import {
  HEBREW_DAYS,
  dayIndex,
  formatDayMonth,
  formatDeadline,
  formatWeekRange,
  timeUntil,
} from '@/lib/dates';
import { SHIFTS } from '@/lib/shifts';

export function GuardHome() {
  const { profile } = useAuth();
  const { data: active, isLoading: weekLoading } = useActiveWeek();
  const { data: guardWeek, isLoading: dataLoading } = useGuardWeek(active.weekStart);
  const { data: assignments, isLoading: schedLoading } = useMySchedule(active.weekStart);

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
  const published = assignments ?? [];

  return (
    <AppShell title="הסידור שלי" subtitle={formatWeekRange(active.weekStart)}>
      <div className="space-y-4">
        {/* ---------------- my published shifts ---------------- */}
        <Card className="bg-gradient-to-bl from-brand-600 to-brand-800 text-white ring-0">
          <p className="text-sm opacity-80">שלום {profile?.display_name}</p>
          {schedLoading ? (
            <div className="py-3">
              <Spinner className="size-6" />
            </div>
          ) : published.length > 0 ? (
            <>
              <p className="mt-1 text-2xl font-extrabold">
                {published.length} משמרות השבוע
              </p>
              <div className="mt-3 space-y-2">
                {published.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-xl bg-white/10 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-bold">יום {HEBREW_DAYS[dayIndex(a.target_date)]}</p>
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
          ) : (
            <>
              <p className="mt-1 text-2xl font-extrabold">אין עדיין סידור מפורסם</p>
              <p className="mt-2 text-sm opacity-80">
                הסידור לשבוע {formatWeekRange(active.weekStart)} יפורסם לאחר סגירת ההגשות.
              </p>
            </>
          )}
        </Card>

        {/* ---------------- submission status ---------------- */}
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-slate-900">הגשת בקשות</p>
              <p className="mt-1 text-sm text-slate-500">
                {!active.week
                  ? 'אין כרגע שבוע פתוח להגשה'
                  : left
                    ? `נותרו ${left} להגשה`
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
                <p className="mt-0.5 text-sm text-slate-500">נקבע על ידי המנהל</p>
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

        {published.length > 0 && (
          <Card>
            <p className="mb-3 font-bold text-slate-900">סוגי המשמרות שלך</p>
            <div className="flex flex-wrap gap-2">
              {[...new Set(published.map((a) => a.shift))].map((s) => (
                <ShiftChip key={s} shift={s} size="sm" />
              ))}
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
