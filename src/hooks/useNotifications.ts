import { useEffect, useState } from 'react';
import { isSubscribed, pushSupported, subscribeToPush } from '@/lib/push';

/**
 * Wraps push-subscription state for the enable-prompt card (spec 12.10).
 * Enable-only, by deliberate design -- these notifications carry real
 * schedule-affecting updates, so there is no in-app way to disable them once
 * turned on. Re-checks isSubscribed() after enabling rather than assuming it
 * succeeded, since a subscribe can silently no-op if the browser already had
 * a (possibly stale) subscription.
 */
export function useNotifications(guardId: string | undefined) {
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    void isSubscribed().then(setSubscribed);
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
    busy,
    error,
    permission: supported ? Notification.permission : ('denied' as NotificationPermission),
    enable,
  };
}
