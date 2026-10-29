import { useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Card, EmptyState, Modal, Spinner, cn } from '@/components/ui';
import {
  useDeleteWorkLogEntry,
  useMonthlySalarySummary,
  useMyRateHistory,
  useUpsertWorkLogEntry,
  useWorkLogWeek,
} from '@/hooks/useWorkLog';
import {
  HEBREW_DAYS,
  ISRAEL_TZ,
  addDays,
  dayIndex,
  formatDayMonth,
  formatWeekRange,
  israelDateTime,
  todayInIsrael,
  weekStartOf,
  type DateKey,
} from '@/lib/dates';
import { SHIFTS, SHIFT_TYPES, type ShiftType } from '@/lib/shifts';
import { computePayroll, type RateHistoryEntry } from '@/lib/payroll';
import type { WorkLogEntry } from '@/types/database';

const SOURCE_BADGE: Record<WorkLogEntry['source'], { label: string; tone: string }> = {
  roster: { label: 'מהסידור', tone: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
  edited: { label: 'נערך', tone: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400' },
  manual: { label: 'ידני', tone: 'bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-400' },
};

function israelTimeString(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ISRAEL_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function timeStringToHour(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) + (m ?? 0) / 60;
}

function durationHours(entry: WorkLogEntry): number {
  return (new Date(entry.actual_end).getTime() - new Date(entry.actual_start).getTime()) / 3_600_000;
}

/**
 * Personal work log + estimated gross salary (self-service only -- no
 * manager-approval gate, see the feature plan). Lists one roster week at a
 * time, seeded automatically from the guard's own published roster
 * (useWorkLogWeek), editable in place, with manual ad-hoc entries allowed.
 */
function monthKeyOf(date: DateKey): string {
  return date.slice(0, 7);
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)),
  );
}

export function WorkLog() {
  const [view, setView] = useState<'week' | 'month'>('week');
  const [weekStart, setWeekStart] = useState<DateKey>(weekStartOf(todayInIsrael()));
  const [monthKey, setMonthKey] = useState<string>(monthKeyOf(todayInIsrael()));
  const [editing, setEditing] = useState<WorkLogEntry | 'new' | null>(null);
  const { data: rateHistory = [] } = useMyRateHistory();

  const today = todayInIsrael();

  return (
    <AppShell
      title="יומן עבודה"
      subtitle={view === 'week' ? formatWeekRange(weekStart) : formatMonthKey(monthKey)}
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800">
          {(['week', 'month'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'flex-1 rounded-lg py-1.5 text-sm font-bold transition-colors',
                view === v
                  ? 'bg-white text-slate-900 shadow dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-500 dark:text-slate-400',
              )}
            >
              {v === 'week' ? 'שבועי' : 'חודשי'}
            </button>
          ))}
        </div>

        {view === 'month' ? (
          <MonthlySummary monthKey={monthKey} setMonthKey={setMonthKey} rateHistory={rateHistory} today={today} />
        ) : (
          <WeeklyView
            weekStart={weekStart}
            setWeekStart={setWeekStart}
            today={today}
            rateHistory={rateHistory}
            editing={editing}
            setEditing={setEditing}
          />
        )}
      </div>
    </AppShell>
  );
}

