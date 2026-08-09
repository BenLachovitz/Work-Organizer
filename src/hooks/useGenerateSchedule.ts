import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase, supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { dayIndexInWeek, type DateKey } from '@/lib/dates';
import {
  WEIGHTS,
  effectiveKamut,
  type BaseShift,
  type MorningTarget,
  type ShiftType,
} from '@/lib/shifts';
import { mockSolve } from '@/lib/mockSolver';
import { verifySchedule } from '@/lib/validate';
import { solverInputSchema, solverOutputSchema, type SolverInput } from '@/lib/solverContract';
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

    return {
      id: guard.id,
      display_name: guard.display_name,
      effective_kamut: effectiveKamut(configured, availableDays),
      availability,
      preferred,
      twelve_hour_day: twelveHourDay,
      twelve_hour_night: twelveHourNight,
    };
  });

  return solverInputSchema.parse({
    week_start: weekStart,
    morning_target_slots: morningTarget,
    guards,
    carry_in: carryIn,
    weights: WEIGHTS,
  });
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
    }): Promise<GenerateResult> => {
      const db = requireSupabase();
      const { weekStart, morningTarget, data } = args;

      // --- carry-in from last week's published roster ----------------------
      const carryIn: Record<string, ShiftType | null> = {};
      const { data: carryRows } = await db.rpc('carry_in_shifts', { p_week_start: weekStart });
      for (const row of (carryRows ?? []) as { guard_id: string; shift: ShiftType }[]) {
        carryIn[row.guard_id] = row.shift;
      }

      const input = buildSolverInput(weekStart, morningTarget, data, carryIn);

      // --- solve ------------------------------------------------------------
      const remote = import.meta.env.VITE_SOLVER_MODE === 'remote';
      let output;
      let engine: 'mock' | 'cp-sat' = 'mock';

      if (remote) {
        const { data: res, error } = await db.functions.invoke('generate-schedule', {
          body: input,
        });
        if (error) {
          // The service sleeps on Render's free tier and can be cold or down.
          // Falling back keeps the manager unblocked; the mock is always legal,
          // just not provably optimal.
          console.warn('remote solver unavailable, falling back to mock:', error.message);
          output = mockSolve(input);
        } else {
          output = solverOutputSchema.parse(res);
          engine = 'cp-sat';
        }
      } else {
        output = mockSolve(input);
      }

      // --- referee ----------------------------------------------------------
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
      assignments: { date: DateKey; shift: ShiftType; guard_id: string }[];
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

/** Publishes a draft. The partial unique index guarantees one per week. */
export function usePublishRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { runId: string; weekStart: DateKey }) => {
      const db = requireSupabase();

      // Unpublish any existing published run for the week first: the partial
      // unique index would otherwise reject the second publication outright.
      await db
        .from('schedule_runs')
        .update({ is_published: false })
        .eq('week_start', args.weekStart)
        .eq('is_published', true);

      const { error } = await db
        .from('schedule_runs')
        .update({ is_published: true })
        .eq('id', args.runId);
      if (error) throw new Error(error.message);

      await db
        .from('roster_weeks')
        .update({ status: 'published' })
        .eq('week_start', args.weekStart);
    },
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: runKeys.forWeek(args.weekStart) });
      void qc.invalidateQueries({ queryKey: ['roster_weeks'] });
    },
  });
}

export const isSupabaseReady = () => supabase !== null;
