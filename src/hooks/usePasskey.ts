import { useCallback, useEffect, useState } from 'react';
import {
  listPasskeys,
  registerPasskeyDevice,
  removePasskey,
  renamePasskey,
  webauthnSupported,
  type PasskeyRow,
} from '@/lib/webauthn';
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

/** Wraps the app-scoped WebAuthn flow for the Preferences management UI.
 *  Follows the same pattern as useNotifications: re-reads state after every
 *  action rather than assuming it succeeded. */
export function usePasskey(guardId: string | undefined) {
  const [supported, setSupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void webauthnSupported().then((available) => {
      if (cancelled) return;
      setSupported(available);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await listPasskeys();
      setPasskeys(rows);
      setPasskeyGuardId(rows.length > 0 && guardId ? guardId : null);
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

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await removePasskey(id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'מחיקת האימות הביומטרי נכשלה');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, friendlyName: string) => {
      setError(null);
      try {
        await renamePasskey(id, friendlyName);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'שינוי השם נכשל');
      }
    },
    [refresh],
  );

  return {
    supported,
    loading,
    passkeys,
    hasPasskey: getPasskeyGuardId() !== null,
    busy,
    error,
    register,
    remove,
    rename,
  };
}
