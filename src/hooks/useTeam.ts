import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/lib/edgeFunctions';
import { managerKeys } from '@/hooks/useManager';

/**
 * Team CRUD -- add an employee, delete one (claimed or still pending), and
 * edit the default כמות each seeds a new week with.
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
  /** E.164, required for a new employee (§ TeamManagement) -- feeds the
   *  WhatsApp OTP forgot-PIN flow once they claim their code. */
  phoneNumber: string;
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
        phone_number: input.phoneNumber,
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

/**
 * Deletes an employee -- claimed or still a pending invitation -- for good.
 *
 * Goes through the delete_employee RPC (migration 21) rather than a plain
 * table write: it has to remove the `auth.users` row too, which is not
 * exposed through PostgREST at all, so there is no RLS-gated table write that
 * could do this. That single statement cascades to `profiles` and everything
 * that references `guard_id` -- schedule_assignments, weekly_wish_preferences,
 * weekly_submissions, weekly_guard_targets -- so this genuinely erases the
 * person's history out of every past roster, including a published one. The
 * function also refuses to let a manager delete their own account.
 *
 * Same RPC either way: an unclaimed invitation has no matching profile, so
 * the function just removes the roster_codes row and skips the rest.
 */
export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (employeeCode: string) => {
      const { error } = await requireSupabase().rpc('delete_employee', {
        p_employee_code: employeeCode,
      });
      if (error) {
        if (/cannot delete your own account/.test(error.message)) {
          throw new Error('לא ניתן למחוק את חשבון המנהל שלך.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/**
 * Resets a guard's forgotten PIN to a new one the manager hands them --
 * WITHOUT touching profiles, roster_codes, or anything hanging off guard_id
 * (schedule_assignments, weekly_submissions, etc.), unlike useDeleteEmployee.
 * There is no self-service "forgot PIN" flow (the PIN IS the guard's GoTrue
 * password), so this is the only way back in for someone who genuinely
 * forgot theirs. Goes through the reset-pin Edge Function, not a table write
 * -- resetting a GoTrue password needs the service-role admin API, which is
 * never exposed through PostgREST.
 */
export function useResetGuardPin() {
  return useMutation({
    mutationFn: (input: { guardId: string; newPin: string }) =>
      invokeEdgeFunction<{ ok: true; displayName: string }>('reset-pin', {
        guard_id: input.guardId,
        new_pin: input.newPin,
      }),
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

/**
 * Sets/edits an existing employee's phone number -- optional, unlike
 * AddEmployeeCard's required field, so an existing guard with none on file
 * simply keeps using the manager-only reset-pin fallback until one is set.
 * Same dual-table write as useUpdateDefaultKamut: profiles once claimed
 * (trg_profiles_phone_number has already copied it there and it's the live,
 * editable value from then on), roster_codes before.
 */
export function useUpdateEmployeePhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeCode: string;
      profileId: string | null;
      phoneNumber: string | null;
    }) => {
      const db = requireSupabase();
      const { error } = input.profileId
        ? await db
            .from('profiles')
            .update({ phone_number: input.phoneNumber })
            .eq('id', input.profileId)
        : await db
            .from('roster_codes')
            .update({ phone_number: input.phoneNumber })
            .eq('employee_code', input.employeeCode);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}
