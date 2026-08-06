import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ShiftLegend } from '@/components/ShiftChip';
import {
  WeeklyPreferenceForm,
  type PreferenceFormValue,
} from '@/components/guard/WeeklyPreferenceForm';
import { Alert, Badge, ButtonLink, Card, EmptyState } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  currentSubmissionWeek,
  formatDeadline,
  formatWeekRange,
  isSubmissionOpen,
  submissionDeadline,
  timeUntil,
} from '@/lib/dates';

/** Marks screens whose data layer arrives in a later step, so nothing here
 *  reads as finished work when it is only a shell. */
function ComingUp({ step, children }: { step: string; children: string }) {
  return (
    <Alert tone="info" title={`נבנה בשלב ${step}`}>
      {children}
    </Alert>
  );
}

// ---------------------------------------------------------------------------

export function GuardHome() {
  const { profile } = useAuth();
  const week = currentSubmissionWeek();
  const deadline = submissionDeadline(week);
  const left = timeUntil(deadline);

  return (
    <AppShell title="הסידור שלי" subtitle={formatWeekRange(week)}>
      <div className="space-y-4">
        <Card className="bg-gradient-to-bl from-brand-600 to-brand-800 text-white ring-0">
          <p className="text-sm opacity-80">שלום {profile?.display_name}</p>
          <p className="mt-1 text-2xl font-extrabold">אין עדיין סידור מפורסם</p>
          <p className="mt-2 text-sm opacity-80">
            הסידור לשבוע {formatWeekRange(week)} יפורסם לאחר סגירת ההגשות.
          </p>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-bold text-slate-900">הגשת בקשות</p>
              <p className="mt-1 text-sm text-slate-500">
                {left ? `נותרו ${left} להגשה` : 'ההגשות נסגרו'}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">מועד אחרון: {formatDeadline(deadline)}</p>
            </div>
            <Badge tone={left ? 'green' : 'rose'}>{left ? 'פתוח' : 'נעול'}</Badge>
          </div>
          <ButtonLink to="/preferences" className="mt-4" fullWidth disabled={!left}>
            למילוי הבקשות
          </ButtonLink>
        </Card>

        <ComingUp step="C">
          המשמרת הקרובה, סטטוס ההגשה והסידור האישי יתחברו לנתונים האמיתיים לאחר חיבור Supabase.
        </ComingUp>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

export function Preferences() {
  const week = currentSubmissionWeek();
  const deadline = submissionDeadline(week);
  const [saved, setSaved] = useState<PreferenceFormValue | null>(null);

  return (
    <AppShell title="הגשת בקשות" subtitle={formatWeekRange(week)}>
      <div className="space-y-4">
        <ComingUp step="C">
          הטופס מלא ופעיל, אך עדיין לא נשמר לשרת - החיבור ל-Supabase יושלם בשלב הבא.
        </ComingUp>

        {saved && (
          <Alert tone="success" title="הבקשות נקלטו (מקומית)">
            {saved.slots.size === 0
              ? 'הוגש שבוע ריק.'
              : `${saved.slots.size} משמרות סומנו.`}{' '}
            {saved.canWork12hDay && 'יום 12ש׳ פעיל. '}
            {saved.canWork12hNight && 'לילה 12ש׳ פעיל.'}
          </Alert>
        )}

        <WeeklyPreferenceForm
          weekStart={week}
          deadline={deadline}
          locked={!isSubmissionOpen(week)}
          configuredKamut={3}
          onSubmit={setSaved}
        />
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

export function RosterView() {
  const week = currentSubmissionWeek();
  return (
    <AppShell title="סידור שבועי" subtitle={formatWeekRange(week)}>
      <div className="space-y-4">
        <Card>
          <p className="mb-3 font-bold text-slate-900">מקרא</p>
          <ShiftLegend />
        </Card>
        <Card className="p-0">
          <EmptyState
            icon="🗓️"
            title="טרם פורסם סידור"
            description="לאחר שהמנהל יפרסם את הסידור, הוא יופיע כאן אוטומטית."
          />
        </Card>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

export function ManagerDashboard() {
  const week = currentSubmissionWeek();
  return (
    <AppShell title="ניהול" subtitle={formatWeekRange(week)}>
      <div className="space-y-4">
        <ComingUp step="D">
          לוח הניהול: הגדרות שבוע (יעד בוקר 2 או 3), מטריצת הבקשות, עמודת ה״כמות״ עם תצוגת ההורדה
          האוטומטית, כפתור יצירת הסידור ודוח הכיסוי.
        </ComingUp>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { t: 'הגדרות שבוע', d: 'יעד משמרת בוקר, מועד סגירה' },
            { t: 'בקשות הצוות', d: 'מי הגיש, מי טרם' },
            { t: 'כמות משמרות', d: 'יעד אישי לכל מאבטח' },
            { t: 'יצירת סידור', d: 'הרצת מנוע השיבוץ' },
          ].map((c) => (
            <Card key={c.t} className="opacity-60">
              <p className="font-bold text-slate-900">{c.t}</p>
              <p className="mt-1 text-sm text-slate-500">{c.d}</p>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

export function NotFound() {
  return (
    <AppShell title="לא נמצא">
      <Card className="p-0">
        <EmptyState
          icon="🤷"
          title="הדף לא נמצא"
          description="הקישור שגוי או שהדף הוסר."
          action={
            <ButtonLink to="/" variant="secondary">
              חזרה לדף הבית
            </ButtonLink>
          }
        />
      </Card>
    </AppShell>
  );
}
