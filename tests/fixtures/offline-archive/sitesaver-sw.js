const CACHE = 'fixture-v1';
const PAGE_ROUTES = { '/card': '/assets/fixture.example/card.html' };
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/index.html', '/404.html', '/favicon.svg', '/sitesaver-offline.js', '/sitesaver-sw.js', '/assets/fixture.example/card.html']))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith((async () => {
  const cache = await caches.open(CACHE);
  if (event.request.mode === 'navigate') {
    const exact = await cache.match(event.request);
    if (exact) return exact;
    const page = PAGE_ROUTES[new URL(event.request.url).pathname];
    if (page) return cache.match(page);
    return cache.match('/index.html');
  }
  return (await cache.match(event.request)) || new Response(null, { status: 503, statusText: 'External network blocked by openSave' });
})()));
