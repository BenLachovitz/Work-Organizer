import { Card } from '@/components/ui';
import { formatWeekRange } from '@/lib/dates';
import type { DateKey } from '@/lib/dates';
import type { RosterWeek } from '@/types/database';

/**
 * Compact week dropdown shared by the manager sub-pages that operate on
 * "whichever week is picked" but don't need ManagerDashboard's full
 * live/archive tab picker (Summary, Roster generation, Preferences).
 */
export function WeekSelectCard({
  id,
  weeks,
  selected,
  onSelect,
  nextStart,
}: {
  id: string;
  weeks: RosterWeek[];
  selected: string;
  onSelect: (weekStart: DateKey) => void;
  nextStart: DateKey;
}) {
  return (
    <Card className="flex items-center gap-3">
      <label htmlFor={id} className="shrink-0 text-sm font-bold text-slate-700 dark:text-slate-300">
        שבוע
      </label>
      <select
        id={id}
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full min-w-0 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      >
        {weeks.map((w) => (
          <option key={w.week_start} value={w.week_start}>
            {formatWeekRange(w.week_start)}
            {w.week_start === nextStart ? ' (הבא)' : ''}
          </option>
        ))}
      </select>
    </Card>
  );
}
