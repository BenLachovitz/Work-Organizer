import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase, supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { dayIndexInWeek, type DateKey } from '@/lib/dates';
import { getYomKippurWeekInfo } from '@/lib/holidays';
import {
  WEIGHTS,
  effectiveKamut,
  stretchTarget,
  guardShiftCeiling,
  isWorkingDay,
  segmentTargets,
  type BaseShift,
  type MorningTarget,
  type MorningTargetOverrides,
  type SecondaryTargetOverrides,
  type ShiftType,
} from '@/lib/shifts';
import { mockSolve } from '@/lib/mockSolver';
import { verifySchedule } from '@/lib/validate';
import {
  solverInputSchema,
  solverOutputSchema,
  type Assignment,
  type SolverInput,
} from '@/lib/solverContract';
import type { ManagerWeekData } from '@/hooks/useManager';
import { managerKeys } from '@/hooks/useManager';
import { weekKeys } from '@/hooks/useWeeks';
import type { CoverageReport, ScheduleAssignment, ScheduleRun } from '@/types/database';

export const runKeys = {
  forWeek: (weekStart: DateKey) => ['scheduleRuns', weekStart] as const,
};

/**
 * Turns the week's stored data into the solver contract.
 *
 * The כמות override happens HERE, before the solver ever sees it: a guard whose
 * availability cannot reach their configured target gets that target lowered
 * rather than handed to the solver as an unsatisfiable constraint. That is what
 * keeps the engine from returning an INFEASIBLE a manager cannot act on.
 */
export function buildSolverInput(
  weekStart: DateKey,
  morningTarget: MorningTarget,
  data: ManagerWeekData,
  carryIn: Record<string, ShiftType | null>,
  morningTargetOverrides: MorningTargetOverrides = {},
  secondaryTargetOverrides: SecondaryTargetOverrides = {},
): SolverInput {
  const guards = data.guards.map((guard) => {
    const prefs = data.preferences.filter((p) => p.guard_id === guard.id);

    const availability: Record<string, BaseShift[]> = {};
    const preferred: Record<string, BaseShift[]> = {};
    const twelveHourDay: number[] = [];
    const twelveHourNight: number[] = [];

    for (const p of prefs) {
      const d = dayIndexInWeek(weekStart, p.target_date);
      if (d < 0) continue; // outside the week: ignore rather than mis-index
      const key = String(d);
      (availability[key] ??= []).push(p.shift);
      if (p.strength === 2) (preferred[key] ??= []).push(p.shift);

      if (p.allows_12h) {
        if (p.shift === 'morning') twelveHourDay.push(d);
        if (p.shift === 'night') twelveHourNight.push(d);
      }
    }

    const configured =
      data.targets.find((t) => t.guard_id === guard.id)?.configured_kamut ?? 0;
    // Distinct DAYS, not slots: one shift per day makes days the real bound.
    const availableDays = new Set(prefs.map((p) => p.target_date)).size;
    const requested =
      data.submissions.find((s) => s.guard_id === guard.id)?.requested_shifts ?? null;

    return {
      id: guard.id,
      display_name: guard.display_name,
      effective_kamut: effectiveKamut(configured, availableDays, requested),
      stretch_target: stretchTarget(configured, availableDays, requested),
      max_shifts: guardShiftCeiling(configured, availableDays, requested),
      availability,
      preferred,
      twelve_hour_day: twelveHourDay,
      twelve_hour_night: twelveHourNight,
    };
  });

  return solverInputSchema.parse({
    week_start: weekStart,
    morning_target_slots: morningTarget,
    morning_target_overrides: morningTargetOverrides,
    secondary_target_overrides: secondaryTargetOverrides,
    guards,
    carry_in: carryIn,
    weights: WEIGHTS,
  });
}

/**
 * The two kippur_day1/kippur_day2 rows (src/lib/shifts.ts, migration 56) for
 * each guard chosen to cover this week's Yom Kippur block
 * (weekly_kippur_guards, migration 55) -- forced facts, never something
 * either engine decides, so they're built directly rather than fed to the
 * solver as a choice.
 */
function kippurAssignments(
  weekStart: DateKey,
  kippurGuardIds: readonly string[],
  kippurInfo: { erevDate: DateKey; dayDate: DateKey },
): Assignment[] {
  const erevDay = dayIndexInWeek(weekStart, kippurInfo.erevDate);
  const dayDay = dayIndexInWeek(weekStart, kippurInfo.dayDate);
  return kippurGuardIds.flatMap((guard_id) => [
    { day: erevDay, date: kippurInfo.erevDate, shift: 'kippur_day1' as const, guard_id },
    { day: dayDay, date: kippurInfo.dayDate, shift: 'kippur_day2' as const, guard_id },
  ]);
}

