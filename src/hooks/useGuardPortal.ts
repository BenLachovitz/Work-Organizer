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
import type {
  BaseShift,
  DoubleShiftHours,
  MorningTargetOverrides,
  SecondarySegment,
  SecondaryTargetOverrides,
} from '@/lib/shifts';

export const guardKeys = {
  week: (guardId: string, weekStart: DateKey) => ['guardWeek', guardId, weekStart] as const,
};

/**
 * Fire-and-forget: tells the manager a guard just submitted, edited, or
 * cancelled. Deliberately never awaited by its caller and never throws --
 * the guard's own save/cancel already succeeded server-side by the time this
 * runs, and a failed "FYI" push to the manager is not a reason to make the
 * guard's action look like it failed.
 *
 * This is what makes guard_submitted/guard_cancelled client-triggered rather
 * than a database trigger (see send-notifications' own header comment): only
 * a real guard using the real app reaches this function. Test scripts call
 * save_week_preferences/delete_week_submission directly over supabase-js,
 * never through React, so they never invoke it -- avoiding a real push to
 * the real manager's phone on every test run.
 */
function notifyManagerOfSubmissionChange(args: {
  guardId: string;
  weekStart: DateKey;
  type: 'guard_submitted' | 'guard_cancelled';
  event?: 'new' | 'edited';
}) {
  requireSupabase()
    .functions.invoke('send-notifications', {
      body: {
        type: args.type,
        guard_id: args.guardId,
        week_start: args.weekStart,
        ...(args.event ? { event: args.event } : {}),
      },
    })
    .catch((e) => console.warn('notifyManagerOfSubmissionChange failed (non-fatal):', e));
}

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
  /** allows12h and strength are both per slot: the 12h opt-in and the
   *  עדיפות mark each bind to one day, not the week. */
  slots: { date: DateKey; shift: BaseShift; allows12h: boolean; strength: 1 | 2 }[];
  /** Free text for the manager, e.g. "עדיפות למשמרות לילה". Never fed to the solver. */
  notes?: string;
  /** Guard's preferred shift count for the week, or null/omitted for "no
   *  explicit request, defer to configured כמות" -- see effectiveKamut()/
   *  stretchTarget() in src/lib/shifts.ts for how it's applied. */
  requestedShifts?: number | null;
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
      // Read BEFORE the save so "was this a new submission or an edit" isn't
      // guessed after the fact -- the cache still reflects pre-save state
      // here, since nothing has invalidated it yet.
      const before = queryClient.getQueryData<GuardWeekData>(guardKeys.week(guardId, input.weekStart));
      const wasNew = !before?.hasSubmitted;

      const { error } = await requireSupabase().rpc('save_week_preferences', {
        p_week_start: input.weekStart,
        p_slots: input.slots,
        p_notes: input.notes ?? null,
        p_requested_shifts: input.requestedShifts ?? null,
      });
      if (error) {
        // 42501 is the insufficient_privilege we raise when the window shut
        // between page load and submit.
        if (error.code === '42501' || /closed/i.test(error.message)) {
          throw new Error('חלון ההגשה נסגר. פנה למנהל המשמרת.');
        }
        throw new Error(error.message);
      }
      return { wasNew };
    },
    onSuccess: ({ wasNew }, input) => {
      void queryClient.invalidateQueries({
        queryKey: guardKeys.week(guardId, input.weekStart),
      });
      if (guardId) {
        notifyManagerOfSubmissionChange({
          guardId, weekStart: input.weekStart, type: 'guard_submitted',
          event: wasNew ? 'new' : 'edited',
        });
      }
    },
  });
}

/**
 * Cancels a guard's own submission for a week outright, via
 * delete_week_submission (migration 30) -- not an edit down to an empty
 * week (spec 3.4's "submitted, empty" is a distinct, deliberate state), but
 * genuinely back to "never submitted", so the guard can reconsider and
 * submit fresh later, or not at all.
 */
