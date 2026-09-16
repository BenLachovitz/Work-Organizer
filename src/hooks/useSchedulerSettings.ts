import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';

/**
 * The submission window's global configuration (migration 22) -- when a
 * week's window opens and when it closes. Everything here is expressed the
 * way the database stores it: N days before week_start, plus a time of day.
 * `src/lib/dates.ts`'s offsetForWeekday/weekdayForOffset convert that to and
 * from the day-of-week a manager actually thinks in.
 */
export interface SchedulerSettings {
  deadline_offset_days: number;
  deadline_time: string; // 'HH:MM:SS'
  open_offset_days: number;
  open_time: string;
  /** Starting morning_target_slots for a NEW week (migration 24). Does not
   *  touch an existing week -- WeekExceptionsPanel's per-week control still
   *  overrides one specific week. */
  default_morning_target_slots: number;
  /** Standing switch for the Yom Kippur special-coverage feature (migration
   *  54). Whether a SPECIFIC week actually needs the guard-picker panel is a
   *  computed fact (src/lib/holidays.ts) -- this only controls whether the
   *  app ever looks for that at all. */
  kippur_handling_enabled: boolean;
}

const KEY = ['schedulerSettings'] as const;

export function useSchedulerSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<SchedulerSettings> => {
      const { data, error } = await requireSupabase()
        .from('scheduler_settings')
        .select(
          'deadline_offset_days, deadline_time, open_offset_days, open_time, default_morning_target_slots, kippur_handling_enabled',
        )
        .eq('id', true)
        .single();
      if (error) throw new Error(error.message);
      return data as SchedulerSettings;
    },
  });
}

/**
 * Changing this affects weeks CREATED FROM NOW ON. `ensure_roster_weeks()`
 * only consults it when inserting a new `roster_weeks` row or sweeping status
 * against that row's already-stored deadline -- an existing week's stored
 * deadline is not rewritten retroactively. To change one specific week's
 * deadline right now, the existing lock/reopen flow on `WeekControlsPanel` is
 * still the way.
 */
export function useUpdateSchedulerSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<SchedulerSettings>) => {
      const { error } = await requireSupabase()
        .from('scheduler_settings')
        .update(input)
        .eq('id', true);
      if (error) {
        if (error.code === '23514' || /open_before_deadline/.test(error.message)) {
          throw new Error('שעת הפתיחה חייבת לחול לפני מועד הסגירה.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
