import { useEffect, useState } from 'react';
import { isSubscribed, pushSupported, subscribeToPush, unsubscribeFromPush } from '@/lib/push';

/** Wraps push-subscription state for the bell toggle and the enable-prompt
 *  card (spec 12.10). Re-checks isSubscribed() after every action rather
 *  than assuming the action succeeded, since a subscribe can silently no-op
 *  if the browser already had a (possibly stale) subscription. */
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

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush();
      setSubscribed(await isSubscribed());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בביטול התראות');
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
    toggle: () => void (subscribed ? disable() : enable()),
  };
}
