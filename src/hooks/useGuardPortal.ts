import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type {
  ScheduleAssignment,
  WeeklyGuardTarget,
  WeeklySubmission,
  WishPreference,
} from '@/types/database';
import type { DateKey } from '@/lib/dates';
import type { BaseShift } from '@/lib/shifts';

export const guardKeys = {
  week: (guardId: string, weekStart: DateKey) => ['guardWeek', guardId, weekStart] as const,
  schedule: (guardId: string, weekStart: DateKey) => ['mySchedule', guardId, weekStart] as const,
};

export interface GuardWeekData {
  submission: WeeklySubmission | null;
  preferences: WishPreference[];
  target: WeeklyGuardTarget | null;
  /** Distinguishes "submitted an empty sheet" from "never opened the form". */
  hasSubmitted: boolean;
}

/**
 * Everything the preference form needs for one week, in one round trip.
 *
 * RLS already restricts each of these to the caller's own rows, so no filter on
 * guard_id is strictly required -- but it is passed anyway. Defence in depth is
 * cheap, and it keeps the query honest if a policy is ever loosened.
 */
export function useGuardWeek(weekStart: DateKey) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useQuery({
    queryKey: guardKeys.week(guardId, weekStart),
    enabled: Boolean(guardId && weekStart),
    queryFn: async (): Promise<GuardWeekData> => {
      const db = requireSupabase();

      const [subRes, prefRes, targetRes] = await Promise.all([
        db
          .from('weekly_submissions')
          .select('*')
          .eq('guard_id', guardId)
          .eq('week_start', weekStart)
          .maybeSingle(),
        db
          .from('weekly_wish_preferences')
          .select('*')
          .eq('guard_id', guardId)
          .eq('week_start', weekStart),
        db
          .from('weekly_guard_targets')
          .select('*')
          .eq('guard_id', guardId)
          .eq('week_start', weekStart)
          .maybeSingle(),
      ]);

      if (subRes.error) throw new Error(subRes.error.message);
      if (prefRes.error) throw new Error(prefRes.error.message);
      if (targetRes.error) throw new Error(targetRes.error.message);

      return {
        submission: (subRes.data as WeeklySubmission) ?? null,
        preferences: (prefRes.data as WishPreference[]) ?? [],
        target: (targetRes.data as WeeklyGuardTarget) ?? null,
        hasSubmitted: Boolean(subRes.data),
      };
    },
  });
}

export interface SavePreferencesInput {
  weekStart: DateKey;
  slots: { date: DateKey; shift: BaseShift }[];
  canWork12hDay: boolean;
  canWork12hNight: boolean;
}

/**
 * Saves a whole week through the save_week_preferences RPC.
 *
 * Deliberately NOT a delete-then-insert from the client: two PostgREST calls
 * can half-fail and turn a filled-in week into an empty one. The RPC does both
 * in a single transaction, still under the caller's RLS.
 */
export function useSavePreferences() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useMutation({
    mutationFn: async (input: SavePreferencesInput) => {
      const { error } = await requireSupabase().rpc('save_week_preferences', {
        p_week_start: input.weekStart,
        p_slots: input.slots,
        p_12h_day: input.canWork12hDay,
        p_12h_night: input.canWork12hNight,
      });
      if (error) {
        // 42501 is the insufficient_privilege we raise when the window shut
        // between page load and submit.
        if (error.code === '42501' || /closed/i.test(error.message)) {
          throw new Error('חלון ההגשה נסגר. פנה למנהל המשמרת.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({
        queryKey: guardKeys.week(guardId, input.weekStart),
      });
    },
  });
}

/** The guard's own shifts in the published roster for a week. */
export function useMySchedule(weekStart: DateKey) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useQuery({
    queryKey: guardKeys.schedule(guardId, weekStart),
    enabled: Boolean(guardId && weekStart),
    queryFn: async (): Promise<ScheduleAssignment[]> => {
      const db = requireSupabase();

      // RLS hides unpublished runs entirely, so this can only ever return
      // assignments from a roster the manager has actually published.
      const { data: runs, error: runErr } = await db
        .from('schedule_runs')
        .select('id')
        .eq('week_start', weekStart)
        .eq('is_published', true)
        .limit(1);
      if (runErr) throw new Error(runErr.message);
      if (!runs?.length) return [];

      const { data, error } = await db
        .from('schedule_assignments')
        .select('*')
        .eq('run_id', runs[0]!.id)
        .eq('guard_id', guardId)
        .order('target_date', { ascending: true });
      if (error) throw new Error(error.message);
      return (data as ScheduleAssignment[]) ?? [];
    },
  });
}
