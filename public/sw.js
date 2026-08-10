// Exists ONLY to satisfy PWA installability checks. Deliberately caches
// nothing -- this app is Realtime-driven with deadline-sensitive scheduling
// data, so any caching layer risks serving a stale roster or deadline. Every
// request passes straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