/**
 * A copy of `input` adjusted for the Kippur block, fed to the SOLVER ONLY --
 * never what the referee checks (see verifySchedule() call below).
 *
 * Two adjustments:
 *  1. The Kippur guards' availability is removed for the two Kippur dates,
 *     and their max_shifts reduced by 2 -- so the solver doesn't
 *     independently propose an ordinary shift for a guard already committed
 *     to the block (which would double-book them once kippurAssignments()
 *     is merged in), and its normal-week budget leaves room for the 2 rows
 *     about to be added back.
 *  2. Each affected segment's target/ceiling is lowered by the number of
 *     Kippur guards, on both Kippur dates -- kippur_day1 already covers
 *     S2+S3+S4 on the eve day and kippur_day2 already covers S1+S2+S3 on
 *     Kippur day itself, so without this the solver would independently
 *     seek the FULL target with OTHER guards on top of what the Kippur
 *     block already provides, and the merged total would breach H6 (a
 *     segment's target doubles as its hard ceiling in this app).
 *
 * Known, narrow limit worth stating plainly: Yom Kippur can fall on a
 * Saturday (confirmed empirically -- it only ever lands on Mon/Wed/Thu/Sat,
 * never Sun/Fri), and this app hard-locks the WEEKEND morning target to 2,
 * unoverridable by design (morningTargetForDay() in src/lib/shifts.ts, "an
 * override never applies to them, even if one somehow existed for that
 * index"). If Yom Kippur falls on a Saturday, kippur_day2 already covers S1
 * that day, and a 3-guard block alone exceeds that fixed ceiling of 2 --
 * generation will then correctly refuse (H6) with no override available to
 * fix it from here. Configuring only 2 Kippur guards in a year Yom Kippur
 * falls on a Saturday avoids this; a manager who wants 3 that year would
 * need to place the third guard by hand rather than through generation.
 */
function withKippurSolvingAdjustments(
  input: SolverInput,
  weekStart: DateKey,
  kippurGuardIds: readonly string[],
  kippurInfo: { erevDate: DateKey; dayDate: DateKey },
): SolverInput {
  const erevDayIdx = dayIndexInWeek(weekStart, kippurInfo.erevDate);
  const dayDayIdx = dayIndexInWeek(weekStart, kippurInfo.dayDate);
  const erevKey = String(erevDayIdx);
  const dayKey = String(dayDayIdx);
  const guardSet = new Set(kippurGuardIds);
  const n = kippurGuardIds.length;
  const reduce = (target: number) => Math.max(0, target - n);

  const realErev = segmentTargets(
    input.morning_target_slots,
    erevDayIdx,
    input.morning_target_overrides,
    input.secondary_target_overrides,
  );
  const realDay = segmentTargets(
    input.morning_target_slots,
    dayDayIdx,
    input.morning_target_overrides,
    input.secondary_target_overrides,
  );

  // These two override maps deliberately use the WIDENED wire domain (0|2|3
  // / 0|1|2 -- solverContract.ts), not shifts.ts's manager-facing
  // MorningTarget (2|3) / SecondaryTarget (1|2) types: 0 is a solving-input-
  // only concept a manager can never pick through the UI.
  const morningTargetOverrides: Record<string, 0 | 2 | 3> = { ...input.morning_target_overrides };
  // Weekends hard-lock the morning target to 2 regardless of any override --
  // see the docstring above for what that means when Kippur day is a
  // Saturday. Setting an override here would simply be ignored, so it's
  // skipped rather than written for no effect.
  if (isWorkingDay(dayDayIdx)) {
    morningTargetOverrides[dayKey] = reduce(realDay.S1) as 0 | 2 | 3;
  }

  const secondaryTargetOverrides: Record<'S2' | 'S3' | 'S4', Record<string, 0 | 1 | 2>> = {
    S2: { ...input.secondary_target_overrides.S2 },
    S3: { ...input.secondary_target_overrides.S3 },
    S4: { ...input.secondary_target_overrides.S4 },
  };
  secondaryTargetOverrides.S2[erevKey] = reduce(realErev.S2) as 0 | 1 | 2;
  secondaryTargetOverrides.S3[erevKey] = reduce(realErev.S3) as 0 | 1 | 2;
  secondaryTargetOverrides.S4[erevKey] = reduce(realErev.S4) as 0 | 1 | 2;
  secondaryTargetOverrides.S2[dayKey] = reduce(realDay.S2) as 0 | 1 | 2;
  secondaryTargetOverrides.S3[dayKey] = reduce(realDay.S3) as 0 | 1 | 2;

  return {
    ...input,
    morning_target_overrides: morningTargetOverrides,
    secondary_target_overrides: secondaryTargetOverrides,
    guards: input.guards.map((g) => {
      if (!guardSet.has(g.id)) return g;
      const availability = { ...g.availability };
      delete availability[erevKey];
      delete availability[dayKey];
      return { ...g, availability, max_shifts: Math.max(0, g.max_shifts - 2) };
    }),
  };
}

