import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requireSupabase } from '@/lib/supabase';
import { managerKeys } from '@/hooks/useManager';

/**
 * Calls the reset-pin Edge Function and surfaces ITS error message -- same
 * reasoning as webauthn.ts's invokeWebauthn / AuthContext's invokeClaimCode:
 * supabase-js reports any non-2xx as a generic "Edge Function returned a
 * non-2xx status code" and leaves `data` null, which would hide every useful
 * Hebrew message the function actually produces. The real body hangs off
 * error.context.
 */
async function invokeResetPin(body: {
  guard_id: string;
  new_pin: string;
}): Promise<{ ok: true; displayName: string }> {
  const { data, error } = await requireSupabase().functions.invoke<{
    ok: true;
    displayName: string;
  }>('reset-pin', { body });
  if (!error) return data!;

  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = (await ctx.json()) as { error?: string };
      if (parsed?.error) throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e;
    }
  }
  throw new Error('שגיאת תקשורת. נסה שוב.');
}

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
  /** E.164, already normalized -- optional, unlike every other field here. */
  phoneNumber?: string | null;
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
        phone_number: input.phoneNumber ?? null,
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
      invokeResetPin({ guard_id: input.guardId, new_pin: input.newPin }),
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
 * Sets or clears a guard's phone number -- same dual-table shape as
 * useUpdateDefaultKamut(): profiles once claimed, roster_codes before. The
 * caller passes an already-normalized E.164 string (see src/lib/phone.ts),
 * or null to clear a number back out.
 */
export function useUpdateEmployeePhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeCode: string;
      profileId: string | null;
      value: string | null;
    }) => {
      const db = requireSupabase();
      const { error } = input.profileId
        ? await db.from('profiles').update({ phone_number: input.value }).eq('id', input.profileId)
        : await db
            .from('roster_codes')
            .update({ phone_number: input.value })
            .eq('employee_code', input.employeeCode);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/**
 * Promotes a guard to manager, or demotes a manager back to guard -- via the
 * set_employee_role RPC (migration 71), not a plain table write, because the
 * RPC is what enforces "never zero managers" and "a protected account's role
 * never changes." Self-promotion/demotion is allowed (TeamManagement.tsx
 * does not gate this by `!isSelf`) -- if it affects the calling manager's own
 * row, the caller is responsible for also calling AuthContext's
 * refreshProfile() so the cached isManager flag doesn't lag the actual role.
 */
export function useSetEmployeeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { profileId: string; role: 'guard' | 'manager' }) => {
      const { error } = await requireSupabase().rpc('set_employee_role', {
        p_profile_id: input.profileId,
        p_role: input.role,
      });
      if (error) {
        if (/cannot demote the last remaining manager/.test(error.message)) {
          throw new Error('לא ניתן להחזיר למעמד עובד את המנהל האחרון שנותר במערכת.');
        }
        if (/role is protected/.test(error.message)) {
          throw new Error('לא ניתן לשנות את התפקיד של חשבון מוגן זה.');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}

/**
 * Toggles the silenced ("support mode only") flag -- a direct write to
 * profiles.is_silenced, same immediate, no-confirm shape as
 * useUpdateDefaultKamut(). Unlike that hook there is no roster_codes branch:
 * this control only ever shows for an already-claimed row in TeamManagement
 * (profileId is never null there), since silencing a not-yet-claimed
 * invitation is meaningless (migration 72).
 */
export function useSetGuardSilenced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { profileId: string; value: boolean }) => {
      const { error } = await requireSupabase()
        .from('profiles')
        .update({ is_silenced: input.value })
        .eq('id', input.profileId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => void invalidateCodes(qc),
  });
}
