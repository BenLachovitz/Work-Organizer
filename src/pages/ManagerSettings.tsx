import { AppShell } from '@/components/layout/AppShell';
import { DefaultMorningTargetSettings } from '@/components/manager/DefaultMorningTargetSettings';
import { SubmissionWindowSettings } from '@/components/manager/SubmissionWindowSettings';
import { ButtonLink } from '@/components/ui';

/**
 * Standing, global scheduler defaults -- not tied to any one week, rarely
 * touched (set-and-forget). Pulled off the main /manage dashboard for the
 * same reason team management and guard-preference detail already have
 * their own pages: this is a different task ("configure the system") from
 * the weekly workflow /manage is otherwise about, and unlike this week's
 * exceptions (WeekExceptionsPanel), nothing here needs to be cross-checked
 * in real time against anything else on that page.
 */
export function ManagerSettings() {
  return (
    <AppShell title="הגדרות" subtitle="ברירות מחדל למערכת">
      <div className="space-y-4">
        <ButtonLink to="/manage" variant="ghost" size="sm">
          → חזרה לניהול
        </ButtonLink>

        <DefaultMorningTargetSettings defaultExpanded />
        <SubmissionWindowSettings defaultExpanded />
      </div>
    </AppShell>
  );
}
