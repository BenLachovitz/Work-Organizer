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
 * The two views of `input` the Kippur block needs -- computed together
 * because both start from the same "effective target" for each affected
 * (day, segment) cell.
 *
 * `effectiveTarget = max(realTarget, n)`: the Kippur block GUARANTEES n
 * guards on every segment it covers, regardless of whatever ceiling a
 * manager configured for that day before this feature ever ran a
 * generation. A segment target exists to bound how many OTHER,
 * solver-placed guards show up -- it was never a way to evict guards who
 * are mandatorily present, so a real, already-configured ceiling LOWER than
 * n (a real production case: this week already had S3/S4 overridden to 1
 * for every day, unrelated to Kippur, before n=2 Kippur guards were picked)
 * must be treated as raised to n for this generation, not as a hard block.
 *
 *  - `solving`: fed to the SOLVER. Segment targets become
 *    `effectiveTarget - n` (the remainder left for other guards -- 0 when
 *    the Kippur block alone already meets or exceeds the real ceiling), the
 *    Kippur guards' availability is removed for the two Kippur dates so the
 *    solver doesn't independently propose an ordinary shift for someone
 *    already committed (double-booking them once kippurAssignments() is
 *    merged in), and their max_shifts is reduced by 2 so their normal-week
 *    budget leaves room for the 2 rows about to be added back.
 *  - `referee`: fed to verifySchedule(). Segment targets become
 *    `effectiveTarget` -- the true ceiling once the Kippur block's
 *    guaranteed coverage is counted, so the block's OWN presence never
 *    itself reads as an H6 breach. A genuine over-assignment BEYOND what
 *    the block guarantees is still correctly caught.
 *
 * Formerly a known, narrow limit, resolved by migration 57: Yom Kippur can
 * fall on a Saturday (confirmed empirically -- it only ever lands on
 * Mon/Wed/Thu/Sat, never Sun/Fri), and until migration 57 this app
 * hard-locked the WEEKEND morning target to 2, unoverridable -- so a 3-guard
 * block on a Saturday Kippur day (kippur_day2 covers S1) would exceed that
 * fixed ceiling with no override available to fix it. Now that
 * morningTargetForDay() honours an explicit override on any day (including
 * weekends), the effective-target raise below applies to the morning segment
 * on every Kippur day exactly like it always has for S2/S3/S4 -- a manager
 * who needs a 3-guard block on a Saturday Kippur day can set that Saturday's
 * morning override to 3 first.
 */
