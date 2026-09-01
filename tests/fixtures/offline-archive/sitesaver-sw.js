importScripts('/replay-matcher.js');
const CACHE = 'fixture-v2';
const PAGE_ROUTES = { '/card': '/assets/fixture.example/card.html' };
const MATCHER = OpenSaveReplayMatcher.createMatcher([]);
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/index.html', '/404.html', '/favicon.svg', '/replay-matcher.js', '/replay-misses.json', '/sitesaver-offline.js', '/sitesaver-sw.js', '/assets/fixture.example/card.html']))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith((async () => {
  const cache = await caches.open(CACHE);
  if (new URL(event.request.url).pathname === '/replay-misses.json') return cache.match('/replay-misses.json');
  if (event.request.mode === 'navigate') {
    const exact = await cache.match(event.request);
    if (exact) return exact;
    const page = PAGE_ROUTES[new URL(event.request.url).pathname];
    if (page) return cache.match(page);
    return cache.match('/index.html');
  }
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const matched = await MATCHER.match(event.request);
  return new Response(JSON.stringify(matched.miss), { status: 503, statusText: 'External network blocked by openSave', headers: { 'content-type': 'application/json' } });
})()));
