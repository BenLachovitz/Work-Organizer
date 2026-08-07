import { AppShell } from '@/components/layout/AppShell';
import { ButtonLink, Card, EmptyState } from '@/components/ui';

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
