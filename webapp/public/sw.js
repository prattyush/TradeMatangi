/* Change this version whenever the offline page changes. No trading data is cached. */
const CACHE = 'tradematangi-webapp-offline-v1'
const OFFLINE = new URL('offline.html', self.registration.scope).href
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(new Request(OFFLINE, { cache: 'reload' }))))
  // Intentionally no skipWaiting: existing workspaces must not be interrupted.
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('tradematangi-webapp-offline-') && key !== CACHE)
    .map(key => caches.delete(key)))))
  // No clients.claim: takeover waits for a future navigation.
})
self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || request.mode !== 'navigate' || !request.url.startsWith(self.registration.scope)) return
  event.respondWith(fetch(request).catch(async () =>
    (await caches.match(OFFLINE, { cacheName: CACHE })) ?? Response.error()))
})