function WeeklyView({
  weekStart,
  setWeekStart,
  today,
  rateHistory,
  editing,
  setEditing,
}: {
  weekStart: DateKey;
  setWeekStart: (fn: (w: DateKey) => DateKey) => void;
  today: DateKey;
  rateHistory: RateHistoryEntry[];
  editing: WorkLogEntry | 'new' | null;
  setEditing: (v: WorkLogEntry | 'new' | null) => void;
}) {
  const { data: entries, isLoading } = useWorkLogWeek(weekStart);
  const rows = entries ?? [];
  const totalHours = rows.reduce((sum, e) => sum + durationHours(e), 0);
  const breakdown = useMemo(() => computePayroll(rows, rateHistory), [rows, rateHistory]);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={() => setWeekStart((w) => addDays(w, -7))}>
          → שבוע קודם
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart(() => weekStartOf(today))}>
          השבוע
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart((w) => addDays(w, 7))}>
          שבוע הבא ←
        </Button>
      </div>

      <PayrollCard totalHours={totalHours} hasRate={rateHistory.length > 0} breakdown={breakdown} />

      <div className="space-y-4">
        {isLoading ? (
          <Card>
            <div className="grid place-items-center py-10">
              <Spinner className="size-6 text-brand-600" />
            </div>
          </Card>
        ) : rows.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon="🕒"
              title="אין רישומים לשבוע זה"
              description="משמרות מהסידור המפורסם יתווספו כאן אוטומטית, או הוסף משמרת ביד."
            />
          </Card>
        ) : (
          <Card className="space-y-0 divide-y divide-slate-100 p-0 dark:divide-slate-800">
            {rows.map((entry) => (
              <EntryRow key={entry.id} entry={entry} today={today} onClick={() => setEditing(entry)} />
            ))}
          </Card>
        )}

        <Button fullWidth variant="ghost" onClick={() => setEditing('new')}>
          + הוסף משמרת
        </Button>
      </div>

      {editing && (
        <WorkLogEntryEditor
          entry={editing === 'new' ? null : editing}
          defaultDate={editing === 'new' ? today : editing.target_date}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** Shared row rendering for a single work-log entry -- interactive (opens
 *  the edit modal) in the weekly view, read-only in the monthly summary. */
function EntryRow({
  entry,
  today,
  onClick,
}: {
  entry: WorkLogEntry;
  today: DateKey;
  onClick?: () => void;
}) {
  const badge = SOURCE_BADGE[entry.source];
  const def = entry.shift ? SHIFTS[entry.shift] : null;
  const isToday = entry.target_date === today;
  const className = cn(
    'flex w-full items-center gap-3 px-4 py-3 text-start transition-colors',
    onClick && 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
    isToday && 'bg-brand-50/70 dark:bg-brand-950/40',
  );
  const content = (
    <>
      <span
        className="w-1.5 self-stretch rounded-full"
        style={{ backgroundColor: def?.colorVar ?? 'var(--color-shift-afternoon)' }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
            יום {HEBREW_DAYS[dayIndex(entry.target_date)]}
          </p>
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', badge.tone)}>
            {badge.label}
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {formatDayMonth(entry.target_date)} · {def?.he ?? 'ללא משמרת קבועה'}
        </p>
      </div>
      <div className="text-end">
        <p className="num text-xs font-bold text-slate-700 dark:text-slate-300">
          {israelTimeString(entry.actual_start)}-{israelTimeString(entry.actual_end)}
        </p>
        <p className="num text-[10px] text-slate-400 dark:text-slate-500">
          {durationHours(entry).toFixed(1)} ש׳
        </p>
      </div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function PayrollCard({
  totalHours,
  hasRate,
  breakdown,
}: {
  totalHours: number;
  hasRate: boolean;
  breakdown: ReturnType<typeof computePayroll>;
}) {
  return (
    <Card className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-slate-800 dark:text-slate-100">סך שעות</p>
        <p className="num text-sm font-bold text-slate-800 dark:text-slate-100">
          {totalHours.toFixed(1)}
        </p>
      </div>
      {!hasRate ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">
          המנהל עדיין לא הגדיר שכר לשעה - לא ניתן להציג הערכת שכר.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
            {(
              [
                ['100%', breakdown.hours100],
                ['125%', breakdown.hours125],
                ['150%', breakdown.hours150],
                ['175%', breakdown.hours175],
                ['200%', breakdown.hours200],
              ] as const
            )
              .filter(([, hours]) => hours > 0.005)
              .map(([label, hours], i) => (
                <span key={label}>
                  {i > 0 && '· '}
                  {label} {hours.toFixed(1)} ש׳
                </span>
              ))}
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <p className="text-sm font-bold text-brand-700 dark:text-brand-400">הערכת שכר ברוטו</p>
            <p className="num text-base font-bold text-brand-700 dark:text-brand-400">
              ₪{breakdown.grossEstimate.toFixed(0)}
            </p>
          </div>
        </>
      )}
      <p className="pt-1 text-[11px] text-slate-400 dark:text-slate-500">
        הערכה בלבד, לפני מס - אינה מחוברת למערכת שכר אמיתית.
      </p>
    </Card>
  );
}

function MonthlySummary({
  monthKey,
  setMonthKey,
  rateHistory,
  today,
}: {
  monthKey: string;
  setMonthKey: (fn: (k: string) => string) => void;
  rateHistory: RateHistoryEntry[];
  today: DateKey;
}) {
  const { data: entries, isLoading } = useMonthlySalarySummary(monthKey);
  const [editing, setEditing] = useState<WorkLogEntry | null>(null);
  const rows = entries ?? [];
  const totalHours = rows.reduce((sum, e) => sum + durationHours(e), 0);
  const breakdown = useMemo(() => computePayroll(rows, rateHistory), [rows, rateHistory]);
  const sortedRows = [...rows].sort((a, b) => a.target_date.localeCompare(b.target_date));

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={() => setMonthKey((k) => shiftMonthKey(k, -1))}>
          → חודש קודם
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMonthKey(() => monthKeyOf(todayInIsrael()))}
        >
          החודש
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMonthKey((k) => shiftMonthKey(k, 1))}>
          חודש הבא ←
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <div className="grid place-items-center py-10">
            <Spinner className="size-6 text-brand-600" />
          </div>
        </Card>
      ) : (
        <>
          <PayrollCard totalHours={totalHours} hasRate={rateHistory.length > 0} breakdown={breakdown} />

          {sortedRows.length === 0 ? (
            <Card className="p-0">
              <EmptyState
                icon="🕒"
                title="אין רישומים לחודש זה"
                description="רק שבועות שנפתחו ביומן השבועי מצטרפים לסיכום החודשי."
              />
            </Card>
          ) : (
            <Card className="space-y-0 divide-y divide-slate-100 p-0 dark:divide-slate-800">
              <div className="px-4 py-2.5">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  כל המשמרות החודש
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {sortedRows.length} רישומים · לחיצה על רישום פותחת אותו לעריכה
                </p>
              </div>
              {sortedRows.map((entry) => (
                <EntryRow key={entry.id} entry={entry} today={today} onClick={() => setEditing(entry)} />
              ))}
            </Card>
          )}
        </>
      )}

      <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
        מסכם רק שבועות שכבר נצפו ביומן השבועי (ונזרעו אוטומטית). שבוע שלא נפתח עדיין לא יופיע כאן.
      </p>

      {editing && (
        <WorkLogEntryEditor
          entry={editing}
          defaultDate={editing.target_date}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function WorkLogEntryEditor({
  entry,
  defaultDate,
  onClose,
}: {
  /** NULL for a brand-new manual entry. */
  entry: WorkLogEntry | null;
  defaultDate: DateKey;
  onClose: () => void;
}) {
  const upsert = useUpsertWorkLogEntry();
  const del = useDeleteWorkLogEntry();

  const [date, setDate] = useState<DateKey>(defaultDate);
  const [shift, setShift] = useState<ShiftType | ''>(entry?.shift ?? '');
  const [start, setStart] = useState(entry ? israelTimeString(entry.actual_start) : '06:45');
  const [end, setEnd] = useState(entry ? israelTimeString(entry.actual_end) : '14:45');
  const [note, setNote] = useState(entry?.note ?? '');

  const startHour = timeStringToHour(start);
  let endHour = timeStringToHour(end);
  if (endHour <= startHour) endHour += 24; // overnight, same convention as SHIFTS[...].endH

  const durationOk = endHour - startHour > 0 && endHour - startHour <= 18;

  const save = () => {
    if (!durationOk) return;
    upsert.mutate(
      {
        id: entry?.id,
        target_date: date,
        shift: shift || null,
        actual_start: israelDateTime(date, startHour).toISOString(),
        actual_end: israelDateTime(date, endHour).toISOString(),
        note: note.trim() || null,
        source_assignment_id: entry?.source_assignment_id,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      title={entry ? 'עריכת רישום' : 'הוספת משמרת'}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <Button fullWidth disabled={!durationOk} loading={upsert.isPending} onClick={save}>
            שמירה
          </Button>
          {entry && (
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => del.mutate(entry.id, { onSuccess: onClose })}
            >
              מחיקה
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {!entry && (
          <Field label="תאריך">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        {!entry && (
          <Field label="סוג משמרת (אופציונלי)">
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as ShiftType | '')}
              className={inputClass}
            >
              <option value="">ללא</option>
              {SHIFT_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SHIFTS[s].he}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="שעת התחלה">
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="שעת סיום">
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        {!durationOk && (
          <Alert tone="error">משך המשמרת חייב להיות גדול מאפס ולא יותר מ-18 שעות.</Alert>
        )}

        <Field label="הערה (אופציונלי)">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="לדוגמה: נשארתי לסגור פרצה"
            className={inputClass}
          />
        </Field>

        {upsert.isError && <Alert tone="error">{(upsert.error as Error).message}</Alert>}
        {del.isError && <Alert tone="error">{(del.error as Error).message}</Alert>}
      </div>
    </Modal>
  );
}

const inputClass = cn(
  'w-full rounded-xl border-2 border-slate-200 p-2.5 text-sm text-slate-800',
  'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
  'focus:border-brand-400 focus:outline-none',
);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-300">
        {label}
      </span>
      {children}
    </label>
  );
}
