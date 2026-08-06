import { useQuery } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import type { RosterWeek } from '@/types/database';
import { currentSubmissionWeek, type DateKey } from '@/lib/dates';

export const weekKeys = {
  all: ['roster_weeks'] as const,
};

/**
 * All schedulable weeks. The database is the authority on which weeks exist --
 * the client-side date maths in dates.ts is only a fallback for when no week
 * has been created yet.
 */
export function useRosterWeeks() {
  return useQuery({
    queryKey: weekKeys.all,
    queryFn: async (): Promise<RosterWeek[]> => {
      const { data, error } = await requireSupabase()
        .from('roster_weeks')
        .select('*')
        .order('week_start', { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

export interface ActiveWeek {
  weekStart: DateKey;
  week: RosterWeek | null;
  /** True when guards may still edit. Mirrors is_week_open() in the database. */
  isOpen: boolean;
  deadline: Date | null;
}

/**
 * The week guards should be filling in right now: the earliest week that is
 * still accepting submissions. Falls back to the computed week so the UI has
 * something coherent to show before the manager has created any.
 */
export function useActiveWeek(): { data: ActiveWeek; isLoading: boolean } {
  const { data: weeks, isLoading } = useRosterWeeks();

  const now = Date.now();
  const open = (weeks ?? [])
    .filter((w) => w.status === 'open' && new Date(w.submission_deadline).getTime() > now)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));

  const chosen = open[0] ?? null;

  return {
    isLoading,
    data: chosen
      ? {
          weekStart: chosen.week_start,
          week: chosen,
          isOpen: true,
          deadline: new Date(chosen.submission_deadline),
        }
      : {
          weekStart: currentSubmissionWeek(),
          week: null,
          isOpen: false,
          deadline: null,
        },
  };
}
