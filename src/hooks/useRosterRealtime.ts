import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { managerKeys } from '@/hooks/useManager';
import type { DateKey } from '@/lib/dates';

/**
 * Pushes roster changes to the screen without a reload.
 *
 * The design rule here is: **treat the event as a signal, never as data.** We
 * do not apply the payload to the cache; we invalidate and refetch. The refetch
 * goes through RLS exactly as a normal read does, so a guard can never end up
 * displaying a row they were not entitled to — even if Realtime's own filtering
 * were wrong or a payload arrived partially formed. It also means a DELETE, for
 * which Postgres cannot evaluate RLS against the removed row, costs us nothing:
 * whatever the event says, the refetch tells the truth.
 *
 * Three tables are watched because a roster can change in three different ways:
 * an edit (schedule_assignments), publish/unpublish (schedule_runs), and a
 * published run being deleted — which shows up as a roster_weeks status change,
 * the only one of the three guaranteed to reach a guard.
 */
export function useRosterRealtime(weekStart: DateKey | null) {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const [lastChangeAt, setLastChangeAt] = useState<Date | null>(null);

  // Kept in a ref so the effect does not re-subscribe on every render.
  const invalidate = useRef(() => {});
  invalidate.current = () => {
    setLastChangeAt(new Date());
    // GuardHome and RosterView both read useVisibleRosters -- this is the key
    // that actually needed invalidating. Its absence here was the bug: a
    // publish fired the event, but nothing was subscribed to what it cleared,
    // so "הסידור שלי" kept showing stale data until a manual reload.
    void qc.invalidateQueries({ queryKey: ['visibleRosters'] });
    void qc.invalidateQueries({ queryKey: ['scheduleRuns'] });
    void qc.invalidateQueries({ queryKey: ['roster_weeks'] });
  };

  useEffect(() => {
    if (!supabase || !weekStart || !profile) return;

    const fire = () => invalidate.current();

    const channel = supabase
      .channel(`roster-${weekStart}`)
      // schedule_assignments has no week_start column, so it cannot be filtered
      // server-side. With a team this size the extra events are trivial, and
      // every one of them ends in the same cheap refetch.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_assignments' }, fire)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'schedule_runs', filter: `week_start=eq.${weekStart}` },
        fire,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'roster_weeks', filter: `week_start=eq.${weekStart}` },
        fire,
      )
      .subscribe();

    return () => {
      void supabase?.removeChannel(channel);
    };
  }, [weekStart, profile?.id]);

  return { lastChangeAt };
}

/**
 * Pushes a guard's submission to the manager's dashboard without a reload.
 *
 * Separate from useRosterRealtime because the tables are different and only
 * the manager cares: a guard submitting availability (or writing a note, §3.6)
 * previously updated nothing on screen until the manager next reloaded the
 * page -- the query itself was correct, it just never re-ran.
 *
 * Same signal-not-data rule as above: the event only triggers a refetch, which
 * goes through RLS exactly like a normal read.
 */
export function useManagerSubmissionsRealtime(weekStart: DateKey | null) {
  const qc = useQueryClient();

  const invalidate = useRef(() => {});
  invalidate.current = () => {
    if (weekStart) void qc.invalidateQueries({ queryKey: managerKeys.week(weekStart) });
  };

  useEffect(() => {
    if (!supabase || !weekStart) return;

    const fire = () => invalidate.current();

    const channel = supabase
      .channel(`submissions-${weekStart}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'weekly_submissions', filter: `week_start=eq.${weekStart}` },
        fire,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'weekly_wish_preferences',
          filter: `week_start=eq.${weekStart}`,
        },
        fire,
      )
      .subscribe();

    return () => {
      void supabase?.removeChannel(channel);
    };
  }, [weekStart]);
}
