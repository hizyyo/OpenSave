import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/6n8XWQAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2f855a"/></svg>';

const page = (title, marker, body, script = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><title>${title}</title></head>
<body data-benchmark-marker="${marker}"><h1>${marker}</h1>${body}${script ? `<script>${script}</script>` : ''}</body>
</html>`;

export const FIXTURES = [
  { id: 'static', mode: 'quick', marker: 'STATIC_ROOT', routes: [] },
  { id: 'spa', mode: 'deep', marker: 'SPA_ROOT', routes: ['/fixtures/spa/route-a'] },
  { id: 'multipage', mode: 'deep', marker: 'MULTIPAGE_ROOT', routes: ['/fixtures/multipage/page-a', '/fixtures/multipage/page-b'] },
  { id: 'shadow', mode: 'quick', marker: 'SHADOW_ROOT', routes: [] },
  { id: 'lazy', mode: 'deep', marker: 'LAZY_ROOT', routes: [] },
  { id: 'canvas', mode: 'deep', marker: 'CANVAS_ROOT', routes: [] },
  { id: 'api', mode: 'quick', marker: 'API_ROOT', routes: [] },
  { id: 'platform', mode: 'quick', marker: 'PLATFORM_ROOT', routes: [] },
  { id: 'detectors', mode: 'quick', marker: 'DETECTOR_ROOT', routes: [], expectedFailure: true }
];

const text = (response, value, type = 'text/plain; charset=utf-8', status = 200, headers = {}) => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  response.end(value);
};

const binary = (response, value, type) => {
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(value);
};

const fixtureHtml = (id, pathname, port) => {
  if (id === 'static') {
    return page('Static fixture', 'STATIC_ROOT', `
      <link rel="stylesheet" href="/fixtures/static/css/main.css">
      <img id="space-asset" src="/fixtures/static/assets/image with spaces.png" alt="space asset">
      <img id="responsive" src="/fixtures/static/assets/small.png" srcset="/fixtures/static/assets/small.png 1x, /fixtures/static/assets/large.png 2x" alt="responsive">
      <svg width="24" height="24"><use href="/fixtures/static/assets/sprite.svg#mark"></use></svg>`);
  }
  if (id === 'spa') {
    const marker = pathname.endsWith('/route-a') ? 'SPA_ROUTE_A' : 'SPA_ROOT';
    return page('SPA fixture', marker, `
      <nav><a href="/fixtures/spa/route-a">Route A</a></nav>
      <main id="view">${marker}</main>`, `
      document.querySelector('a').addEventListener('click', (event) => {
        event.preventDefault();
        history.pushState({}, '', event.currentTarget.href);
        document.getElementById('view').textContent = 'SPA_ROUTE_A';
      });
      addEventListener('popstate', () => { document.getElementById('view').textContent = location.pathname.endsWith('route-a') ? 'SPA_ROUTE_A' : 'SPA_ROOT'; });`);
  }
  if (id === 'multipage') {
    if (pathname.endsWith('/page-a')) return page('Page A', 'MULTIPAGE_PAGE_A', '<link rel="stylesheet" href="/fixtures/multipage/page-a.css"><img src="/fixtures/multipage/page-a.png" alt="a">');
    if (pathname.endsWith('/page-b')) return page('Page B', 'MULTIPAGE_PAGE_B', '<link rel="stylesheet" href="/fixtures/multipage/page-b.css"><img src="/fixtures/multipage/page-b.png" alt="b">');
    return page('Multi-page fixture', 'MULTIPAGE_ROOT', '<a href="/fixtures/multipage/page-a">Page A</a><a href="/fixtures/multipage/page-b">Page B</a>');
  }
  if (id === 'shadow') {
    return page('Shadow fixture', 'SHADOW_ROOT', '<div id="host"></div><div id="shadow-status">pending</div>', `
      if (location.hostname.startsWith('shadow.')) {
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(':host::before { content: "PSEUDO_OK"; } .inside { color: rgb(20, 80, 120); }');
      root.adoptedStyleSheets = [sheet];
      root.innerHTML = '<span class="inside">SHADOW_CONTENT</span>';
      document.getElementById('shadow-status').textContent = root.adoptedStyleSheets.length ? 'ADOPTED_OK' : 'ADOPTED_MISSING';
      }`);
  }
  if (id === 'lazy') {
    return page('Lazy fixture', 'LAZY_ROOT', `
      <img id="lazy-image" data-src="/fixtures/lazy/lazy.png" alt="lazy">
      <div id="scroller" style="height:80px;overflow-y:auto"><div style="height:700px"></div><div id="scroll-marker">SCROLL_PENDING</div></div>
      <div id="mutation-marker">MUTATION_PENDING</div>`, `
      const image = document.getElementById('lazy-image');
      const activate = () => { if (!image.src) image.src = image.dataset.src; };
      addEventListener('scroll', activate, { once: true });
      document.getElementById('scroller').addEventListener('scroll', () => { document.getElementById('scroll-marker').textContent = 'SCROLL_OK'; activate(); }, { once: true });
      setTimeout(() => {
        const added = document.createElement('img');
        added.id = 'mutation-asset';
        added.src = '/fixtures/lazy/mutation.png';
        document.body.append(added);
        document.getElementById('mutation-marker').textContent = 'MUTATION_OK';
      }, 250);`);
  }
  if (id === 'canvas') {
    return page('Canvas fixture', 'CANVAS_ROOT', '<canvas id="canvas" width="80" height="40"></canvas><canvas id="webgl" width="16" height="16"></canvas><div id="webgl-status"></div>', `
      const canvas = document.getElementById('canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = '#d97706'; context.fillRect(0, 0, 80, 40);
      const gl = document.getElementById('webgl').getContext('webgl');
      document.getElementById('webgl-status').textContent = gl ? 'WEBGL_AVAILABLE' : 'WEBGL_UNAVAILABLE';`);
  }
  if (id === 'api') {
    return page('API fixture', 'API_ROOT', '<div id="api-status">API_PENDING</div>', `
      (async () => {
        const results = [];
        results.push(await fetch('/fixtures/api/data?variant=one').then((response) => response.json()));
        results.push(await fetch('/fixtures/api/data?variant=two').then((response) => response.json()));
        results.push(await fetch('/fixtures/api/post').then((response) => response.json()));
        results.push(await fetch('/fixtures/api/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"variant":"one"}' }).then((response) => response.json()));
        results.push(await fetch('/fixtures/api/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"variant":"two"}' }).then((response) => response.json()));
        results.push(await fetch('/fixtures/api/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'variant=form' }).then((response) => response.json()));
        const polls = [];
        for (let index = 0; index < 3; index += 1) polls.push(await fetch('/fixtures/api/poll').then((response) => response.json()));
        results.push(...polls);
        await fetch('/fixtures/api/error').then((response) => response.text());
        const redirected = await fetch('/fixtures/api/redirect').then((response) => response.json());
        const head = await fetch('/fixtures/api/head', { method: 'HEAD' });
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/fixtures/api/xhr?value=stable');
          xhr.onload = resolve; xhr.onerror = reject; xhr.send();
        });
        const status = document.getElementById('api-status');
        status.dataset.polls = polls.map((item) => item.sequence).join(',');
        status.dataset.posts = results.filter((item) => item.received !== undefined).map((item) => item.received).join('|');
        status.dataset.redirect = redirected.variant;
        status.dataset.head = String(head.status);
        status.textContent = 'API_OK_' + results.length;
      })().catch((error) => { document.getElementById('api-status').textContent = 'API_ERROR_' + error.message; });`);
  }
  if (id === 'platform') {
    return page('Platform fixture', 'PLATFORM_ROOT', '<iframe src="/fixtures/platform/frame"></iframe><div id="platform-status">PLATFORM_PENDING</div>', `
      (async () => {
        const events = [];
        const worker = new Worker('/fixtures/platform/worker.js');
        worker.onmessage = (event) => events.push(event.data);
        const blobWorker = new Worker(URL.createObjectURL(new Blob(['postMessage("BLOB_WORKER_OK")'], { type: 'text/javascript' })));
        blobWorker.onmessage = (event) => events.push(event.data);
        if ('serviceWorker' in navigator) {
          try {
            await navigator.serviceWorker.register('/fixtures/platform/sw.js', { scope: '/fixtures/platform/' });
            await navigator.serviceWorker.ready;
          } catch (error) {}
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        document.getElementById('platform-status').textContent = 'PLATFORM_READY';
      })().catch((error) => { document.getElementById('platform-status').textContent = 'PLATFORM_ERROR_' + error.message; });`);
  }
  if (id === 'detectors') {
    return page('Detector fixture', 'DETECTOR_ROOT', '<img src="/fixtures/detectors/missing.png" alt="seeded missing"><link rel="stylesheet" href="/fixtures/detectors/missing.css"><div id="detector-status">DETECTORS_ARMED</div>', `
      setTimeout(() => {
        const image = new Image();
        image.src = ['http://external.opensave.test:${port}', '/fixtures/detectors/external.png'].join('');
        document.body.append(image);
        throw new Error('SEEDED_RUNTIME_ERROR');
      }, 300);`);
  }
  return null;
};

export function createCorpusServer() {
  const replayArchives = new Map();
  const pollCounts = new Map();
  let port = 0;

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const hostname = url.hostname;
    const replay = replayArchives.get(hostname);
    if (replay) {
      const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = replay.get(path.slice(1));
      if (!file) {
        text(response, 'Not found', 'text/plain; charset=utf-8', 404);
        return;
      }
      response.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' });
      response.end(file.data);
      return;
    }

    const match = url.pathname.match(/^\/fixtures\/([^/]+)(?:\/.*)?$/);
    const fixtureId = match && match[1];
    const fixtureRoot = fixtureId && url.pathname === `/fixtures/${fixtureId}/`;
    const fixtureRoute = fixtureId === 'spa' && url.pathname === '/fixtures/spa/route-a'
      || fixtureId === 'multipage' && /^\/fixtures\/multipage\/page-[ab]$/.test(url.pathname)
      || fixtureId === 'platform' && url.pathname === '/fixtures/platform/frame';
    const html = (fixtureRoot || fixtureRoute) && fixtureHtml(fixtureId, url.pathname, port);
    if (html) {
      text(response, html, 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/fixtures/static/css/main.css') {
      text(response, '@import url("/fixtures/static/css/theme with spaces.css"); @font-face { font-family: BenchmarkUnused; src: url("/fixtures/static/fonts/fixture.woff2") format("woff2"); } body { background-image: url("/fixtures/static/assets/pattern.svg#tile"); }', 'text/css; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/static/css/theme with spaces.css') {
      text(response, 'h1 { color: rgb(47, 133, 90); }', 'text/css; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/static/assets/sprite.svg') {
      text(response, '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="mark"><circle cx="8" cy="8" r="8"/></symbol></svg>', 'image/svg+xml');
      return;
    }
    if (url.pathname.endsWith('.svg')) {
      text(response, SVG, 'image/svg+xml');
      return;
    }
    if (url.pathname === '/fixtures/detectors/missing.png') {
      text(response, 'Not found', 'text/plain; charset=utf-8', 404);
      return;
    }
    if (url.pathname.endsWith('.png')) {
      binary(response, PNG, 'image/png');
      return;
    }
    if (url.pathname.endsWith('.woff2')) {
      binary(response, Buffer.from('benchmark-font-placeholder'), 'font/woff2');
      return;
    }
    if (url.pathname.endsWith('.css')) {
      text(response, `body { border-top: 3px solid ${url.pathname.includes('page-a') ? '#2563eb' : '#9333ea'}; }`, 'text/css; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/api/data') {
      text(response, JSON.stringify({ variant: url.searchParams.get('variant') }), 'application/json');
      return;
    }
    if (url.pathname === '/fixtures/api/post') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => text(response, JSON.stringify({ received: body }), 'application/json'));
      return;
    }
    if (url.pathname === '/fixtures/api/head') {
      response.writeHead(204, { 'x-opensave-head': 'captured', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/fixtures/api/poll') {
      const key = request.headers.host || 'default';
      const count = (pollCounts.get(key) || 0) + 1;
      pollCounts.set(key, count);
      text(response, JSON.stringify({ sequence: count }), 'application/json');
      return;
    }
    if (url.pathname === '/fixtures/api/error') {
      text(response, JSON.stringify({ code: 'SEEDED_ERROR' }), 'application/json', 418);
      return;
    }
    if (url.pathname === '/fixtures/api/redirect') {
      response.writeHead(302, { location: '/fixtures/api/data?variant=redirected', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/fixtures/api/xhr') {
      text(response, JSON.stringify({ value: url.searchParams.get('value') }), 'application/json');
      return;
    }
    if (url.pathname === '/fixtures/platform/worker.js') {
      text(response, 'postMessage("WORKER_OK")', 'text/javascript; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/platform/sw.js') {
      text(response, `self.addEventListener('install', event => event.waitUntil(caches.open('benchmark-platform-v1').then(cache => cache.add('/fixtures/platform/cached.json')))); self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));`, 'text/javascript; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/platform/cached.json') {
      text(response, JSON.stringify({ cached: true }), 'application/json');
      return;
    }
    if (url.pathname === '/fixtures/platform/frame') {
      text(response, page('Frame fixture', 'IFRAME_OK', '<p>IFRAME_CONTENT</p>'), 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/fixtures/detectors/external.png') {
      binary(response, PNG, 'image/png');
      return;
    }
    text(response, 'Not found', 'text/plain; charset=utf-8', 404);
  });

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
      return port;
    },
    fixtureUrl(fixtureId) {
      return `http://${fixtureId}.opensave.localhost:${port}/fixtures/${fixtureId}/`;
    },
    registerReplay(hostname, files) {
      replayArchives.set(hostname, files);
      return `http://${hostname}:${port}/`;
    },
    resetFixture(fixtureId) {
      pollCounts.delete(`${fixtureId}.opensave.localhost:${port}`);
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
