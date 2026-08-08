import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { managerKeys } from '@/hooks/useManager';

/**
 * Team CRUD -- add an employee, deactivate/reactivate one, cancel a pending
 * invitation, and edit the default כמות each seeds a new week with.
 *
 * All four are plain RLS-gated table writes (migration 20 gave `roster_codes`
 * a manager write policy; `profiles` already had one). Nothing here needs an
 * RPC: none of these are multi-step or need to run as anyone other than the
 * caller, so there is no reason to hide them behind a function the way
 * save_week_preferences hides an atomic delete-then-insert.
 *
 * `claim-code`, the one publicly-reachable unauthenticated write path in the
 * system, is untouched by any of this -- registration is still the guard's
 * own action, using the code a manager creates here.
 */

const invalidateCodes = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: managerKeys.codes });

export interface AddEmployeeInput {
  employeeCode: string;
  displayName: string;
  defaultKamut: number;
}

/**
 * Registers a new badge code -- exactly what seed.sql did by hand for the
 * first eight. The employee still sets their own PIN through the normal
 * "קוד עובד" login flow; this only creates the invitation.
 */
export function useAddEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddEmployeeInput) => {
      const { error } = await requireSupabase().from('roster_codes').insert({
        employee_code: input.employeeCode,
        display_name: input.displayName,
        initial_role: 'guard',
        default_kamut: input.defaultKamut,
      });
      if (error) {
        if (error.code === '23505') throw new Error('קוד עובד זה כבר קיים במערכת.');
        if (error.code === '23514') throw new Error('קוד עובד חייב להיות בדיוק 6 ספרות.');
        throw new Error(error.message);
      }
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/** Cancels an unclaimed invitation. Never called on a claimed code -- the
 *  caller is expected to only offer this while `is_claimed` is false, the
 *  same way RunVersions only offers "delete" on runs the manager selected. */
export function useCancelInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (employeeCode: string) => {
      const { error } = await requireSupabase()
        .from('roster_codes')
        .delete()
        .eq('employee_code', employeeCode);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/**
 * Deactivates or reactivates a guard who has already claimed their code.
 *
 * Deliberately not a delete: schedule_assignments, weekly_wish_preferences
 * and weekly_submissions all cascade from guard_id, so removing the row would
 * erase that person's history out of every past -- including published --
 * roster. `is_active = false` already fully excludes a guard from scheduling
 * (useManagerWeek filters on it) and is reversible if the manager changes
 * their mind or the person comes back.
 */
export function useSetEmployeeActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { profileId: string; isActive: boolean }) => {
      const { error } = await requireSupabase()
        .from('profiles')
        .update({ is_active: input.isActive })
        .eq('id', input.profileId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/**
 * Updates the baseline weekly כמות -- NOT the per-week target the Stepper on
 * TeamTable already edits (weekly_guard_targets.configured_kamut). This is
 * the steady state a new week is seeded from (migration 19/20); the per-week
 * value it produces can still be overridden afterwards exactly as before.
 *
 * Writes to whichever table currently holds the truth for this row: profiles
 * once claimed (the trigger has already copied the baseline there and every
 * week from now on reads it from there), roster_codes before -- the caller
 * passes `profileId: null` to mean "still pending".
 */
export function useUpdateDefaultKamut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeCode: string;
      profileId: string | null;
      value: number;
    }) => {
      const db = requireSupabase();
      const { error } = input.profileId
        ? await db.from('profiles').update({ default_kamut: input.value }).eq('id', input.profileId)
        : await db
            .from('roster_codes')
            .update({ default_kamut: input.value })
            .eq('employee_code', input.employeeCode);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}
