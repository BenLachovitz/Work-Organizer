import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import type {
  Profile,
  RosterWeek,
  WeeklyGuardTarget,
  WeeklySubmission,
  WishPreference,
} from '@/types/database';
import type { DateKey } from '@/lib/dates';
import { weekKeys } from '@/hooks/useWeeks';
import {
  MAX_SHIFTS_PER_WEEK,
  effectiveKamut,
  type BaseShift,
  type MorningTarget,
} from '@/lib/shifts';

export const managerKeys = {
  week: (weekStart: DateKey) => ['managerWeek', weekStart] as const,
  codes: ['rosterCodeStatus'] as const,
};

export interface ManagerWeekData {
  guards: Profile[];
  submissions: WeeklySubmission[];
  preferences: WishPreference[];
  targets: WeeklyGuardTarget[];
}

/** Everything the dashboard needs for one week. Manager RLS returns all rows. */
export function useManagerWeek(weekStart: DateKey) {
  return useQuery({
    queryKey: managerKeys.week(weekStart),
    enabled: Boolean(weekStart),
    queryFn: async (): Promise<ManagerWeekData> => {
      const db = requireSupabase();
      const [guards, submissions, preferences, targets] = await Promise.all([
        db.from('profiles').select('*').eq('is_active', true).order('display_name'),
        db.from('weekly_submissions').select('*').eq('week_start', weekStart),
        db.from('weekly_wish_preferences').select('*').eq('week_start', weekStart),
        db.from('weekly_guard_targets').select('*').eq('week_start', weekStart),
      ]);

      for (const r of [guards, submissions, preferences, targets]) {
        if (r.error) throw new Error(r.error.message);
      }

      return {
        guards: (guards.data as Profile[]) ?? [],
        submissions: (submissions.data as WeeklySubmission[]) ?? [],
        preferences: (preferences.data as WishPreference[]) ?? [],
        targets: (targets.data as WeeklyGuardTarget[]) ?? [],
      };
    },
  });
}

/** One row of roster_code_status -- a badge code, and the profile it became
 *  once claimed. `profile_id`/`is_active` are null until then. */
export interface RosterCodeStatus {
  employee_code: string;
  display_name: string;
  initial_role: 'guard' | 'manager' | 'admin';
  is_claimed: boolean;
  claim_enabled: boolean;
  claimed_at: string | null;
  profile_id: string | null;
  is_active: boolean | null;
  /** Baseline weekly כמות -- from roster_codes before claiming, from
   *  profiles (the live, editable value) after. */
  default_kamut: number;
}

/** Registration status per badge code, for chasing guards who never signed up
 *  and for the team-management page (§ TeamManagement). */
export function useRosterCodeStatus() {
  return useQuery({
    queryKey: managerKeys.codes,
    queryFn: async (): Promise<RosterCodeStatus[]> => {
      const { data, error } = await requireSupabase()
        .from('roster_code_status')
        .select('*')
        .order('employee_code');
      if (error) throw new Error(error.message);
      return (data as RosterCodeStatus[]) ?? [];
    },
  });
}

export function useUpdateWeek() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      weekStart: DateKey;
      morningTarget?: MorningTarget;
      status?: RosterWeek['status'];
      deadline?: string;
    }) => {
      const db = requireSupabase();

      // Status goes through set_week_status, NOT a plain UPDATE. That RPC also
      // stamps status_overridden_at so ensure_roster_weeks() stops managing the
      // week, and extends the deadline when reopening one that had expired --
      // without which the reopen changes a flag but nothing observable, because
      // is_week_open() also requires NOW() < submission_deadline.
      if (input.status !== undefined) {
        const { error } = await db.rpc('set_week_status', {
          p_week_start: input.weekStart,
          p_status: input.status,
          p_extend_hours: 24,
        });
        if (error) throw new Error(error.message);
      }

      const patch: Record<string, unknown> = {};
      if (input.morningTarget !== undefined) patch.morning_target_slots = input.morningTarget;
      if (input.deadline !== undefined) patch.submission_deadline = input.deadline;

      if (Object.keys(patch).length > 0) {
        const { error } = await db
          .from('roster_weeks')
          .update(patch)
          .eq('week_start', input.weekStart);
        if (error) throw new Error(error.message);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: weekKeys.all });
    },
  });
}

/** Same slot shape SavePreferencesInput uses (src/hooks/useGuardPortal.ts) --
 *  allows12h and strength are per slot, not per week. */
export interface ManagerSavePreferencesInput {
  weekStart: DateKey;
  guardId: string;
  slots: { date: DateKey; shift: BaseShift; allows12h: boolean; strength: 1 | 2 }[];
  notes?: string;
  /** The guard's preferred shift count, editable by the manager on their
   *  behalf -- null for "no explicit request, defer to configured כמות". */
  requestedShifts?: number | null;
}

