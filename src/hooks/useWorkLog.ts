import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { AbsenceType, ScheduleAssignment, WorkLogAbsence, WorkLogEntry, WorkLogSource } from '@/types/database';
import { addDays, israelDateTime, weekStartOf, type DateKey } from '@/lib/dates';
import { SHIFTS, type ShiftType } from '@/lib/shifts';
import {
  consecutiveSickDayCount,
  leaveDayValue,
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
 * Ensures every one of this guard's PUBLISHED roster assignments for one
 * week has a matching work_log_entries row, inserting whichever are
 * missing. Self-contained -- fetches that week's own existing entries
 * itself rather than trusting a caller to have already fetched exactly the
 * right range, so it behaves identically whether called for a single week
 * (useWorkLogWeek) or for every week touching a wider range
 * (useMonthlySalarySummary, which needs this seeding to run for EVERY week
 * overlapping the viewed month, not just one the guard happened to open in
 * the weekly view).
 *
 * Seeding is plain INSERT, not upsert: work_log_one_per_assignment is a
 * PARTIAL unique index (WHERE source_assignment_id IS NOT NULL), which
 * Postgres can only use as an ON CONFLICT arbiter if the statement restates
 * that same predicate -- supabase-js's upsert() cannot express that. Instead
 * we already have the guard's existing entries in hand, so we only insert
 * the assignments that are genuinely missing one, and swallow a 23505 (two
 * tabs/weeks racing to seed the same row) as "someone else already did
 * this" -- the caller re-fetches whatever range it actually needs
 * afterward regardless, so a dropped insert here is never lost silently.
 *
 * A guard's 'edited'/'manual' rows are never touched here -- only assignments
 * with no matching entry get a new 'roster' row. See the feature plan for
 * why a re-published week's orphaned entries are left in place rather than
 * deleted.
 */
async function seedWeekFromRoster(
  db: ReturnType<typeof requireSupabase>,
  guardId: string,
  weekStart: DateKey,
): Promise<void> {
  const weekEnd = addDays(weekStart, 6);
  const [entriesRes, runRes] = await Promise.all([
    db
      .from('work_log_entries')
      .select('source_assignment_id')
      .eq('guard_id', guardId)
      .gte('target_date', weekStart)
      .lte('target_date', weekEnd),
    db.from('schedule_runs').select('id').eq('week_start', weekStart).eq('is_published', true).maybeSingle(),
  ]);
  if (entriesRes.error) throw new Error(entriesRes.error.message);
  if (runRes.error) throw new Error(runRes.error.message);

  const runId = (runRes.data as { id: string } | null)?.id;
  if (!runId) return;

  const assignRes = await db
    .from('schedule_assignments')
    .select('*')
    .eq('run_id', runId)
    .eq('guard_id', guardId);
  if (assignRes.error) throw new Error(assignRes.error.message);

  const seededIds = new Set(
    ((entriesRes.data as { source_assignment_id: string | null }[]) ?? [])
      .map((e) => e.source_assignment_id)
      .filter(Boolean),
  );
  const missing = ((assignRes.data as ScheduleAssignment[]) ?? []).filter((a) => !seededIds.has(a.id));
  if (missing.length === 0) return;

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

  const { error: insertError } = await db.from('work_log_entries').insert(seedRows);
  if (insertError && insertError.code !== '23505') throw new Error(insertError.message);
}

/** This guard's own work-log entries for one roster week, lazily seeded
 *  from their published roster assignments for that week (seedWeekFromRoster). */
export function useWorkLogWeek(weekStart: DateKey) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useQuery({
    queryKey: workLogKeys.week(guardId, weekStart),
    enabled: Boolean(guardId && weekStart),
    queryFn: async (): Promise<WorkLogEntry[]> => {
      const db = requireSupabase();
      await seedWeekFromRoster(db, guardId, weekStart);

      const weekEnd = addDays(weekStart, 6);
      const { data, error } = await db
        .from('work_log_entries')
        .select('*')
        .eq('guard_id', guardId)
        .gte('target_date', weekStart)
        .lte('target_date', weekEnd);
      if (error) throw new Error(error.message);
      return ((data as WorkLogEntry[]) ?? []).sort((a, b) => a.target_date.localeCompare(b.target_date));
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
 * several views at once in ways that are easy to miss one of: editing or
 * deleting an ABSENCE changes the entry lists it's shown alongside
 * (workLogAbsenceWeek/Month) AND, for a sick day, every OTHER nearby
 * absence's consecutive-day streak (absencePayoutContext) -- adding or
 * removing a sick day can shift which tier (0/50/100%) a neighboring sick
 * day falls into. leaveDayValue itself no longer reads work_log_entries
 * at all (it's a standard day's hours at the current rate, not an average
 * over worked history -- see payroll.ts), so a plain SHIFT edit no longer
 * affects absencePayoutContext; it stays in this shared set anyway since
 * these queries are cheap enough that over-invalidating costs nothing
 * worth optimizing for, and it keeps one predicate covering every mutation
 * below instead of each one needing to reason about exactly which views
 * it can affect.
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
 * Rolls up this guard's work-log entries for a calendar month, seeding from
 * the published roster first -- every roster week that overlaps the month
 * gets the same seedWeekFromRoster() treatment useWorkLogWeek gives a
 * single week, not just whichever weeks the guard happened to separately
 * open in the weekly view. That used to be the only way a week's roster
 * shifts reached work_log_entries at all (this query was read-only), which
 * was fine while the weekly view was primary -- now that the monthly view
 * is primary (most guards may rarely open weekly at all), relying on that
 * would have meant newly published weeks silently never showing up here. A
 * week straddling two months is seeded in full regardless of which of its
 * two months is being viewed (seedWeekFromRoster works in whole-week
 * units); only the days actually within [start, end] are returned, same
 * day-by-own-date allocation monthRange already documents.
 */
export function useMonthlySalarySummary(monthKey: string) {
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';
  const { start, end } = monthRange(monthKey);

  return useQuery({
    queryKey: ['workLogMonth', guardId, monthKey],
    enabled: Boolean(guardId),
    queryFn: async (): Promise<WorkLogEntry[]> => {
      const db = requireSupabase();

      const weeks: DateKey[] = [];
      for (let w = weekStartOf(start); w <= end; w = addDays(w, 7)) weeks.push(w);
      await Promise.all(weeks.map((w) => seedWeekFromRoster(db, guardId, w)));

      const { data, error } = await db
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
  /** leaveDayValue(...) at the rate in effect on this absence's own date,
   *  times `percent`. 0 if there is no rate recorded yet for that date. */
  value: number;
}

/**
 * Values a set of absences (one roster week's or one month's worth)
 * against the guard's rate history -- a standard day (STANDARD_DAY_HOURS
 * in payroll.ts) at whatever rate applies on each absence's own date, per
 * leaveDayValue. Deliberately independent of actual logged work hours
 * (see leaveDayValue's own comment for why -- this is NOT an average over
 * worked history). The only remaining DB dependency is each absence's own
 * sick/vacation streak, via work_log_absences -- never work_log_entries.
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

  const query = useQuery({
    queryKey: ['absencePayoutContext', guardId, minDate, maxDate],
    enabled: Boolean(guardId && minDate && maxDate),
    queryFn: async (): Promise<{ sickDates: Set<DateKey> }> => {
      const db = requireSupabase();
      const sickFrom = addDays(minDate!, -SICK_STREAK_LOOKBACK_DAYS);

      const sickRes = await db
        .from('work_log_absences')
        .select('target_date')
        .eq('guard_id', guardId)
        .eq('type', 'sick')
        .gte('target_date', sickFrom)
        .lte('target_date', maxDate!);
      if (sickRes.error) throw new Error(sickRes.error.message);

      return {
        sickDates: new Set(
          ((sickRes.data as { target_date: DateKey }[]) ?? []).map((r) => r.target_date),
        ),
      };
    },
  });

  const payouts = useMemo((): AbsencePayout[] => {
    if (!query.data) return [];
    const { sickDates } = query.data;
    return absences.map((absence) => {
      const dayValue = leaveDayValue(rateHistory, absence.target_date);
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
