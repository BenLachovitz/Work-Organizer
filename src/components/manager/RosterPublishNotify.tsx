import { useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import { useLastPublishNotification, useNotifyRosterPublished } from '@/hooks/useGenerateSchedule';
import { formatDeadline } from '@/lib/dates';
import type { DateKey } from '@/lib/dates';

/**
 * Manually broadcasts "the roster is published" to every guard, as its own
 * explicit step separate from publishing itself. A manager sometimes
 * publishes just to check the layout, not to ship it -- so notifying is a
 * deliberate second press, not something publish does on its own.
 *
 * Rendered only for a published run (same gate as RosterExport, right above
 * it), and can be pressed more than once in the same week -- e.g. after
 * republishing a correction -- unlike the automatic deadline reminders,
 * which are hard-deduped.
 */
export function RosterPublishNotify({ weekStart }: { weekStart: DateKey }) {
  const notify = useNotifyRosterPublished();
  const { data: lastSentAt } = useLastPublishNotification(weekStart);
  const [confirming, setConfirming] = useState(false);

  const onClick = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    notify.mutate(
      { weekStart },
      { onSuccess: () => setConfirming(false) },
    );
  };

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <p className="font-bold text-slate-900 dark:text-slate-100">שליחת התראה על פרסום</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {lastSentAt
            ? `נשלחה לאחרונה: ${formatDeadline(new Date(lastSentAt))}`
            : 'עדיין לא נשלחה התראה לשבוע זה.'}
        </p>
      </div>

      {notify.isError && (
        <div className="px-4 pt-3">
          <Alert tone="error">{notify.error.message}</Alert>
        </div>
      )}
      {notify.isSuccess && !confirming && (
        <div className="px-4 pt-3">
          <Alert tone="success">
            נשלח ל-{notify.data.sent} מתוך {notify.data.targets} מדריכים.
          </Alert>
        </div>
      )}

      <div className="flex gap-2 p-4">
        <Button
          className="flex-1"
          variant={confirming ? 'primary' : 'secondary'}
          loading={notify.isPending}
          disabled={notify.isPending}
          onClick={onClick}
        >
          {confirming ? 'לחץ שוב לאישור השליחה' : 'שליחת התראת פרסום לצוות'}
        </Button>
        {confirming && (
          <Button variant="ghost" disabled={notify.isPending} onClick={() => setConfirming(false)}>
            ביטול
          </Button>
        )}
      </div>
    </Card>
  );
}
