import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { AbsenceType, ScheduleAssignment, WorkLogAbsence, WorkLogEntry, WorkLogSource } from '@/types/database';
import { addDays, israelDateTime, type DateKey } from '@/lib/dates';
import { SHIFTS, type ShiftType } from '@/lib/shifts';
import {
  consecutiveSickDayCount,
  leaveDayValue,
  leaveReferencePeriod,
  sickPayPercent,
  type RateHistoryEntry,
} from '@/lib/payroll';

export const workLogKeys = {
  week: (guardId: string, weekStart: DateKey) => ['workLogWeek', guardId, weekStart] as const,
};

/** Nominal start/end for a shift on a given date, ISO strings ready for a
 *  timestamptz column -- the same SHIFTS[...].startH/endH clock windows the
 *  roster grid itself uses, just converted to real instants. */
function nominalWindow(targetDate: DateKey, shift: ShiftType) {
  const def = SHIFTS[shift];
  return {
    scheduled_start: israelDateTime(targetDate, def.startH).toISOString(),
    scheduled_end: israelDateTime(targetDate, def.endH).toISOString(),
  };
}

/**
 * This guard's own work-log entries for one roster week, lazily seeded from
 * their PUBLISHED roster assignments for that week.
 *
 * Seeding is plain INSERT, not upsert: work_log_one_per_assignment is a
 * PARTIAL unique index (WHERE source_assignment_id IS NOT NULL), which
 * Postgres can only use as an ON CONFLICT arbiter if the statement restates
 * that same predicate -- supabase-js's upsert() cannot express that. Instead
 * we already have the guard's existing entries in hand, so we only insert
 * the assignments that are genuinely missing one, and swallow a 23505 (two
 * tabs racing to seed the same row) as "someone else already did this".
 *
 * A guard's 'edited'/'manual' rows are never touched here -- only assignments
 * with no matching entry get a new 'roster' row. See the feature plan for
 * why a re-published week's orphaned entries are left in place rather than
 * deleted.
 */
export function useWorkLogWeek(weekStart: DateKey) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useQuery({
    queryKey: workLogKeys.week(guardId, weekStart),
    enabled: Boolean(guardId && weekStart),
    queryFn: async (): Promise<WorkLogEntry[]> => {
      const db = requireSupabase();
      const weekEnd = addDays(weekStart, 6);

      const [entriesRes, runRes] = await Promise.all([
        db
          .from('work_log_entries')
          .select('*')
          .eq('guard_id', guardId)
          .gte('target_date', weekStart)
          .lte('target_date', weekEnd),
        db
          .from('schedule_runs')
          .select('id')
          .eq('week_start', weekStart)
          .eq('is_published', true)
          .maybeSingle(),
      ]);
      if (entriesRes.error) throw new Error(entriesRes.error.message);
      if (runRes.error) throw new Error(runRes.error.message);

      const entries = (entriesRes.data as WorkLogEntry[]) ?? [];
      const runId = (runRes.data as { id: string } | null)?.id;
      if (!runId) return entries.sort((a, b) => a.target_date.localeCompare(b.target_date));

      const assignRes = await db
        .from('schedule_assignments')
        .select('*')
        .eq('run_id', runId)
        .eq('guard_id', guardId);
      if (assignRes.error) throw new Error(assignRes.error.message);

      const seededIds = new Set(entries.map((e) => e.source_assignment_id).filter(Boolean));
      const missing = ((assignRes.data as ScheduleAssignment[]) ?? []).filter(
        (a) => !seededIds.has(a.id),
      );
      if (missing.length === 0) {
        return entries.sort((a, b) => a.target_date.localeCompare(b.target_date));
      }

      const seedRows = missing.map((a) => {
        const window = nominalWindow(a.target_date, a.shift);
        return {
          guard_id: guardId,
          target_date: a.target_date,
          shift: a.shift,
          source: 'roster' as const,
          source_assignment_id: a.id,
          scheduled_start: window.scheduled_start,
          scheduled_end: window.scheduled_end,
          actual_start: window.scheduled_start,
          actual_end: window.scheduled_end,
        };
      });

      const { data: inserted, error: insertError } = await db
        .from('work_log_entries')
        .insert(seedRows)
        .select('*');
      // 23505: another tab/request already seeded one of these rows between
      // our read and this insert -- not a real failure, just re-fetch.
      if (insertError && insertError.code !== '23505') {
        throw new Error(insertError.message);
      }
      if (insertError) {
        const retry = await db
          .from('work_log_entries')
          .select('*')
          .eq('guard_id', guardId)
          .gte('target_date', weekStart)
          .lte('target_date', weekEnd);
        if (retry.error) throw new Error(retry.error.message);
        return ((retry.data as WorkLogEntry[]) ?? []).sort((a, b) =>
          a.target_date.localeCompare(b.target_date),
        );
      }

      return [...entries, ...((inserted as WorkLogEntry[]) ?? [])].sort((a, b) =>
        a.target_date.localeCompare(b.target_date),
      );
    },
  });
}