/**
 * Each guard's shift on the Saturday before this week, from the previous week's
 * published roster.
 *
 * Needed by the editor as well as the solver: a manual Sunday assignment can
 * create a clopen against last week just as easily as an automatic one, and
 * without this the referee would judge the edit blind to the week boundary.
 *
 * An empty map is a normal answer — the previous week may not exist or may
 * never have been published.
 */
export function useCarryIn(weekStart: DateKey) {
  return useQuery({
    queryKey: ['carryIn', weekStart] as const,
    enabled: Boolean(weekStart),
    queryFn: async (): Promise<Record<string, ShiftType | null>> => {
      const { data, error } = await requireSupabase().rpc('carry_in_shifts', {
        p_week_start: weekStart,
      });
      if (error) throw new Error(error.message);
      const map: Record<string, ShiftType | null> = {};
      for (const row of (data ?? []) as { guard_id: string; shift: ShiftType }[]) {
        map[row.guard_id] = row.shift;
      }
      return map;
    },
  });
}

/** Rosters generated for a week, newest first. Drafts are manager-only by RLS. */
export function useScheduleRuns(weekStart: DateKey) {
  return useQuery({
    queryKey: runKeys.forWeek(weekStart),
    enabled: Boolean(weekStart),
    queryFn: async () => {
      const db = requireSupabase();
      const { data: runs, error } = await db
        .from('schedule_runs')
        .select('*')
        .eq('week_start', weekStart)
        .order('version', { ascending: false });
      if (error) throw new Error(error.message);

      const list = (runs ?? []) as ScheduleRun[];
      if (!list.length) return { runs: list, assignments: [] as ScheduleAssignment[] };

      const { data: assignments, error: aErr } = await db
        .from('schedule_assignments')
        .select('*')
        .in('run_id', list.map((r) => r.id));
      if (aErr) throw new Error(aErr.message);

      return { runs: list, assignments: (assignments ?? []) as ScheduleAssignment[] };
    },
  });
}

export interface GenerateResult {
  runId: string;
  version: number;
  status: string;
  objective: number;
  report: CoverageReport;
  engine: 'mock' | 'cp-sat';
}

/**
 * Generates a roster and stores it as a new draft version.
 *
 * The solver is asked for assignments; the REPORT is then recomputed locally by
 * verifySchedule() rather than trusted from the engine, and a schedule that
 * breaks a hard rule is refused outright. Better a visible failure than a
 * roster that quietly puts somebody on a clopen.
 */