function withKippurAdjustments(
  input: SolverInput,
  weekStart: DateKey,
  kippurGuardIds: readonly string[],
  kippurInfo: { erevDate: DateKey; dayDate: DateKey },
): { solving: SolverInput; referee: SolverInput } {
  const erevDayIdx = dayIndexInWeek(weekStart, kippurInfo.erevDate);
  const dayDayIdx = dayIndexInWeek(weekStart, kippurInfo.dayDate);
  const erevKey = String(erevDayIdx);
  const dayKey = String(dayDayIdx);
  const guardSet = new Set(kippurGuardIds);
  const n = kippurGuardIds.length;

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

  // These override maps deliberately use the WIDENED wire domain (0|1|2|3 for
  // both morning and secondary -- solverContract.ts caps a real per-day
  // override lower, but the effective target here can genuinely need to
  // reach n=3), not shifts.ts's manager-facing MorningTarget (1|2|3) /
  // SecondaryTarget (1|2) types: values above what a manager can pick, and 0,
  // are solving/referee-input-only concepts. n is capped at 3 (GUARD_COUNTS
  // in KippurPanel.tsx), matching morning's own existing ceiling.
  const solvingMorning: Record<string, 0 | 1 | 2 | 3> = { ...input.morning_target_overrides };
  const refereeMorning: Record<string, 0 | 1 | 2 | 3> = { ...input.morning_target_overrides };
  // Since migration 57, morning is raisable/overridable on every day exactly
  // like S2/S3/S4 always have been -- no weekday gate needed any more.
  const effectiveMorning = Math.max(realDay.S1, n);
  solvingMorning[dayKey] = Math.max(0, effectiveMorning - n) as 0 | 1 | 2 | 3;
  refereeMorning[dayKey] = effectiveMorning as 0 | 1 | 2 | 3;

  const solvingSecondary: Record<'S2' | 'S3' | 'S4', Record<string, 0 | 1 | 2 | 3>> = {
    S2: { ...input.secondary_target_overrides.S2 },
    S3: { ...input.secondary_target_overrides.S3 },
    S4: { ...input.secondary_target_overrides.S4 },
  };
  const refereeSecondary: Record<'S2' | 'S3' | 'S4', Record<string, 0 | 1 | 2 | 3>> = {
    S2: { ...input.secondary_target_overrides.S2 },
    S3: { ...input.secondary_target_overrides.S3 },
    S4: { ...input.secondary_target_overrides.S4 },
  };
  const applySecondary = (
    seg: 'S2' | 'S3' | 'S4',
    dayKeyToSet: string,
    realTarget: number,
  ) => {
    const effective = Math.max(realTarget, n);
    solvingSecondary[seg][dayKeyToSet] = Math.max(0, effective - n) as 0 | 1 | 2 | 3;
    refereeSecondary[seg][dayKeyToSet] = effective as 0 | 1 | 2 | 3;
  };
  applySecondary('S2', erevKey, realErev.S2);
  applySecondary('S3', erevKey, realErev.S3);
  applySecondary('S4', erevKey, realErev.S4);
  applySecondary('S2', dayKey, realDay.S2);
  applySecondary('S3', dayKey, realDay.S3);

  const strippedGuards = input.guards.map((g) => {
    if (!guardSet.has(g.id)) return g;
    const availability = { ...g.availability };
    delete availability[erevKey];
    delete availability[dayKey];
    return { ...g, availability, max_shifts: Math.max(0, g.max_shifts - 2) };
  });

  return {
    solving: {
      ...input,
      morning_target_overrides: solvingMorning,
      secondary_target_overrides: solvingSecondary,
      guards: strippedGuards,
    },
    // Availability/max_shifts stay the REAL ones for the referee -- only the
    // segment ceilings are adjusted, so H1/H4/H5 still judge the actual
    // submitted availability and the actual weekly ceiling.
    referee: {
      ...input,
      morning_target_overrides: refereeMorning,
      secondary_target_overrides: refereeSecondary,
    },
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
      // something either engine chooses. The referee input's segment
      // ceilings are separately raised to at least the Kippur guard count,
      // so the block's own guaranteed coverage never itself reads as an H6
      // breach against an already-configured lower target (see
      // withKippurAdjustments()'s docstring).
      const kippurInfo = getYomKippurWeekInfo(weekStart);
      const kippurGuardIds = kippurInfo ? data.kippurGuardIds : [];
      const hasKippurBlock = Boolean(kippurInfo) && kippurGuardIds.length > 0;
      const { solving: solvingInput, referee: refereeInput } =
        hasKippurBlock && kippurInfo
          ? withKippurAdjustments(input, weekStart, kippurGuardIds, kippurInfo)
          : { solving: input, referee: input };

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

      if (hasKippurBlock && kippurInfo) {
        output = {
          ...output,
          assignments: [
            ...output.assignments,
            ...kippurAssignments(weekStart, kippurGuardIds, kippurInfo),
          ],
        };
      }

      // --- referee ------------------------------------------------------------
      // Against `refereeInput`, not `solvingInput` -- real availability and
      // real max_shifts (the kippur rows just merged in still have to pass H1
      // on the guard's actual submitted availability, and the real ceiling
      // still has to hold once they're counted normally), but with segment
      // ceilings raised to accommodate the Kippur block's guaranteed coverage
      // (see withKippurAdjustments()'s docstring). Identical to `input` on
      // every non-Kippur week.
      const verdict = verifySchedule(refereeInput, output);
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
