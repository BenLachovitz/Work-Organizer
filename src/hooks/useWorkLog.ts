import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { ScheduleAssignment, WorkLogEntry, WorkLogSource } from '@/types/database';
import { addDays, israelDateTime, type DateKey } from '@/lib/dates';
import { SHIFTS, type ShiftType } from '@/lib/shifts';

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

/**
 * Adds a manual entry or edits an existing one -- a single row, direct
 * upsert (not an RPC): unlike a whole week's preferences, one entry has no
 * cross-row atomicity to protect.
 */
export function useUpsertWorkLogEntry(weekStart: DateKey) {
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: workLogKeys.week(guardId, weekStart) }),
  });
}

export function useDeleteWorkLogEntry(weekStart: DateKey) {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const guardId = profile?.id ?? '';

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await requireSupabase().from('work_log_entries').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: workLogKeys.week(guardId, weekStart) }),
  });
}

/** Read-only: the guard's own hourly rate, manager-set. NULL = not set yet. */
export function useGuardHourlyRate() {
  const { profile } = useAuth();
  return profile?.hourly_rate ?? null;
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
