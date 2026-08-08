import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type {
  Profile,
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
  /** allows12h is per slot: the 12h opt-in binds to one day, not the week. */
  slots: { date: DateKey; shift: BaseShift; allows12h: boolean }[];
  /** Free text for the manager, e.g. "עדיפות למשמרות לילה". Never fed to the solver. */
  notes?: string;
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
        p_notes: input.notes ?? null,
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

export interface WeekRoster {
  weekStart: DateKey;
  runId: string;
  /** Needed to render coverage shortfalls; guards may read roster_weeks. */
  morningTarget: 2 | 3;
  assignments: ScheduleAssignment[];
}

/**
 * Every published roster this user is allowed to see, oldest week first.
 *
 * Deliberately asks no question about weeks: RLS already answers it. A guard
 * gets the current week and anything after it (plus the previous week until
 * 07:00 on Sunday, so an in-progress night shift stays readable); a manager
 * gets everything. In practice that is the current week and the next one.
 *
 * This exists because the guard home page used to ask "which week is open for
 * SUBMISSIONS?" and then look for a roster on that week. Those are two
 * different cycles -- submissions open on Saturday evening, the roster rolls
 * over on Sunday -- and conflating them meant a published roster went unseen
 * whenever no submission window happened to be open.
 */
export function useVisibleRosters() {
  const { profile } = useAuth();

  return useQuery({
    queryKey: ['visibleRosters', profile?.id ?? ''],
    enabled: Boolean(profile?.id),
    queryFn: async (): Promise<{ weeks: WeekRoster[]; guards: Profile[] }> => {
      const db = requireSupabase();

      const { data: runs, error } = await db
        .from('schedule_runs')
        .select('id, week_start')
        .eq('is_published', true)
        .order('week_start', { ascending: true });
      if (error) throw new Error(error.message);

      const list = (runs ?? []) as { id: string; week_start: string }[];
      if (!list.length) return { weeks: [], guards: [] };

      const [assignRes, guardRes, weekRes] = await Promise.all([
        db
          .from('schedule_assignments')
          .select('*')
          .in('run_id', list.map((r) => r.id))
          .order('target_date', { ascending: true }),
        db.from('profiles').select('*'),
        db
          .from('roster_weeks')
          .select('week_start, morning_target_slots')
          .in('week_start', list.map((r) => r.week_start)),
      ]);
      if (assignRes.error) throw new Error(assignRes.error.message);
      if (guardRes.error) throw new Error(guardRes.error.message);
      if (weekRes.error) throw new Error(weekRes.error.message);

      const assignments = (assignRes.data as ScheduleAssignment[]) ?? [];
      const targets = (weekRes.data ?? []) as { week_start: string; morning_target_slots: 2 | 3 }[];

      return {
        weeks: list.map((r) => ({
          weekStart: r.week_start,
          runId: r.id,
          morningTarget:
            targets.find((w) => w.week_start === r.week_start)?.morning_target_slots ?? 2,
          assignments: assignments.filter((a) => a.run_id === r.id),
        })),
        guards: (guardRes.data as Profile[]) ?? [],
      };
    },
  });
}

/**
 * The whole published roster for a week, plus the names to render it.
 *
 * Returns the entire team rather than just the caller: a guard wants to see who
 * they are on shift with. RLS still decides whether the run is visible at all --
 * unpublished drafts and past weeks return nothing without any client-side
 * filtering, so an empty result here is a legitimate answer, not an error.
 */
export function usePublishedRoster(weekStart: DateKey) {
  const { profile } = useAuth();

  return useQuery({
    queryKey: ['publishedRoster', weekStart, profile?.id ?? ''],
    enabled: Boolean(weekStart && profile?.id),
    queryFn: async (): Promise<{ assignments: ScheduleAssignment[]; guards: Profile[] }> => {
      const db = requireSupabase();

      const { data: runs, error: runErr } = await db
        .from('schedule_runs')
        .select('id')
        .eq('week_start', weekStart)
        .eq('is_published', true)
        .limit(1);
      if (runErr) throw new Error(runErr.message);
      if (!runs?.length) return { assignments: [], guards: [] };

      const [assignRes, guardRes] = await Promise.all([
        db
          .from('schedule_assignments')
          .select('*')
          .eq('run_id', runs[0]!.id)
          .order('target_date', { ascending: true }),
        db.from('profiles').select('*'),
      ]);
      if (assignRes.error) throw new Error(assignRes.error.message);
      if (guardRes.error) throw new Error(guardRes.error.message);

      return {
        assignments: (assignRes.data as ScheduleAssignment[]) ?? [],
        guards: (guardRes.data as Profile[]) ?? [],
      };
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
