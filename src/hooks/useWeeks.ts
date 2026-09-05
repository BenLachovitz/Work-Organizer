import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import type { RosterWeek } from '@/types/database';
import {
  addDays,
  currentSubmissionWeek,
  todayInIsrael,
  weekStartOf,
  type DateKey,
} from '@/lib/dates';

export const weekKeys = {
  all: ['roster_weeks'] as const,
};

/**
 * All schedulable weeks. The database is the authority on which weeks exist --
 * the client-side date maths in dates.ts is only a fallback for when no week
 * has been created yet.
 *
 * ensure_roster_weeks() runs first. It is idempotent and creates the current
 * week plus however many forward weeks are needed for one to be open for
 * submissions, so weeks roll over on their own rather than needing a cron job
 * or a manager remembering to add one.
 */
export function useRosterWeeks() {
  return useQuery({
    queryKey: weekKeys.all,
    queryFn: async (): Promise<RosterWeek[]> => {
      const db = requireSupabase();

      // A failure here must not blank the dashboard: the weeks that already
      // exist are still perfectly usable.
      const { error: ensureErr } = await db.rpc('ensure_roster_weeks');
      if (ensureErr) console.warn('ensure_roster_weeks failed:', ensureErr.message);

      const { data, error } = await db
        .from('roster_weeks')
        .select('*')
        .order('week_start', { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

/**
 * The manager-facing admin cursor -- distinct from the guard-facing
 * "rolls over on real Sunday midnight" cycle (GuardHome.tsx, RosterView.tsx).
 * This one advances at each week's own configured submission open-time
 * (admin_current_week_start(), migration 26), so the manager's archive/
 * current/next picker can move a week ahead of the calendar once that
 * week's window has opened. Guard visibility is untouched by this and stays
 * calendar-pinned in the database (current_week_start() / guard_visible_from()).
 */
function useAdminCurrentWeekStart() {
  return useQuery({
    queryKey: ['adminCurrentWeekStart'],
    queryFn: async (): Promise<DateKey> => {
      const { data, error } = await requireSupabase().rpc('admin_current_week_start');
      if (error) throw new Error(error.message);
      return data as DateKey;
    },
  });
}

/**
 * Live weeks versus the archive.
 *
 * Live = the admin-current week and anything after it: the roster in
 * progress plus whatever is open for submissions. Archive = finished weeks,
 * which RLS makes manager-only, so a guard calling this simply gets an empty
 * archive.
 */
export function useSplitWeeks() {
  const query = useRosterWeeks();
  const { data: adminCurrentStart } = useAdminCurrentWeekStart();
  // Falls back to the plain calendar week only until the admin cursor has
  // loaded, so the picker has something coherent to show immediately rather
  // than flashing empty.
  const currentStart = adminCurrentStart ?? weekStartOf(todayInIsrael());
  const nextStart = addDays(currentStart, 7);
  const weeks = query.data ?? [];

  // Exactly two: the week being worked, and the week being filled in. Under the
  // Saturday-20:00 window these are the only two that can be in play, apart
  // from a few hours each Saturday evening while the next one opens.
  const live = weeks.filter((w) => w.week_start === currentStart || w.week_start === nextStart);

  return {
    ...query,
    live,
    // Everything else -- finished weeks and any stray future one. Guards cannot
    // see past weeks at all; RLS enforces that, not this filter.
    archive: weeks
      .filter((w) => w.week_start !== currentStart && w.week_start !== nextStart)
      .sort((a, b) => b.week_start.localeCompare(a.week_start)),
    currentStart,
    nextStart,
  };
}

/**
 * Shared week-selection state for the manager sub-pages that operate on
 * "whichever week is picked" (Summary, Roster generation, Preferences):
 * bootstraps from a `?week=` query param if the link that brought the
 * manager here carried one (e.g. from ManagerDashboard's nav row, so the
 * week they were already looking at follows them), else defaults to next
 * week, falling back to whatever is live. Combines live+archive into one
 * list since nothing about picking a week to inspect or (re)generate is
 * actually restricted to live weeks -- ManagerDashboard's own week picker
 * never was either.
 */
export function useManagerWeekSelection() {
  const [searchParams] = useSearchParams();
  const { live, archive, nextStart, isLoading } = useSplitWeeks();
  const weeks = [...live, ...archive];

  const [selected, setSelected] = useState(searchParams.get('week') ?? '');
  useEffect(() => {
    if (selected || !live.length) return;
    const fromQuery = searchParams.get('week');
    const next = live.find((w) => w.week_start === nextStart);
    setSelected(fromQuery || next?.week_start || live[0]!.week_start);
    // Only ever bootstraps the initial selection -- searchParams is
    // intentionally excluded so switching weeks via the dropdown doesn't
    // get overridden by a stale query string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, selected, nextStart]);

  return { weeks, live, archive, selected, setSelected, nextStart, isLoading };
}

export interface ActiveWeek {
  weekStart: DateKey;
  week: RosterWeek | null;
  /** True when guards may still edit. Mirrors is_week_open() in the database. */
  isOpen: boolean;
  deadline: Date | null;
}

/**
 * The week guards should be filling in right now: the earliest week that is
 * still accepting submissions. Falls back to the computed week so the UI has
 * something coherent to show before the manager has created any.
 */
export function useActiveWeek(): { data: ActiveWeek; isLoading: boolean } {
  const { data: weeks, isLoading } = useRosterWeeks();

  const now = Date.now();
  const open = (weeks ?? [])
    .filter((w) => w.status === 'open' && new Date(w.submission_deadline).getTime() > now)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));

  const chosen = open[0] ?? null;

  return {
    isLoading,
    data: chosen
      ? {
          weekStart: chosen.week_start,
          week: chosen,
          isOpen: true,
          deadline: new Date(chosen.submission_deadline),
        }
      : {
          weekStart: currentSubmissionWeek(),
          week: null,
          isOpen: false,
          deadline: null,
        },
  };
}