export function useDeleteSubmission() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useMutation({
    mutationFn: async (weekStart: DateKey) => {
      const { error } = await requireSupabase().rpc('delete_week_submission', {
        p_week_start: weekStart,
      });
      if (error) {
        // 42501 is the insufficient_privilege we raise when the window shut
        // between page load and the click.
        if (error.code === '42501' || /closed/i.test(error.message)) {
          throw new Error('חלון ההגשה נסגר. פנה למנהל המשמרת.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: (_data, weekStart) => {
      void queryClient.invalidateQueries({ queryKey: guardKeys.week(guardId, weekStart) });
      if (guardId) {
        notifyManagerOfSubmissionChange({ guardId, weekStart, type: 'guard_cancelled' });
      }
    },
  });
}

export interface WeekRoster {
  weekStart: DateKey;
  runId: string;
  /** Needed to render coverage shortfalls; guards may read roster_weeks. */
  morningTarget: 2 | 3;
  /** Per-day exceptions to morningTarget for this week (§1) -- see
   *  morningTargetForDay() in src/lib/shifts.ts. */
  morningTargetOverrides: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of
   *  2 (§1) -- see segmentTargets() in src/lib/shifts.ts. */
  segmentTargetOverrides: SecondaryTargetOverrides;
  /** Display-only 12h/11h handover-text setting for this week -- see
   *  doubleShiftSuffix()/doubleShiftLabel() in src/lib/shifts.ts. */
  doubleShiftHours: DoubleShiftHours;
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

      const [assignRes, guardRes, weekRes, overrideRes, segmentOverrideRes] = await Promise.all([
        db
          .from('schedule_assignments')
          .select('*')
          .in('run_id', list.map((r) => r.id))
          .order('target_date', { ascending: true }),
        db.from('profiles').select('*'),
        db
          .from('roster_weeks')
          .select('week_start, morning_target_slots, double_shift_display_hours')
          .in('week_start', list.map((r) => r.week_start)),
        db
          .from('weekly_morning_target_overrides')
          .select('week_start, day_index, morning_target_slots')
          .in('week_start', list.map((r) => r.week_start)),
        db
          .from('weekly_segment_target_overrides')
          .select('week_start, day_index, segment, target_slots')
          .in('week_start', list.map((r) => r.week_start)),
      ]);
      if (assignRes.error) throw new Error(assignRes.error.message);
      if (guardRes.error) throw new Error(guardRes.error.message);
      if (weekRes.error) throw new Error(weekRes.error.message);
      if (overrideRes.error) throw new Error(overrideRes.error.message);
      if (segmentOverrideRes.error) throw new Error(segmentOverrideRes.error.message);

      const assignments = (assignRes.data as ScheduleAssignment[]) ?? [];
      const targets = (weekRes.data ?? []) as {
        week_start: string;
        morning_target_slots: 2 | 3;
        double_shift_display_hours: DoubleShiftHours;
      }[];
      const overrideRows = (overrideRes.data ?? []) as {
        week_start: string;
        day_index: number;
        morning_target_slots: 2 | 3;
      }[];
      const segmentOverrideRows = (segmentOverrideRes.data ?? []) as {
        week_start: string;
        day_index: number;
        segment: SecondarySegment;
        target_slots: 1 | 2;
      }[];

      return {
        weeks: list.map((r) => {
          const segmentTargetOverrides: SecondaryTargetOverrides = {};
          for (const o of segmentOverrideRows) {
            if (o.week_start !== r.week_start) continue;
            (segmentTargetOverrides[o.segment] ??= {})[String(o.day_index)] = o.target_slots;
          }
          return {
            weekStart: r.week_start,
            runId: r.id,
            morningTarget:
              targets.find((w) => w.week_start === r.week_start)?.morning_target_slots ?? 2,
            doubleShiftHours:
              targets.find((w) => w.week_start === r.week_start)?.double_shift_display_hours ?? 12,
            morningTargetOverrides: Object.fromEntries(
              overrideRows
                .filter((o) => o.week_start === r.week_start)
                .map((o) => [String(o.day_index), o.morning_target_slots]),
            ),
            segmentTargetOverrides,
            assignments: assignments.filter((a) => a.run_id === r.id),
          };
        }),
        guards: (guardRes.data as Profile[]) ?? [],
      };
    },
  });
}

