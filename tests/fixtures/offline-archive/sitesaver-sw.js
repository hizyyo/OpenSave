const CACHE = 'fixture-v1';
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/index.html', '/404.html', '/favicon.svg', '/sitesaver-offline.js', '/sitesaver-sw.js']))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith((async () => {
  const cache = await caches.open(CACHE);
  if (event.request.mode === 'navigate') return cache.match('/index.html');
  return (await cache.match(event.request)) || new Response(null, { status: 503, statusText: 'External network blocked by SiteSaver' });
})()));
