// Exists ONLY to satisfy PWA installability checks. Deliberately caches
// nothing -- this app is Realtime-driven with deadline-sensitive scheduling
// data, so any caching layer risks serving a stale roster or deadline. Every
// request passes straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));

// Push notifications (spec 12.10) -- the weekly broadcast and the two
// deadline reminders, sent by send-notifications via PushManager. Payload is
// a plain {title, body, tag} JSON object; tag lets a repeat notification of
// the same type replace the previous one instead of stacking.
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
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