export function useGenerateSchedule() {
  const qc = useQueryClient();
  const { profile } = useAuth();

  return useMutation({
    mutationFn: async (args: {
      weekStart: DateKey;
      morningTarget: MorningTarget;
      data: ManagerWeekData;
      morningTargetOverrides?: MorningTargetOverrides;
      secondaryTargetOverrides?: SecondaryTargetOverrides;
    }): Promise<GenerateResult> => {
      const db = requireSupabase();
      const { weekStart, morningTarget, data, morningTargetOverrides, secondaryTargetOverrides } =
        args;

      // --- carry-in from last week's published roster ----------------------
      const carryIn: Record<string, ShiftType | null> = {};
      const { data: carryRows } = await db.rpc('carry_in_shifts', { p_week_start: weekStart });
      for (const row of (carryRows ?? []) as { guard_id: string; shift: ShiftType }[]) {
        carryIn[row.guard_id] = row.shift;
      }

      const input = buildSolverInput(
        weekStart,
        morningTarget,
        data,
        carryIn,
        morningTargetOverrides,
        secondaryTargetOverrides,
      );

      // --- Yom Kippur special coverage (§ src/lib/holidays.ts, migration 56) -
      // If this week actually contains Yom Kippur AND guards are configured
      // to cover it, the solver is asked to solve around them (their
      // availability on the two Kippur dates is hidden from it, and their
      // weekly budget is reduced by 2) -- the two kippur_day1/kippur_day2
      // rows themselves are forced facts, added back in after solving, never
      // something either engine chooses.
      const kippurInfo = getYomKippurWeekInfo(weekStart);
      const kippurGuardIds = kippurInfo ? data.kippurGuardIds : [];
      const solvingInput =
        kippurInfo && kippurGuardIds.length > 0
          ? withKippurSolvingAdjustments(input, weekStart, kippurGuardIds, kippurInfo)
          : input;

      // --- solve ------------------------------------------------------------
      const remote = import.meta.env.VITE_SOLVER_MODE === 'remote';
      let output;
      let engine: 'mock' | 'cp-sat' = 'mock';

      if (remote) {
        const { data: res, error } = await db.functions.invoke('generate-schedule', {
          body: solvingInput,
        });
        if (error) {
          // The service sleeps on Render's free tier and can be cold or down.
          // Falling back keeps the manager unblocked; the mock is always legal,
          // just not provably optimal.
          console.warn('remote solver unavailable, falling back to mock:', error.message);
          output = mockSolve(solvingInput);
        } else {
          output = solverOutputSchema.parse(res);
          engine = 'cp-sat';
        }
      } else {
        output = mockSolve(solvingInput);
      }

      if (kippurInfo && kippurGuardIds.length > 0) {
        output = {
          ...output,
          assignments: [
            ...output.assignments,
            ...kippurAssignments(weekStart, kippurGuardIds, kippurInfo),
          ],
        };
      }

      // --- referee ------------------------------------------------------------
      // Always against the REAL input (real availability, real max_shifts),
      // never `solvingInput` -- the kippur rows just merged in still have to
      // pass H1 on the guard's actual submitted availability, and the real
      // ceiling still has to hold once they're counted normally.
      const verdict = verifySchedule(input, output);
      if (!verdict.valid) {
        throw new Error(
          `הסידור שנוצר מפר כללי בטיחות ולכן לא נשמר:\n` +
            verdict.violations.slice(0, 3).map((v) => `${v.rule}: ${v.message}`).join('\n'),
        );
      }

      // The referee cannot report kamut_overrides: it only sees the effective
      // target, never the manager's original figure. So it is recorded here,
      // where both numbers are in hand, and stored alongside the referee's
      // findings rather than mixed into them.
      const kamutOverrides = input.guards
        .map((g) => {
          const configured =
            data.targets.find((t) => t.guard_id === g.id)?.configured_kamut ?? 0;
          const availableDays = new Set(
            data.preferences.filter((p) => p.guard_id === g.id).map((p) => p.target_date),
          ).size;
          return {
            guard_id: g.id,
            configured,
            available_days: availableDays,
            effective: g.effective_kamut,
          };
        })
        .filter((o) => o.effective < o.configured);

      const storedReport: CoverageReport = { ...verdict.report, kamut_overrides: kamutOverrides };

      // --- persist the overridden כמות so the dashboard shows what was used --
      for (const g of input.guards) {
        await db
          .from('weekly_guard_targets')
          .upsert(
            {
              week_start: weekStart,
              guard_id: g.id,
              configured_kamut:
                data.targets.find((t) => t.guard_id === g.id)?.configured_kamut ?? 0,
              effective_kamut: g.effective_kamut,
            },
            { onConflict: 'week_start,guard_id' },
          );
      }

      // --- write the run ----------------------------------------------------
      const { data: versionData, error: vErr } = await db.rpc('next_run_version', {
        p_week_start: weekStart,
      });
      if (vErr) throw new Error(vErr.message);
      const version = (versionData as number) ?? 1;

      const { data: run, error: runErr } = await db
        .from('schedule_runs')
        .insert({
          week_start: weekStart,
          version,
          solver_status: output.status,
          objective_value: verdict.objective,
          coverage_report: storedReport,
          generated_by: profile?.id ?? null,
        })
        .select()
        .single<ScheduleRun>();
      if (runErr) throw new Error(runErr.message);

      if (output.assignments.length > 0) {
        const { error: aErr } = await db.from('schedule_assignments').insert(
          output.assignments.map((a) => ({
            run_id: run.id,
            target_date: a.date,
            shift: a.shift,
            guard_id: a.guard_id,
          })),
        );
        if (aErr) {
          // Leaving a run row with no assignments would look like a legitimate
          // empty roster, which is a real state. Remove it instead.
          await db.from('schedule_runs').delete().eq('id', run.id);
          throw new Error(aErr.message);
        }
      }

      await db.from('roster_weeks').update({ status: 'generated' }).eq('week_start', weekStart);

      return {
        runId: run.id,
        version,
        status: output.status,
        objective: verdict.objective,
        report: storedReport,
        engine,
      };
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
      void qc.invalidateQueries({ queryKey: managerKeys.week(args.weekStart) });
      void qc.invalidateQueries({ queryKey: ['roster_weeks'] });
    },
  });
}

