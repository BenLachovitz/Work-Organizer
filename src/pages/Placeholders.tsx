import { AppShell } from '@/components/layout/AppShell';
import { ShiftLegend } from '@/components/ShiftChip';
import { ButtonLink, Card, EmptyState } from '@/components/ui';
import { useActiveWeek } from '@/hooks/useWeeks';
import { formatWeekRange } from '@/lib/dates';

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
