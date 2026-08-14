import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const REMEMBER_ME_KEY = 'wo.rememberMe';
const PASSKEY_GUARD_ID_KEY = 'wo.webauthnGuardId';
const SESSION_KEY = 'sb-work-orgenizer-auth-token';

/**
 * Defaults to `true` so nobody's current behaviour (always-persisted login)
 * changes unless they actively opt out in Preferences.
 */
export function getRememberMe(): boolean {
  return localStorage.getItem(REMEMBER_ME_KEY) !== '0';
}

/**
 * Flips the flag and moves any already-stored session between localStorage
 * and sessionStorage immediately, so the change takes effect without forcing
 * a logout.
 */
export function setRememberMe(remember: boolean): void {
  const fromStore = remember ? sessionStorage : localStorage;
  const toStore = remember ? localStorage : sessionStorage;
  const existing = fromStore.getItem(SESSION_KEY);
  if (existing) {
    toStore.setItem(SESSION_KEY, existing);
    fromStore.removeItem(SESSION_KEY);
  }
  localStorage.setItem(REMEMBER_ME_KEY, remember ? '1' : '0');
}

/**
 * The guard whose app-scoped WebAuthn credential lives on THIS device, or
 * null. Set right after a successful registration; cleared when the guard's
 * last passkey is removed, or when a different guard signs in on the same
 * (shared) device. Drives the app-restart lock gate -- see AuthContext's
 * bootstrap effect -- and is sent as a plain hint to the webauthn Edge
 * Function so it knows which credential to challenge (the credential is
 * non-discoverable/non-resident, so unlike a true synced passkey, the
 * browser cannot show a blind "pick your passkey" picker). Not a trust
 * boundary: the real authorization is the cryptographic signature verified
 * server-side against that specific guard's stored public key.
 */
export function getPasskeyGuardId(): string | null {
  return localStorage.getItem(PASSKEY_GUARD_ID_KEY);
}

export function setPasskeyGuardId(guardId: string | null): void {
  if (guardId) localStorage.setItem(PASSKEY_GUARD_ID_KEY, guardId);
  else localStorage.removeItem(PASSKEY_GUARD_ID_KEY);
}

/**
 * Delegates to localStorage (survives closing the PWA) or sessionStorage
 * (cleared when it's closed) depending on the remember-me flag *at the time
 * of each call* -- so toggling it takes effect on the next write without
 * needing to recreate the Supabase client.
 */
const switchableStorage = {
  getItem: (key: string) => (getRememberMe() ? localStorage : sessionStorage).getItem(key),
  setItem: (key: string, value: string) =>
    (getRememberMe() ? localStorage : sessionStorage).setItem(key, value),
  removeItem: (key: string) => (getRememberMe() ? localStorage : sessionStorage).removeItem(key),
};

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
        storageKey: SESSION_KEY,
        storage: switchableStorage,
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