/**
 * Replaces a draft run's assignments with a hand-edited set.
 *
 * Goes through save_run_assignments rather than a delete-then-insert pair from
 * the client: a half-applied edit would leave the roster missing people, and a
 * manager who saw "saved" would have no reason to look again.
 */
export function useSaveRunAssignments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      runId: string;
      weekStart: DateKey;
      assignments: {
        date: DateKey;
        shift: ShiftType;
        /** null is a placeholder row -- a note-only cell annotation with no real guard (§12.9). */
        guard_id: string | null;
        note_before?: string;
        note_after?: string;
        /** Placeholder-only: counts a guard-less row toward coverage (§12.9, migration 52). */
        occupies_slot?: boolean;
      }[];
    }) => {
      const { error } = await requireSupabase().rpc('save_run_assignments', {
        p_run_id: args.runId,
        p_assignments: args.assignments,
      });
      if (error) {
        if (/published/i.test(error.message)) {
          throw new Error('לא ניתן לערוך סידור שכבר פורסם. בטל את הפרסום קודם.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
    },
  });
}

/**
 * Deletes a run and its assignments.
 *
 * Allowed on a published roster too. A manager who wants to start over should
 * not have to work around the app, and refusing would only push the change back
 * to WhatsApp — the thing this replaces.
 */
export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { runId: string; weekStart: DateKey }) => {
      const { error } = await requireSupabase().rpc('delete_schedule_run', {
        p_run_id: args.runId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
      void qc.invalidateQueries({ queryKey: weekKeys.all });
    },
  });
}

/** Takes a roster off the guards' phones without destroying it. */
export function useUnpublishRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { runId: string; weekStart: DateKey }) => {
      const { error } = await requireSupabase().rpc('unpublish_run', { p_run_id: args.runId });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
      void qc.invalidateQueries({ queryKey: weekKeys.all });
    },
  });
}

/**
 * Publishes a draft, via publish_roster (migration 43). Unpublishing the
 * previous run, publishing this one, and flipping the week's status all
 * happen inside one transaction now, instead of three separate client round
 * trips -- a network drop used to be able to leave the week half-published.
 */
export function usePublishRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { runId: string; weekStart: DateKey }) => {
      const { error } = await requireSupabase().rpc('publish_roster', { p_run_id: args.runId });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
      void qc.invalidateQueries({ queryKey: ['roster_weeks'] });
    },
  });
}

/**
 * Manually announces a published roster to the whole team, via
 * send-notifications' roster_published type (migration 43). Deliberately
 * separate from publishing itself -- a manager sometimes publishes just to
 * check the layout, not to ship it, so the notification is an explicit,
 * repeatable second action rather than something publish does automatically.
 */
export function useNotifyRosterPublished() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { weekStart: DateKey }) => {
      const { data, error } = await requireSupabase().functions.invoke('send-notifications', {
        body: { type: 'roster_published', week_start: args.weekStart },
      });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; sent: number; targets: number };
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: ['lastPublishNotification', args.weekStart] });
    },
  });
}

/** Most recent successful roster_published send for a week, if any -- shown next to the button so pressing it twice is an informed choice, not a guess. */
export function useLastPublishNotification(weekStart: DateKey) {
  return useQuery({
    queryKey: ['lastPublishNotification', weekStart],
    enabled: Boolean(weekStart),
    queryFn: async () => {
      const { data, error } = await requireSupabase()
        .from('notification_log')
        .select('sent_at')
        .eq('notification_type', 'roster_published')
        .eq('week_start', weekStart)
        .eq('status', 'sent')
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.sent_at as string | undefined) ?? null;
    },
  });
}

export const isSupabaseReady = () => supabase !== null;
