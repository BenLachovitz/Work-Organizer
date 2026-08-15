import { useEffect, useState } from 'react';
import { isSubscribed, pushSupported, subscribeToPush } from '@/lib/push';

/**
 * Wraps push-subscription state for the enable-prompt card (spec 12.10).
 * Enable-only, by deliberate design -- these notifications carry real
 * schedule-affecting updates, so there is no in-app way to disable them once
 * turned on. Re-checks isSubscribed() after enabling rather than assuming it
 * succeeded, since a subscribe can silently no-op if the browser already had
 * a (possibly stale) subscription.
 *
 * `checked` distinguishes "haven't looked yet" from "looked and it's false" --
 * callers gating visibility on `subscribed` alone would otherwise flash the
 * prompt for an already-subscribed guard for one render before the initial
 * isSubscribed() check resolves.
 */
export function useNotifications(guardId: string | undefined) {
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      setChecked(true);
      return;
    }
    void isSubscribed().then((v) => {
      setSubscribed(v);
      setChecked(true);
    });
  }, [supported]);

  const enable = async () => {
    if (!guardId) return;
    setBusy(true);
    setError(null);
    try {
      await subscribeToPush(guardId);
      setSubscribed(await isSubscribed());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בהפעלת התראות');
    } finally {
      setBusy(false);
    }
  };

  return {
    supported,
    subscribed,
    checked,
    busy,
    error,
    permission: supported ? Notification.permission : ('denied' as NotificationPermission),
    enable,
  };
}