export interface UpsertWorkLogEntryInput {
  id?: string;
  target_date: DateKey;
  shift: ShiftType | null;
  actual_start: string;
  actual_end: string;
  note?: string | null;
  /** Present when editing a seeded row (keeps it 'roster' -> 'edited');
   *  omitted for a brand-new manual entry. */
  source_assignment_id?: string | null;
}

const WORK_LOG_QUERY_PREFIXES = new Set([
  'workLogWeek',
  'workLogMonth',
  'workLogAbsenceWeek',
  'workLogAbsenceMonth',
  'absencePayoutContext',
]);

/**
 * Matches every work-log-related query regardless of which guard, week, or
 * month -- broader than strictly necessary, but a single edit can affect
 * several views at once in ways that are easy to miss one of: editing a
 * SHIFT changes the entry lists (workLogWeek/workLogMonth) AND the
 * absence-payout average it feeds into (absencePayoutContext), since
 * leaveDayValue is computed from the guard's own work_log_entries over
 * the 3 months before that absence's month. A bug here (shift edits only
 * invalidating the entry lists, not absencePayoutContext) is exactly what
 * made the owner's vacation-day estimate look frozen after adding missing
 * shifts -- the cached average never refetched. One shared predicate for
 * every mutation below avoids that class of bug recurring for a new query
 * added later. These queries are cheap enough that over-invalidating costs
 * nothing worth optimizing for.
 */
const invalidateAllWorkLogViews = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({
    predicate: (query) => WORK_LOG_QUERY_PREFIXES.has(query.queryKey[0] as string),
  });

/**
 * Adds a manual entry or edits an existing one -- a single row, direct
 * upsert (not an RPC): unlike a whole week's preferences, one entry has no
 * cross-row atomicity to protect. Not bound to any one week -- usable from
 * both the weekly view and the monthly summary (WorkLog.tsx), which is
 * also why invalidation is broad rather than keyed to a specific week.
 */
export function useUpsertWorkLogEntry() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useMutation({
    mutationFn: async (input: UpsertWorkLogEntryInput) => {
      const db = requireSupabase();
      const row = {
        guard_id: guardId,
        target_date: input.target_date,
        shift: input.shift,
        source: (input.source_assignment_id ? 'edited' : 'manual') satisfies WorkLogSource,
        source_assignment_id: input.source_assignment_id ?? null,
        actual_start: input.actual_start,
        actual_end: input.actual_end,
        note: input.note ?? null,
      };
      const { error } = input.id
        ? await db.from('work_log_entries').update(row).eq('id', input.id)
        : await db.from('work_log_entries').insert(row);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidateAllWorkLogViews(qc),
  });
}

export function useDeleteWorkLogEntry() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await requireSupabase().from('work_log_entries').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidateAllWorkLogViews(qc),
  });
}

const myRateHistoryKey = ['myRateHistory'] as const;

/**
 * The CALLER's own full rate history -- every 'manager' row for a manager/
 * admin, every 'guard' row otherwise, oldest first. Goes through the
 * my_hourly_rate_history() RPC rather than a table read: a guard has no
 * read policy on payroll_rates at all, so the manager's own rate is never
 * exposed to anyone else. Feed this straight into src/lib/payroll.ts's
 * rateForDate()/computePayroll() -- resolving "the rate on date X" is a
 * client-side lookup, not a second round trip.
 */
export function useMyRateHistory() {
  return useQuery({
    queryKey: myRateHistoryKey,
    queryFn: async (): Promise<RateHistoryEntry[]> => {
      const { data, error } = await requireSupabase().rpc('my_hourly_rate_history');
      if (error) throw new Error(error.message);
      return (data as RateHistoryEntry[]) ?? [];
    },
  });
}

export interface PayrollRate {
  id: string;
  role: 'guard' | 'manager';
  hourly_rate: number;
  effective_from: DateKey;
}

const rateHistoryKey = ['payrollRateHistory'] as const;

/** Manager-only: BOTH roles' full history, for the Manager Settings editor.
 *  A guard querying this gets zero rows (no read policy) -- see
 *  useMyRateHistory for what a guard is meant to use instead. */
