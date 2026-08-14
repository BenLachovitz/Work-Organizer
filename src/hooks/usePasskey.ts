import { useCallback, useEffect, useState } from 'react';
import { hasRegisteredPasskey, registerPasskeyDevice, webauthnSupported } from '@/lib/webauthn';
import { getPasskeyGuardId, markPasskeyUnlocked, setPasskeyGuardId } from '@/lib/supabase';

/** Whether this device can prompt for Face ID/fingerprint/Windows Hello at
 *  all -- no session required, safe to use from the (signed-out) Login
 *  screen. */
export function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void webauthnSupported().then((available) => {
      if (!cancelled) setSupported(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return supported;
}

/**
 * Wraps the app-scoped WebAuthn flow for the GuardHome setup nudge. There is
 * deliberately no remove/rename here -- a passkey is set-and-forget by
 * design, not something guards are expected to manage day to day. On mount,
 * re-checks the real server-side row count rather than trusting the local
 * wo.webauthnGuardId flag blindly, so it stays truthful even if a credential
 * was removed directly (e.g. by Ben, via the SQL editor).
 */
export function usePasskey(guardId: string | undefined) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void webauthnSupported().then((available) => {
      if (!cancelled) setSupported(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const has = await hasRegisteredPasskey();
      setPasskeyGuardId(has && guardId ? guardId : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בטעינת אמצעי האימות');
    }
  }, [guardId]);

  useEffect(() => {
    if (supported) void refresh();
  }, [supported, refresh]);

  const register = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await registerPasskeyDevice();
      markPasskeyUnlocked();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'הרשמת האימות הביומטרי נכשלה');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return {
    supported,
    hasPasskey: getPasskeyGuardId() !== null,
    busy,
    error,
    register,
  };
}
