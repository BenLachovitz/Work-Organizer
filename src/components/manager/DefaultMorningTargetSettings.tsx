import { useState } from 'react';
import { Alert, Button, Card, Spinner, cn } from '@/components/ui';
import { segmentFloors, type MorningTarget } from '@/lib/shifts';
import { useSchedulerSettings, useUpdateSchedulerSettings } from '@/hooks/useSchedulerSettings';

/**
 * Standing default for the Mon-Fri morning target (migration 24) -- distinct
 * from WeekControlsPanel, which only ever acts on the one selected week. This
 * is where a manager flips the STANDING value for a stretch (e.g. 2 instead
 * of 3 for a vacation period) so every week created from then on picks it up
 * automatically; WeekControlsPanel is still how one specific week gets
 * overridden, same relationship SubmissionWindowSettings already has with the
 * per-week lock/reopen flow.
 */
export function DefaultMorningTargetSettings() {
  const { data, isLoading, error } = useSchedulerSettings();
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-start"
      >
        <div>
          <p className="font-bold text-slate-900">יעד בוקר · ברירת מחדל</p>
          <p className="mt-0.5 text-sm text-slate-500">
            {isLoading
              ? 'טוען…'
              : data
                ? `${data.default_morning_target_slots} מאבטחים בשבועות חדשים`
                : 'שגיאה בטעינה'}
          </p>
        </div>
        <span className={cn('text-slate-400 transition-transform', expanded && 'rotate-180')}>
          ▾
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 px-4 py-3">
          {error ? (
            <Alert tone="error">{error instanceof Error ? error.message : 'שגיאה בטעינה.'}</Alert>
          ) : isLoading || !data ? (
            <div className="grid place-items-center py-4">
              <Spinner className="size-5 text-brand-600" />
            </div>
          ) : (
            <SettingsForm current={data.default_morning_target_slots as MorningTarget} />
          )}
        </div>
      )}
    </Card>
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
      <p className="text-xs text-slate-500">
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
                ? 'border-brand-600 bg-brand-50'
                : 'border-slate-200 bg-white hover:border-slate-300',
            )}
          >
            <span className="block text-lg font-extrabold text-slate-900">{t}</span>
            <span className="block text-[11px] text-slate-500">רצפה {segmentFloors(t, 1).S1}</span>
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
