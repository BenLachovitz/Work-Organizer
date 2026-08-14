import { useCallback, useEffect, useState } from 'react';
import { getHasPasskey, setHasPasskey, supabase } from '@/lib/supabase';
import type { PasskeyListItem } from '@supabase/supabase-js';

/** Feature-detection only -- not exported by supabase-js's public API, so
 *  checked directly against the standard WebAuthn browser API instead of
 *  relying on an internal helper. Shared by usePasskey (Preferences, needs a
 *  session) and usePasskeySupport (Login, does not). */
export async function checkPasskeySupport(): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    typeof window.PublicKeyCredential === 'undefined' ||
    !window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  ) {
    return false;
  }
  return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

/** Whether this device can prompt for Face ID/fingerprint at all -- no
 *  session required, safe to use from the (signed-out) Login screen. */
export function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void checkPasskeySupport().then((available) => {
      if (!cancelled) setSupported(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return supported;
}

/** Wraps Supabase's native passkey API for the Preferences management UI.
 *  Follows the same pattern as useNotifications: re-reads state after every
 *  action rather than assuming it succeeded. */
export function usePasskey() {
  const [supported, setSupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkPasskeySupport().then((available) => {
      if (cancelled) return;
      setSupported(available);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!supabase) return;
    const { data, error: listError } = await supabase.auth.passkey.list();
    if (listError) {
      setError(listError.message);
      return;
    }
    setPasskeys(data ?? []);
    setHasPasskey((data ?? []).length > 0);
  }, []);

  useEffect(() => {
    if (supported) void refresh();
  }, [supported, refresh]);

  const register = useCallback(
    async (friendlyName?: string) => {
      if (!supabase) return;
      setBusy(true);
      setError(null);
      try {
        const { error: registerError } = await supabase.auth.registerPasskey();
        if (registerError) throw new Error(registerError.message);
        if (friendlyName) {
          const latest = await supabase.auth.passkey.list();
          const newest = latest.data?.[0];
          if (newest) await supabase.auth.passkey.update({ passkeyId: newest.id, friendlyName });
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'הרשמת האימות הביומטרי נכשלה');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (passkeyId: string) => {
      if (!supabase) return;
      setBusy(true);
      setError(null);
      try {
        const { error: deleteError } = await supabase.auth.passkey.delete({ passkeyId });
        if (deleteError) throw new Error(deleteError.message);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'מחיקת האימות הביומטרי נכשלה');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const rename = useCallback(async (passkeyId: string, friendlyName: string) => {
    if (!supabase) return;
    setError(null);
    const { error: updateError } = await supabase.auth.passkey.update({ passkeyId, friendlyName });
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await refresh();
  }, [refresh]);

  return {
    supported,
    loading,
    passkeys,
    hasPasskey: getHasPasskey(),
    busy,
    error,
    register,
    remove,
    rename,
  };
}
