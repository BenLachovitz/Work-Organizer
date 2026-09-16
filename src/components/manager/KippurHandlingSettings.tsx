import { useState } from 'react';
import { Alert, Button, Collapsible, Spinner, Toggle } from '@/components/ui';
import { useSchedulerSettings, useUpdateSchedulerSettings } from '@/hooks/useSchedulerSettings';

/**
 * Standing switch for the Yom Kippur special-coverage feature (migration 54)
 * -- Yom Kippur is a driving-prohibited holiday, and 2-3 guards need to cover
 * an unbroken block from Kippur eve's early afternoon through the end of
 * Kippur day (excluding that final night). Turning this on does not itself
 * mark any specific week: whichever week the Hebrew calendar places Yom
 * Kippur in (src/lib/holidays.ts) automatically surfaces its own guard-picker
 * panel on the manager dashboard once this is on, the same relationship
 * DefaultMorningTargetSettings has with WeekExceptionsPanel.
 */
export function KippurHandlingSettings({
  defaultExpanded = false,
}: {
  defaultExpanded?: boolean;
}) {
  const { data, isLoading, error } = useSchedulerSettings();

  return (
    <Collapsible
      title="יום כיפור · טיפול מיוחד"
      summary={
        isLoading ? 'טוען…' : data ? (data.kippur_handling_enabled ? 'פעיל' : 'כבוי') : 'שגיאה בטעינה'
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
        <SettingsForm current={data.kippur_handling_enabled} />
      )}
    </Collapsible>
  );
}

function SettingsForm({ current }: { current: boolean }) {
  const update = useUpdateSchedulerSettings();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [enabled, setEnabled] = useState(current);

  const dirty = enabled !== current;

  const save = () => {
    update.mutate(
      { kippur_handling_enabled: enabled },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        כשפעיל, בשבוע שבו חל ערב יום כיפור ויום כיפור עצמו תופיע במסך הניהול אפשרות לבחור 2 או 3
        מאבטחים שיכסו את כל פרק הזמן ברצף -- מהצהריים המוקדם של ערב החג ועד סוף אחה"צ של יום כיפור
        עצמו, ללא משמרת הלילה. המערכת מזהה את התאריך המדויק לפי הלוח העברי בכל שנה מחדש.
      </p>

      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label="טיפול מיוחד ביום כיפור"
        description="מציג את בורר המאבטחים בשבוע הרלוונטי, בכל שנה."
        disabled={update.isPending}
      />

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
