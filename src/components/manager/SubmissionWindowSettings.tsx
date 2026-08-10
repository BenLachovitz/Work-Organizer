import { useState } from 'react';
import { Alert, Button, Card, Spinner, cn } from '@/components/ui';
import { HEBREW_DAYS, offsetForWeekday, weekdayForOffset } from '@/lib/dates';
import { useSchedulerSettings, useUpdateSchedulerSettings } from '@/hooks/useSchedulerSettings';

/**
 * Global config for when a week's submission window opens and closes --
 * distinct from anything on WeekControlsPanel, which only ever acts on the
 * one selected week. Defaults are Saturday 20:00 (open) / Wednesday 19:00
 * (close, spec §2.4a); this is where a manager changes the STANDING
 * schedule, not a one-off extension -- that is still the existing
 * lock/reopen flow on WeekControlsPanel.
 *
 * The database stores "N days before week_start, at time T" (unchanged from
 * before this was configurable); the day-of-week a manager actually thinks in
 * is a client-side view of that, converted by offsetForWeekday/
 * weekdayForOffset (src/lib/dates.ts).
 */
export function SubmissionWindowSettings() {
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
          <p className="font-bold text-slate-900 dark:text-slate-100">חלון הגשת בקשות</p>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {isLoading
              ? 'טוען…'
              : data
                ? `פתיחה ${HEBREW_DAYS[weekdayForOffset(data.open_offset_days)]} ${data.open_time.slice(0, 5)} · סגירה ${HEBREW_DAYS[weekdayForOffset(data.deadline_offset_days)]} ${data.deadline_time.slice(0, 5)}`
                : 'שגיאה בטעינה'}
          </p>
        </div>
        <span
          className={cn(
            'text-slate-400 transition-transform dark:text-slate-500',
            expanded && 'rotate-180',
          )}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          {error ? (
            <Alert tone="error">{error instanceof Error ? error.message : 'שגיאה בטעינה.'}</Alert>
          ) : isLoading || !data ? (
            <div className="grid place-items-center py-4">
              <Spinner className="size-5 text-brand-600" />
            </div>
          ) : (
            <SettingsForm data={data} />
          )}
        </div>
      )}
    </Card>
  );
}

function SettingsForm({
  data,
}: {
  data: { deadline_offset_days: number; deadline_time: string; open_offset_days: number; open_time: string };
}) {
  const update = useUpdateSchedulerSettings();
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const [openWeekday, setOpenWeekday] = useState(() => weekdayForOffset(data.open_offset_days));
  const [openTime, setOpenTime] = useState(data.open_time.slice(0, 5));
  const [deadlineWeekday, setDeadlineWeekday] = useState(() =>
    weekdayForOffset(data.deadline_offset_days),
  );
  const [deadlineTime, setDeadlineTime] = useState(data.deadline_time.slice(0, 5));

  const dirty =
    openWeekday !== weekdayForOffset(data.open_offset_days) ||
    openTime !== data.open_time.slice(0, 5) ||
    deadlineWeekday !== weekdayForOffset(data.deadline_offset_days) ||
    deadlineTime !== data.deadline_time.slice(0, 5);

  const save = () => {
    // Deadline's offset is the natural one for its weekday; open's has to
    // exceed it -- see offsetForWeekday, which steps back a further week on
    // its own if the naive value would not.
    const deadlineOffset = offsetForWeekday(deadlineWeekday);
    const openOffset = offsetForWeekday(openWeekday, deadlineOffset);
    update.mutate(
      {
        deadline_offset_days: deadlineOffset,
        deadline_time: deadlineTime,
        open_offset_days: openOffset,
        open_time: openTime,
      },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        משפיע על שבועות חדשים מעכשיו והלאה. כדי לשנות את מועד הסגירה של שבוע ספציפי שכבר קיים, יש
        להשתמש בנעילה/פתיחה מחדש למעלה.
      </p>

      <WeekdayTimeRow
        label="פתיחת ההגשות"
        weekday={openWeekday}
        time={openTime}
        onWeekday={setOpenWeekday}
        onTime={setOpenTime}
      />
      <WeekdayTimeRow
        label="סגירת ההגשות (מועד אחרון)"
        weekday={deadlineWeekday}
        time={deadlineTime}
        onWeekday={setDeadlineWeekday}
        onTime={setDeadlineTime}
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

function WeekdayTimeRow({
  label,
  weekday,
  time,
  onWeekday,
  onTime,
}: {
  label: string;
  weekday: number;
  time: string;
  onWeekday: (v: number) => void;
  onTime: (v: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</p>
      <div className="flex gap-2">
        <select
          value={weekday}
          onChange={(e) => onWeekday(Number(e.target.value))}
          className="flex-1 rounded-xl border-2 border-slate-200 bg-white p-2.5 text-sm text-slate-800 focus:border-brand-400 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          {HEBREW_DAYS.map((d, i) => (
            <option key={d} value={i}>
              יום {d}
            </option>
          ))}
        </select>
        <input
          type="time"
          value={time}
          onChange={(e) => onTime(e.target.value)}
          className="num w-32 rounded-xl border-2 border-slate-200 bg-white p-2.5 text-sm text-slate-800 focus:border-brand-400 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
      </div>
    </div>
  );
}
