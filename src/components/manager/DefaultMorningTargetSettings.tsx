import { useState } from 'react';
import { Alert, Button, Collapsible, Spinner, cn } from '@/components/ui';
import { segmentFloors, type MorningTarget } from '@/lib/shifts';
import { useSchedulerSettings, useUpdateSchedulerSettings } from '@/hooks/useSchedulerSettings';

/**
 * Standing default for the Mon-Fri morning target (migration 24) -- distinct
 * from WeekExceptionsPanel, which only ever acts on the one selected week.
 * This is where a manager flips the STANDING value for a stretch (e.g. 2
 * instead of 3 for a vacation period) so every week created from then on
 * picks it up automatically; WeekExceptionsPanel is still how one specific
 * week gets overridden, same relationship SubmissionWindowSettings already
 * has with the per-week lock/reopen flow.
 *
 * Lives on its own page (ManagerSettings) -- expanded by default there,
 * since the reason to collapse it (dashboard clutter) doesn't apply on a
 * page dedicated solely to standing settings.
 */
export function DefaultMorningTargetSettings({
  defaultExpanded = false,
}: {
  defaultExpanded?: boolean;
}) {
  const { data, isLoading, error } = useSchedulerSettings();

  return (
    <Collapsible
      title="יעד בוקר · ברירת מחדל"
      summary={
        isLoading
          ? 'טוען…'
          : data
            ? `${data.default_morning_target_slots} מאבטחים בשבועות חדשים`
            : 'שגיאה בטעינה'
      }
      defaultExpanded={defaultExpanded}
    >
      {error ? (
        <Alert tone="error">{error instanceof Error ? error.message : 'שגיאה בטעינה.'}</Alert>
      ) : isLoading || !data ? (
        <div className="grid place-items-center py-4">
          <Spinner className="size-5 text-brand-600" />
        </div>
      ) : (
        <SettingsForm current={data.default_morning_target_slots as MorningTarget} />
      )}
    </Collapsible>
  );
}

function SettingsForm({ current }: { current: MorningTarget }) {
  const update = useUpdateSchedulerSettings();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [target, setTarget] = useState<MorningTarget>(current);

  const dirty = target !== current;

  const save = () => {
    update.mutate(
      { default_morning_target_slots: target },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        משפיע על שבועות חדשים מעכשיו והלאה. כדי לשנות שבוע ספציפי שכבר קיים, יש להשתמש ביעד משמרת
        הבוקר למעלה.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {([2, 3] as MorningTarget[]).map((t) => (
          <button
            key={t}
            type="button"
            disabled={update.isPending}
            onClick={() => setTarget(t)}
            className={cn(
              'rounded-xl border-2 px-3 py-2.5 text-center transition-all disabled:opacity-50',
              target === t
                ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50'
                : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
            )}
          >
            <span className="block text-lg font-extrabold text-slate-900 dark:text-slate-100">
              {t}
            </span>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">
              רצפה {segmentFloors(t, 1).S1}
            </span>
          </button>
        ))}
      </div>

      {update.isError && (
        <Alert tone="error">
          {update.error instanceof Error ? update.error.message : 'השמירה נכשלה.'}
        </Alert>
      )}
      {savedAt && !dirty && <Alert tone="success">נשמר בהצלחה.</Alert>}

      <Button fullWidth size="sm" disabled={!dirty} loading={update.isPending} onClick={save}>
        שמירה
      </Button>
    </div>
  );
}
