import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;

/**
 * Supabase replaced the legacy `anon` JWT with a `sb_publishable_...` key.
 * Both are browser-safe by design and occupy the same client slot, so we accept
 * either -- new projects issue the publishable key, older ones still have anon.
 */
const publishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * The shell must still render before the cloud project exists, so a missing
 * config is a first-class state rather than a crash on import. App.tsx shows a
 * setup screen when this is false.
 */
export const isSupabaseConfigured = Boolean(url && publishableKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // no OAuth redirects: badge code + PIN only
      },
    })
  : null;

/** Narrowing helper for call sites that require a live client. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local',
    );
  }
  return supabase;
}

/**
 * Guards never type an email. GoTrue needs one, so the 6-digit badge code is
 * mapped to a synthetic address. The domain is intentionally non-routable --
 * no mail is ever sent to it.
 */
export function codeToEmail(employeeCode: string): string {
  return `${employeeCode}@guards.local`;
}

export const EMPLOYEE_CODE_LENGTH = 6;
export const PIN_MIN_LENGTH = 6;

export function isValidEmployeeCode(code: string): boolean {
  return new RegExp(`^[0-9]{${EMPLOYEE_CODE_LENGTH}}$`).test(code);
}
