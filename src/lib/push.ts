import { requireSupabase } from '@/lib/supabase';

/**
 * Web Push subscribe/unsubscribe (spec 12.10). Push-only by design -- no
 * SMS/email fallback for a guard who never installs the app. iOS only
 * delivers push to a PWA actually added to the home screen (Safari 16.4+),
 * which is a real, accepted limitation, not a bug here.
 */

/** PushManager.subscribe() wants the VAPID public key as a raw BufferSource,
 *  not the base64url string it's distributed as. Standard conversion --
 *  built via `new Uint8Array(buffer)` rather than `Uint8Array.from()` so its
 *  backing store is a concrete ArrayBuffer, matching what PushManager's own
 *  BufferSource type expects (Uint8Array.from()'s inferred ArrayBufferLike
 *  also admits SharedArrayBuffer, which TS then rejects at the call site). */
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Subscribes this browser/device and upserts the subscription for guardId.
 *  Throws if permission is denied or the browser lacks support -- callers
 *  should catch and surface a friendly message rather than let this throw
 *  silently into a promise nobody awaits. */
export async function subscribeToPush(guardId: string): Promise<void> {
  if (!pushSupported()) throw new Error('דפדפן זה לא תומך בהתראות');

  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!publicKey) throw new Error('התראות לא מוגדרות באפליקציה זו');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('ההרשאה לא אושרה');

  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const json = sub.toJSON();
  const { error } = await requireSupabase().from('push_subscriptions').upsert(
    {
      guard_id: guardId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      user_agent: navigator.userAgent,
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw new Error(error.message);
}

/** Whether THIS browser currently holds a live push subscription -- distinct
 *  from Notification.permission, which stays 'granted' even after the
 *  subscription itself was cleared (e.g. site data reset). */
export async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  const sub = await registration.pushManager.getSubscription();
  return sub !== null;
}
