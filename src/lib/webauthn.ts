import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { requireSupabase } from '@/lib/supabase';

/**
 * Calls the webauthn Edge Function and surfaces ITS error message -- same
 * reasoning as AuthContext's invokeClaimCode: supabase-js reports any
 * non-2xx as a generic "Edge Function returned a non-2xx status code" and
 * leaves `data` null, which would hide every useful Hebrew message the
 * function produces. The real body hangs off error.context.
 */
async function invokeWebauthn<T>(body: Record<string, unknown>): Promise<T> {
  const supabase = requireSupabase();
  const { data, error } = await supabase.functions.invoke<T>('webauthn', { body });
  if (!error) return data as T;

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

/** Whether this device can prompt for Face ID/fingerprint/Windows Hello at
 *  all -- no session required, safe to call from the signed-out Login
 *  screen. */
export async function webauthnSupported(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false;
  return platformAuthenticatorIsAvailable();
}

/** Registers an app-scoped (residentKey: 'discouraged') WebAuthn credential
 *  for the CALLER's own account -- requires an active session, verified
 *  server-side from the caller's own JWT, never a client-supplied id. */
export async function registerPasskeyDevice(): Promise<void> {
  const { options } = await invokeWebauthn<{ options: PublicKeyCredentialCreationOptionsJSON }>({
    action: 'register-options',
  });
  const credential = await startRegistration({ optionsJSON: options });
  await invokeWebauthn({ action: 'register-verify', credential });
}

/**
 * Runs the sign-in ceremony for a specific guard on this device (the guard_id
 * comes from the local wo.webauthnGuardId hint -- not a discoverable/
 * blind-picker flow, since the credential is non-resident). Returns raw
 * session tokens for the caller to install with supabase.auth.setSession().
 */
export async function signInWithPasskeyDevice(
  guardId: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const { options } = await invokeWebauthn<{ options: PublicKeyCredentialRequestOptionsJSON }>({
    action: 'auth-options',
    guard_id: guardId,
  });
  const credential = await startAuthentication({ optionsJSON: options });
  return invokeWebauthn<{ access_token: string; refresh_token: string }>({
    action: 'auth-verify',
    guard_id: guardId,
    credential,
  });
}

/**
 * Whether the CALLER already has a registered passkey -- a plain
 * RLS-permitted read, no Edge Function round trip needed. A passkey is
 * set-and-forget by design (no remove/rename in this app), so all any
 * caller ever needs is this existence check, not the actual rows.
 */
export async function hasRegisteredPasskey(): Promise<boolean> {
  const supabase = requireSupabase();
  const { count, error } = await supabase
    .from('webauthn_credentials')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}