export function useRateHistory() {
  return useQuery({
    queryKey: rateHistoryKey,
    queryFn: async (): Promise<PayrollRate[]> => {
      const { data, error } = await requireSupabase()
        .from('payroll_rates')
        .select('id, role, hourly_rate, effective_from')
        .order('role')
        .order('effective_from');
      if (error) throw new Error(error.message);
      return (data as PayrollRate[]) ?? [];
    },
  });
}

/**
 * Records a new rate, effective from a given date -- never an update of an
 * existing row. That's what keeps a raise from recalculating a month that
 * already passed: the OLD row stays exactly as it was, governing every date
 * before the new one's effective_from.
 */
export function useAddRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      role: 'guard' | 'manager';
      hourlyRate: number;
      effectiveFrom: DateKey;
    }) => {
      const { error } = await requireSupabase().from('payroll_rates').insert({
        role: input.role,
        hourly_rate: input.hourlyRate,
        effective_from: input.effectiveFrom,
      });
      if (error) {
        if (error.code === '23505') throw new Error('כבר קיים שינוי שכר לתאריך הזה ולתפקיד הזה.');
        throw new Error(error.message);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rateHistoryKey });
      void qc.invalidateQueries({ queryKey: myRateHistoryKey });
    },
  });
}

/** Removes a mis-entered history row. History is append-only in intent --
 *  this is for fixing a mistake, not for "ending" a rate period (an old row
 *  simply stops being the latest once a newer one exists). */
export function useDeleteRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await requireSupabase().from('payroll_rates').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rateHistoryKey });
      void qc.invalidateQueries({ queryKey: myRateHistoryKey });
    },
  });
}

/** 'YYYY-MM' -> the first/last calendar DATE of that month (not the Sun-Sat
 *  roster week -- a week can straddle two months, so each day is allocated
 *  to a month by its own date). */
function monthRange(monthKey: string): { start: DateKey; end: DateKey } {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Rolls up whatever work-log entries already exist for a calendar month --
 * read-only, no seeding. A week the guard has never opened in the weekly
 * view (useWorkLogWeek) simply has nothing here yet; the one-time backfill
 * script (see the feature plan) is what makes the current month complete
 * without visiting every week first.
 */
export function useMonthlySalarySummary(monthKey: string) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';
  const { start, end } = monthRange(monthKey);

  return useQuery({
    queryKey: ['workLogMonth', guardId, monthKey],
    enabled: Boolean(guardId),
    queryFn: async (): Promise<WorkLogEntry[]> => {
      const { data, error } = await requireSupabase()
        .from('work_log_entries')
        .select('*')
        .eq('guard_id', guardId)
        .gte('target_date', start)
        .lte('target_date', end);
      if (error) throw new Error(error.message);
      return (data as WorkLogEntry[]) ?? [];
    },
  });
}

// ---------------------------------------------------------------------------
// Sick/vacation absences (migration 64) -- see src/lib/payroll.ts's own
// "Sick/vacation absences" section for the calculation itself. No
// balance/ledger: these hooks only ever read/write what the guard logged.
// ---------------------------------------------------------------------------

/** Generous margin for backtracking a consecutive sick-day streak -- real
 *  streaks are rarely more than a handful of days. */
const SICK_STREAK_LOOKBACK_DAYS = 10;

export function useAbsencesWeek(weekStart: DateKey) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';
  const weekEnd = addDays(weekStart, 6);

  return useQuery({
    queryKey: ['workLogAbsenceWeek', guardId, weekStart],
    enabled: Boolean(guardId && weekStart),
    queryFn: async (): Promise<WorkLogAbsence[]> => {
      const { data, error } = await requireSupabase()
        .from('work_log_absences')
        .select('*')
        .eq('guard_id', guardId)
        .gte('target_date', weekStart)
        .lte('target_date', weekEnd);
      if (error) throw new Error(error.message);
      return ((data as WorkLogAbsence[]) ?? []).sort((a, b) => a.target_date.localeCompare(b.target_date));
    },
  });
}

export function useMonthlyAbsences(monthKey: string) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';
  const { start, end } = monthRange(monthKey);

  return useQuery({
    queryKey: ['workLogAbsenceMonth', guardId, monthKey],
    enabled: Boolean(guardId),
    queryFn: async (): Promise<WorkLogAbsence[]> => {
      const { data, error } = await requireSupabase()
        .from('work_log_absences')
        .select('*')
        .eq('guard_id', guardId)
        .gte('target_date', start)
        .lte('target_date', end);
      if (error) throw new Error(error.message);
      return ((data as WorkLogAbsence[]) ?? []).sort((a, b) => a.target_date.localeCompare(b.target_date));
    },
  });
}

export interface UpsertAbsenceInput {
  id?: string;
  target_date: DateKey;
  type: AbsenceType;
  note?: string | null;
}

