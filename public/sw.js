// Exists ONLY to satisfy PWA installability checks. Deliberately caches
// nothing -- this app is Realtime-driven with deadline-sensitive scheduling
// data, so any caching layer risks serving a stale roster or deadline. Every
// request passes straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));

// Push notifications (spec 12.10) -- the weekly broadcast and the two
// deadline reminders, sent by send-notifications via PushManager. Payload is
// a plain {title, body, tag, url} JSON object; tag lets a repeat notification
// of the same type replace the previous one instead of stacking. `url` is
// where a click should land -- every current type points at /preferences,
// since all three exist to get a guard to submit, but it travels in the
// payload rather than being hardcoded here so a future notification type
// (e.g. a roster-published push) can point somewhere else without a second
// service worker code path.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload; fall through to the defaults below
  }
  const title = data.title || 'לוח משמרות';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      dir: 'rtl',
      lang: 'he',
      tag: data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const url = event.notification.data?.url || '/';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // An already-open tab is navigated to the target page, not just
      // focused wherever it happened to be -- a guard tapping "submit your
      // preferences" who already has the app open on the roster page should
      // still land on the submission form, not stay put.
      for (const client of clients) {
        if ('focus' in client) {
          return 'navigate' in client
            ? client.navigate(url).then((c) => (c && 'focus' in c ? c.focus() : c))
            : client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
