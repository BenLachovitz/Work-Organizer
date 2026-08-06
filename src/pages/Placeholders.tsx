import { AppShell } from '@/components/layout/AppShell';
import { ShiftLegend } from '@/components/ShiftChip';
import { Alert, ButtonLink, Card, EmptyState } from '@/components/ui';
import { useActiveWeek } from '@/hooks/useWeeks';
import { formatWeekRange } from '@/lib/dates';

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

export function RosterView() {
  const { data: active } = useActiveWeek();
  return (
    <AppShell title="סידור שבועי" subtitle={formatWeekRange(active.weekStart)}>
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
  const { data: active } = useActiveWeek();
  return (
    <AppShell title="ניהול" subtitle={formatWeekRange(active.weekStart)}>
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