/** Adds or edits a single absence. A guard can log at most one absence per
 *  day (migration 64's UNIQUE constraint) -- surfaced here as a friendly
 *  message rather than a raw Postgres error. */
export function useUpsertAbsence() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useMutation({
    mutationFn: async (input: UpsertAbsenceInput) => {
      const db = requireSupabase();
      const row = {
        guard_id: guardId,
        target_date: input.target_date,
        type: input.type,
        note: input.note ?? null,
      };
      const { error } = input.id
        ? await db.from('work_log_absences').update(row).eq('id', input.id)
        : await db.from('work_log_absences').insert(row);
      if (error) {
        if (error.code === '23505') throw new Error('כבר קיים רישום היעדרות לתאריך הזה.');
        throw new Error(error.message);
      }
    },
    onSuccess: () => invalidateAllWorkLogViews(qc),
  });
}

export function useDeleteAbsence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await requireSupabase().from('work_log_absences').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidateAllWorkLogViews(qc),
  });
}

export interface AbsencePayout {
  absence: WorkLogAbsence;
  /** 1 for vacation; 0/0.5/1 for sick, by which day of a consecutive run
   *  this one is (Israeli Sick Pay Law). */
  percent: number;
  /** leaveDayValue(...) over the LEAVE_REFERENCE_MONTHS full calendar
   *  months before this absence's own month, times `percent`. 0 if there
   *  is no logged work history yet in that reference period. */
  value: number;
}

/**
 * Values a set of absences (one roster week's or one month's worth) against
 * the guard's own work history. Each absence is valued from the
 * LEAVE_REFERENCE_MONTHS full calendar months BEFORE its own month
 * (leaveReferencePeriod/leaveDayValue in payroll.ts) -- never the absence's
 * own month, however early in it the absence falls (see leaveDayValue's own
 * comment for why: it keeps a vacation taken in week 1 of a month from
 * being valued against that same month's own, still-thin data). One
 * combined fetch covers every absence passed in (spanning every reference
 * period touched by any of them) rather than one round trip per absence;
 * each absence's own period is then a client-side slice of that shared
 * fetch.
 */
export function useAbsencePayouts(
  absences: WorkLogAbsence[],
  rateHistory: RateHistoryEntry[],
): { payouts: AbsencePayout[]; total: number; isLoading: boolean } {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  const dates = absences.map((a) => a.target_date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const fetchStart = minDate ? leaveReferencePeriod(minDate).start : undefined;
  const fetchEnd = maxDate ? leaveReferencePeriod(maxDate).end : undefined;

  const query = useQuery({
    queryKey: ['absencePayoutContext', guardId, fetchStart, fetchEnd],
    enabled: Boolean(guardId && fetchStart && fetchEnd),
    queryFn: async (): Promise<{ entries: WorkLogEntry[]; sickDates: Set<DateKey> }> => {
      const db = requireSupabase();
      const sickFrom = addDays(minDate!, -SICK_STREAK_LOOKBACK_DAYS);

      const [entriesRes, sickRes] = await Promise.all([
        db
          .from('work_log_entries')
          .select('*')
          .eq('guard_id', guardId)
          .gte('target_date', fetchStart!)
          .lte('target_date', fetchEnd!),
        db
          .from('work_log_absences')
          .select('target_date')
          .eq('guard_id', guardId)
          .eq('type', 'sick')
          .gte('target_date', sickFrom)
          .lte('target_date', maxDate!),
      ]);
      if (entriesRes.error) throw new Error(entriesRes.error.message);
      if (sickRes.error) throw new Error(sickRes.error.message);

      return {
        entries: (entriesRes.data as WorkLogEntry[]) ?? [],
        sickDates: new Set(
          ((sickRes.data as { target_date: DateKey }[]) ?? []).map((r) => r.target_date),
        ),
      };
    },
  });

  const payouts = useMemo((): AbsencePayout[] => {
    if (!query.data) return [];
    const { entries, sickDates } = query.data;
    return absences.map((absence) => {
      const { start, end } = leaveReferencePeriod(absence.target_date);
      const relevant = entries.filter((e) => e.target_date >= start && e.target_date <= end);
      const dayValue = leaveDayValue(relevant, rateHistory);
      const percent =
        absence.type === 'vacation'
          ? 1
          : sickPayPercent(consecutiveSickDayCount(sickDates, absence.target_date));
      return { absence, percent, value: dayValue * percent };
    });
  }, [query.data, absences, rateHistory]);

  return {
    payouts,
    total: payouts.reduce((sum, p) => sum + p.value, 0),
    isLoading: query.isLoading,
  };
}