/**
 * Saves a guard's whole week on their behalf, through
 * manager_save_week_preferences (migration 32) -- the manager-keyed twin of
 * save_week_preferences. Not bound by the guard's own submission deadline,
 * unlike the guard-facing mutation: a manager's edit isn't automation, so it
 * isn't swept by the same window.
 */
export function useManagerSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManagerSavePreferencesInput) => {
      const { error } = await requireSupabase().rpc('manager_save_week_preferences', {
        p_guard_id: input.guardId,
        p_week_start: input.weekStart,
        p_slots: input.slots,
        p_notes: input.notes ?? null,
        p_requested_shifts: input.requestedShifts ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: managerKeys.week(input.weekStart) });
    },
  });
}

/** Cancels a guard's submission on their behalf, through
 *  manager_delete_week_submission (migration 32) -- the manager-keyed twin of
 *  delete_week_submission. */
export function useManagerDeleteSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { weekStart: DateKey; guardId: string }) => {
      const { error } = await requireSupabase().rpc('manager_delete_week_submission', {
        p_guard_id: input.guardId,
        p_week_start: input.weekStart,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: managerKeys.week(input.weekStart) });
    },
  });
}

export function useSetGuardTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { weekStart: DateKey; guardId: string; kamut: number }) => {
      const clamped = Math.max(0, Math.min(MAX_SHIFTS_PER_WEEK, Math.round(input.kamut)));
      const { error } = await requireSupabase()
        .from('weekly_guard_targets')
        .upsert(
          {
            week_start: input.weekStart,
            guard_id: input.guardId,
            configured_kamut: clamped,
          },
          { onConflict: 'week_start,guard_id' },
        );
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: managerKeys.week(input.weekStart) });
    },
  });
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export type SubmissionState = 'none' | 'empty' | 'filled';

export interface GuardRow {
  guard: Profile;
  state: SubmissionState;
  availableDays: number;
  slotCount: number;
  /** How many days the guard opted to extend, per extended shift type. */
  twelveHourDayCount: number;
  twelveHourNightCount: number;
  /** How many marked slots the guard flagged עדיפות (strength 2). */
  preferredCount: number;
  configuredKamut: number;
  /** min(configured, availableDays, 5) -- what the solver will actually target. */
  effectiveKamut: number;
  /** True when availability, not the manager's setting, is the binding limit. */
  lowered: boolean;
  /** Free text from the guard. Context for a human; the solver never sees it. */
  notes: string | null;
  /** Guard-stated preferred shift count for the week, null = no explicit
   *  request. See effectiveKamut()/stretchTarget() in src/lib/shifts.ts. */
  requestedShifts: number | null;
}

export function buildGuardRows(data: ManagerWeekData): GuardRow[] {
  const prefsByGuard = new Map<string, WishPreference[]>();
  for (const p of data.preferences) {
    const list = prefsByGuard.get(p.guard_id) ?? [];
    list.push(p);
    prefsByGuard.set(p.guard_id, list);
  }
  const subByGuard = new Map(data.submissions.map((s) => [s.guard_id, s]));
  const targetByGuard = new Map(data.targets.map((t) => [t.guard_id, t]));

  return data.guards.map((guard) => {
    const prefs = prefsByGuard.get(guard.id) ?? [];
    const sub = subByGuard.get(guard.id);
    const configured = targetByGuard.get(guard.id)?.configured_kamut ?? 0;

    // Distinct DAYS, not slots: one shift per day makes days the real bound.
    const availableDays = new Set(prefs.map((p) => p.target_date)).size;
    const requested = sub?.requested_shifts ?? null;
    const effective = effectiveKamut(configured, availableDays, requested);

    return {
      guard,
      state: !sub ? 'none' : prefs.length === 0 ? 'empty' : 'filled',
      availableDays,
      slotCount: prefs.length,
      // Derived from the preference rows now that the opt-in is per day.
      twelveHourDayCount: prefs.filter((p) => p.allows_12h && p.shift === 'morning').length,
      twelveHourNightCount: prefs.filter((p) => p.allows_12h && p.shift === 'night').length,
      preferredCount: prefs.filter((p) => p.strength === 2).length,
      configuredKamut: configured,
      effectiveKamut: effective,
      lowered: effective < configured,
      notes: sub?.notes ?? null,
      requestedShifts: requested,
    };
  });
}

export interface CoverageCell {
  date: DateKey;
  shift: BaseShift;
  available: number;
}

/** How many guards declared themselves available for each day/shift. */
export function buildCoverage(data: ManagerWeekData, dates: DateKey[]): CoverageCell[] {
  const counts = new Map<string, number>();
  for (const p of data.preferences) {
    const k = `${p.target_date}|${p.shift}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const shifts: BaseShift[] = ['morning', 'afternoon', 'night'];
  return dates.flatMap((date) =>
    shifts.map((shift) => ({
      date,
      shift,
      available: counts.get(`${date}|${shift}`) ?? 0,
    })),
  );
}
