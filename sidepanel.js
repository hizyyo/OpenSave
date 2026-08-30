const btnCapture = document.getElementById('btnCapture');
const progress = document.getElementById('progress');
const statusEl = document.getElementById('status');
const fillEl = document.getElementById('fill');
const logEl = document.getElementById('log');
const btnRecord = document.getElementById('btnRecord');
const btnFinishScenario = document.getElementById('btnFinishScenario');
const reportEl = document.getElementById('report');
const btnPickElement = document.getElementById('btnPickElement');
const captureModeEl = document.getElementById('captureMode');
const btnCancelCapture = document.getElementById('btnCancelCapture');
const CaptureGraph = OpenSaveCaptureGraph;
const CaptureStorage = OpenSaveCaptureStorage;
const ResourceParser = OpenSaveResourceParser;
const captureStorage = CaptureStorage.createCaptureStorage();
const captureStorageReady = captureStorage.initialize();
let exportingMissionId = null;

const MAX_FALLBACK_RESOURCES = 400;
const MAX_PAGES = 40;
const MAX_FALLBACK_FILE_SIZE = 200 * 1024 * 1024;
const GLTF_EXTENSION = /\.gltf(?:$|[?#])/i;
const SOURCE_MAP_EXPRESSION = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/gi;

async function hydrateDurableProjection(resources) {
  await captureStorageReady;
  const bodiesByStorageKey = new Map();
  const hydrated = [];
  for (const resource of resources) {
    if (resource.body != null) {
      hydrated.push(resource);
      continue;
    }
    if (!resource.storageKey) throw new Error(`Тело ${resource.contentHash || resource.url} не имеет storageKey`);
    let blob = bodiesByStorageKey.get(resource.storageKey);
    if (!blob) {
      blob = await captureStorage.readBody(resource.storageKey, resource.mimeType || '');
      bodiesByStorageKey.set(resource.storageKey, blob);
    }
    const body = isTextResource(resource) ? await blob.text() : blob;
    hydrated.push({ ...resource, body, base64Encoded: false });
  }
  return hydrated;
}

async function saveGraphMission(graph, state, extra = {}) {
  const mission = graph && graph.missions && graph.missions[0];
  if (!mission) return null;
  mission.state = state || mission.state;
  return captureStorage.saveMission(mission.id, {
    state: mission.state,
    graph,
    pendingWork: [],
    ...extra
  });
}

function log(message, type) {
  logEl.style.display = 'block';
  const line = document.createElement('div');
  line.className = type || '';
  line.textContent = message;
  logEl.appendChild(line);
}

function status(message, percent) {
  if (percent !== undefined) fillEl.style.width = `${percent}%`;
  statusEl.textContent = message;
}

function renderReport(report) {
  if (!report) return;
  const missing = (report.unresolvedResources || []).length;
  const pages = (report.unavailablePages || []).length;
  const truncated = (report.truncatedDiscovery || []).length;
  const savedPageCount = report.savedPageCount;
  const completeness = report.completeness;
  const diagnostics = (report.networkFailures || []).length + (report.httpErrors || []).length + (report.unreadableResponses || []).length;
  const quotaFailure = (report.quotaFailures || [])[0];
  const refetched = report.captureGraph && report.captureGraph.provenance.refetched.responses || 0;
  reportEl.style.display = 'block';
  reportEl.innerHTML = `<strong>Отчёт захвата</strong><br>${quotaFailure ? `<span class="warn">${quotaFailure.reason}</span><br>` : ''}${completeness ? `Полнота: <strong>${completeness.score}%</strong> (${completeness.saved}/${completeness.discovered} зависимостей)<br>` : ''}${typeof savedPageCount === 'number' ? `HTML-страниц: ${savedPageCount}<br>` : ''}Кэш: ${report.cacheResources || 0}/${report.cacheEntries || 0} сохранено<br>Iframe/worker: ${(report.childTargets || []).length}<br>${refetched ? `Дозагружено openSave: ${refetched} (не CDP-наблюдение)<br>` : ''}${missing ? `<span class="warn">Недоступные ассеты: ${missing}</span><br>` : 'Недоступных ассетов не найдено'}${pages ? `<span class="warn">Страницы с 404: ${pages}</span><br>` : ''}${truncated ? `<span class="warn">Лимит обхода достигнут: ${truncated}</span><br>` : ''}${diagnostics ? `Диагностика сети: ${diagnostics} (аналитика/API не считаются потерей ассетов)` : ''}`;
}

function addReportItem(report, type, item) {
  if (!report[type]) report[type] = [];
  if (report[type].length >= 100) return;
  if (!report[type].some((existing) => JSON.stringify(existing) === JSON.stringify(item))) report[type].push(item);
}

function finalizeReport(report, catalog) {
  const finalReport = structuredClone(report || {});
  const savedUrls = new Set(catalog.byUrl.keys());
  const resolved = (item) => {
    try {
      return savedUrls.has(normalizeUrl(item.url));
    } catch (error) {
      return false;
    }
  };
  finalReport.unresolvedResources = (finalReport.unresolvedResources || []).filter((item) => !resolved(item));
  finalReport.networkFailures = (finalReport.networkFailures || []).filter((item) => !resolved(item));
  finalReport.unreadableResponses = (finalReport.unreadableResponses || []).filter((item) => !resolved(item));
  const discovered = new Set((finalReport.discoveredResources || []).map((item) => item.url));
  const saved = [...discovered].filter((url) => savedUrls.has(url)).length;
  finalReport.completeness = {
    discovered: discovered.size,
    saved,
    unresolved: (finalReport.unresolvedResources || []).length,
    score: discovered.size ? Number(((saved / discovered.size) * 100).toFixed(1)) : 100
  };
  return finalReport;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'captureReport') renderReport(message.report);
  if (message.action === 'elementPicked') {
    if (message.cancelled) {
      status('Выбор блока отменён');
      resetInterface();
      return;
    }
    exportSelectedElement(message.selected);
  }
});

function normalizeUrl(value) {
  return ResourceParser.normalizeUrl(value);
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch (error) {
    return false;
  }
}

function extractResourceReferences(html, baseUrl, ownerArtifact) {
  return ResourceParser.discoverHtmlReferences(html, { baseUrl, ownerArtifact }).filter((reference) =>
    reference.resolvedUrl && isHttpUrl(reference.resolvedUrl) && reference.role !== 'navigation'
  );
}

function queryAllWithSnapshotTemplates(root, selector) {
  const matches = [...root.querySelectorAll(selector)];
  for (const template of root.querySelectorAll('template[data-opensave-shadowroot]')) {
    matches.push(...queryAllWithSnapshotTemplates(template.content, selector));
  }
  return matches;
}

function extractPageUrls(html, baseUrl, allowedOrigin) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const urls = new Set();

  document.querySelectorAll('a[href]').forEach((element) => {
    const href = element.getAttribute('href');
    if (!href || /^(?:#|data:|blob:|javascript:|mailto:|tel:)/i.test(href)) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      if (url.origin === allowedOrigin && /^https?:$/.test(url.protocol)) urls.add(url.href);
    } catch (error) {
      // Ignore malformed links.
    }
  });

  return [...urls];
}

function extractLegacyImportMapUrls(html, baseUrl) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const urls = [];
  document.querySelectorAll('script[type="importmap"]').forEach((element) => {
    try {
      const imports = JSON.parse(element.textContent || '{}').imports || {};
      for (const value of Object.values(imports)) {
        if (typeof value !== 'string' || !/^(?:\.\.?\/|\/|https?:)/i.test(value)) continue;
        const url = normalizeUrl(new URL(value, baseUrl).href);
        if (isHttpUrl(url)) urls.push(url);
      }
    } catch (error) {
      // Preserve the existing bounded import-map discovery without expanding it.
    }
  });
  return urls;
}

function extractCssReferences(css, baseUrl, ownerArtifact) {
  return ResourceParser.discoverCssReferences(css, { baseUrl, ownerArtifact }).filter((reference) => reference.resolvedUrl && isHttpUrl(reference.resolvedUrl));
}

function safeSegment(segment) {
  try {
    segment = decodeURIComponent(segment);
  } catch (error) {
    // Keep the escaped form when it cannot be decoded.
  }
  return segment.replace(/[<>:"\\|?*\u0000-\u001f]/g, '_') || '_';
}

function extensionForMimeType(mimeType) {
  const type = (mimeType || '').toLowerCase().split(';')[0];
  if (type === 'text/html') return '.html';
  if (type === 'text/css') return '.css';
  if (/(?:java|ecma)script/.test(type)) return '.js';
  if (type === 'application/wasm') return '.wasm';
  if (type === 'application/manifest+json') return '.webmanifest';
  if (type === 'application/json') return '.json';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/avif') return '.avif';
  if (type === 'image/gif') return '.gif';
  if (type === 'font/woff2') return '.woff2';
  if (type === 'font/woff') return '.woff';
  return '';
}

function shortHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

function apiSnapshotPath(snapshot) {
  const extension = extensionForMimeType(snapshot.mimeType) || '.bin';
  const key = `${snapshot.method}\n${snapshot.url}\n${snapshot.postData}`;
  return `api-snapshots/${shortHash(key)}${extension}`;
}

function archivePathFor(urlValue, mimeType) {
  const url = new URL(urlValue);
  const segments = url.pathname.split('/').filter(Boolean).map(safeSegment);
  let filename = segments.pop() || 'index';
  const extension = extensionForMimeType(mimeType);
  if (!/\.[a-z0-9]{1,10}$/i.test(filename) && extension) filename += extension;
  if (url.search) {
    const dot = filename.lastIndexOf('.');
    filename = dot > 0
      ? `${filename.slice(0, dot)}.${shortHash(url.search)}${filename.slice(dot)}`
      : `${filename}.${shortHash(url.search)}`;
  }
  return ['assets', safeSegment(url.hostname), ...segments, filename].join('/');
}

function isTextResource(resource) {
  const type = (resource.mimeType || '').toLowerCase();
  return type.startsWith('text/') || /(?:java|ecma)script|json|xml|gltf\+json/.test(type) || GLTF_EXTENSION.test(resource.url);
}

function isGltfResource(resource) {
  return GLTF_EXTENSION.test(resource.url) || /model\/gltf\+json/i.test(resource.mimeType || '');
}

function base64ToText(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function localPathFor(value, baseUrl, byUrl) {
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return value;
  try {
    const resource = byUrl.get(normalizeUrl(new URL(value, baseUrl).href));
    return resource ? `/${resource.localPath}` : value;
  } catch (error) {
    return value;
  }
}

function createResourceResolver(byUrl, graph = null) {
  const resources = new Map([...byUrl.entries()].map(([url, resource]) => [url, `/${resource.localPath}`]));
  const redirects = new Map();
  if (graph) {
    for (const request of graph.requests || []) {
      if (!request.redirectSuccessorRequestId) continue;
      const successor = graph.requests.find((candidate) => candidate.id === request.redirectSuccessorRequestId);
      if (successor) redirects.set(request.normalizedUrl, successor.normalizedUrl);
    }
  }
  return ResourceParser.createResolver({ resources, redirects });
}

function rewriteCssUrls(css, baseUrl, resolver) {
  return ResourceParser.rewriteCss(css || '', { baseUrl, resolver });
}

function rewriteJavaScriptUrls(source, baseUrl, resolver) {
  return ResourceParser.rewriteJavaScript(source || '', { baseUrl, resolver });
}

function forEachGltfUri(value, callback) {
  if (Array.isArray(value)) {
    value.forEach((item) => forEachGltfUri(item, callback));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uri' && typeof child === 'string') callback(value, key, child);
    else forEachGltfUri(child, callback);
  }
}

function extractGltfUrls(gltf, baseUrl) {
  try {
    const data = JSON.parse(gltf);
    const urls = new Set();
    forEachGltfUri(data, (parent, key, value) => {
      if (/^data:/i.test(value)) return;
      try {
        const url = normalizeUrl(new URL(value, baseUrl).href);
        if (isHttpUrl(url)) urls.add(url);
      } catch (error) {
        // Ignore malformed model references.
      }
    });
    return [...urls];
  } catch (error) {
    return [];
  }
}

function extractJavaScriptReferences(source, baseUrl, ownerArtifact) {
  return ResourceParser.discoverJavaScriptReferences(source, { baseUrl, ownerArtifact }).filter((reference) => reference.resolvedUrl && isHttpUrl(reference.resolvedUrl));
}

function extractSourceMapUrls(source, baseUrl) {
  const urls = new Set();
  let match;
  while ((match = SOURCE_MAP_EXPRESSION.exec(source || '')) !== null) {
    try {
      const url = normalizeUrl(new URL(match[1], baseUrl).href);
      if (isHttpUrl(url) && new URL(url).origin === new URL(baseUrl).origin) urls.add(url);
    } catch (error) {
      // Ignore malformed source-map comments.
    }
  }
  return [...urls];
}

function rewriteGltfUrls(gltf, baseUrl, byUrl) {
  try {
    const data = JSON.parse(gltf);
    forEachGltfUri(data, (parent, key, value) => {
      parent[key] = localPathFor(value, baseUrl, byUrl);
    });
    return JSON.stringify(data);
  } catch (error) {
    return gltf;
  }
}

function rewriteHtmlResource(html, baseUrl, resolver, diagnosticSink = []) {
  let source = html;
  try {
    const rewritten = ResourceParser.rewriteHtml(html, { baseUrl, resolver });
    diagnosticSink.push(...rewritten.diagnostics);
    source = rewritten.source;
  } catch (error) {
    diagnosticSink.push({
      code: 'resource-parser-html-rewrite-failed',
      severity: 'warning',
      phase: 'resource-rewrite',
      message: error.message
    });
  }
  const document = new DOMParser().parseFromString(source, 'text/html');
  const queryAll = (selector) => queryAllWithSnapshotTemplates(document, selector);

  // Rewritten resources no longer match the publisher's original SRI hashes.
  queryAll('[integrity]').forEach((element) => element.removeAttribute('integrity'));
  document.querySelectorAll('meta[http-equiv]').forEach((element) => {
    if ((element.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy') element.remove();
  });
  document.querySelectorAll('base').forEach((element) => element.remove());

  const scriptSources = new Set();
  queryAll('script[src]').forEach((element) => {
    const source = element.getAttribute('src') || '';
    if (/^https?:/i.test(source) || scriptSources.has(source)) {
      element.remove();
      return;
    }
    scriptSources.add(source);
  });
  queryAll('link[href]').forEach((element) => {
    const rel = (element.getAttribute('rel') || '').toLowerCase();
    if (/^https?:/i.test(element.getAttribute('href') || '') && /\b(?:stylesheet|modulepreload|preload|manifest|icon)\b/.test(rel)) element.remove();
  });
  queryAll('iframe[src]').forEach((element) => {
    if (/^https?:/i.test(element.getAttribute('src') || '')) element.removeAttribute('src');
  });
  queryAll('img[src], img[data-src], source[src], source[data-src], video[src], audio[src], track[src], object[data], embed[src], input[src], video[poster]').forEach((element) => {
    for (const attribute of ['src', 'data-src', 'data', 'poster']) {
      if (/^https?:/i.test(element.getAttribute(attribute) || '')) element.removeAttribute(attribute);
    }
  });

  const inlineScriptSources = new Set();
  queryAll('script:not([src])').forEach((element) => {
    const source = element.textContent || '';
    const expression = /(?:\.src\s*=|setAttribute\(\s*['"]src['"]\s*,)\s*['"]([^'"]+)['"]/gi;
    let match;
    while ((match = expression.exec(source)) !== null) inlineScriptSources.add(match[1]);
  });
  queryAll('script[src]').forEach((element) => {
    if (inlineScriptSources.has(element.getAttribute('src') || '')) element.remove();
  });

  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function injectOfflineBootstrap(html) {
  const bootstrap = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' blob:; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; media-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\'; frame-src \'self\'; worker-src \'self\' blob:; object-src \'none\'; form-action \'none\'; base-uri \'self\'"><script src="/sitesaver-offline.js"></script>';
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`);
  }
  return `${bootstrap}${html}`;
}

function resourceText(resource) {
  if (!resource || resource.body == null) return '';
  return resource.base64Encoded ? base64ToText(resource.body) : typeof resource.body === 'string' ? resource.body : '';
}

function restoreSsrHydration(html, bodies, pageUrl) {
  const documentResponse = bodies.find((resource) => {
    try {
      return normalizeUrl(resource.url) === normalizeUrl(pageUrl) && (resource.mimeType || '').toLowerCase().startsWith('text/html');
    } catch (error) {
      return false;
    }
  });
  const source = resourceText(documentResponse);
  if (!source || !/\$_TSR|tsr-stream-barrier|self\.\$R/.test(source) || /\$_TSR|tsr-stream-barrier/.test(html)) return html;

  const scripts = [];
  const expression = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = expression.exec(source)) !== null) {
    if (!/\$_TSR|tsr-stream-barrier|self\.\$R/.test(match[2])) continue;
    scripts.push(`<script${match[1]}>${match[2]}</script>`);
  }
  if (!scripts.length) return html;

  const hydration = scripts.join('');
  const moduleScript = /<script\b(?=[^>]*\btype=["']module["'])[^>]*>/i;
  const moduleMatch = html.match(moduleScript);
  if (moduleMatch && moduleMatch.index !== undefined) {
    return `${html.slice(0, moduleMatch.index)}${hydration}${html.slice(moduleMatch.index)}`;
  }
  return html.replace(/<\/body>/i, `${hydration}</body>`);
}

function createSpaFallback() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    const route = location.pathname + location.search + location.hash;
    location.replace('/?__sitesaver_route=' + encodeURIComponent(route));
  </script>
</head>
<body></body>
</html>`;
}

function createOfflineServiceWorker(resources, snapshots) {
  const precache = ['/', '/index.html', '/404.html', '/sitesaver-offline.js', '/sitesaver-sw.js', ...resources.map((resource) => `/${resource.localPath}`), ...snapshots.map((snapshot) => snapshot.localPath)];
  const pageRoutes = {};
  resources.forEach((resource) => {
    if (!(resource.mimeType || '').toLowerCase().startsWith('text/html')) return;
    try {
      const url = new URL(resource.url);
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const key = pathname + url.search;
      if (key !== '/') pageRoutes[key] = `/${resource.localPath}`;
      for (const alias of resource.aliases || []) {
        const aliasUrl = new URL(alias);
        const aliasPathname = aliasUrl.pathname.length > 1 ? aliasUrl.pathname.replace(/\/+$/, '') : aliasUrl.pathname;
        const aliasKey = aliasPathname + aliasUrl.search;
        if (aliasKey !== '/') pageRoutes[aliasKey] = `/${resource.localPath}`;
      }
    } catch (error) {
      // Ignore invalid URLs for page routes
    }
  });
  const cacheName = `sitesaver-offline-${Date.now().toString(36)}-${shortHash(precache.join('\n'))}`;
  const apiSnapshots = snapshots.map((snapshot) => ({
    method: snapshot.method,
    url: snapshot.url,
    postData: snapshot.postData,
    status: snapshot.status,
    statusText: snapshot.statusText,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath
  }));

  return `const CACHE = ${JSON.stringify(cacheName)};
const PRECACHE = ${JSON.stringify([...new Set(precache)])};
const SNAPSHOTS = ${JSON.stringify(apiSnapshots)};
const PAGE_ROUTES = ${JSON.stringify(pageRoutes)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (path) => {
      try { await cache.add(path); } catch (error) { /* Reported in sitesaver-report.json. */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith('sitesaver-offline-') && name !== CACHE).map((name) => caches.delete(name)));
  await self.clients.claim();
})()));

const bodyFor = async (request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return '';
  try { return await request.clone().text(); } catch (error) { return ''; }
};

const findSnapshot = (requestUrl, method, body) => {
  const url = new URL(requestUrl);
  url.hash = '';
  return SNAPSHOTS.find((snapshot) => {
    if (snapshot.method !== method || snapshot.postData !== body) return false;
    if (snapshot.url === url.href) return true;
    const saved = new URL(snapshot.url);
    return url.origin === self.location.origin && saved.pathname + saved.search === url.pathname + url.search;
  });
};

const routeKey = (url) => {
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\\/+$/, '') : url.pathname;
  return pathname + url.search;
};

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const request = event.request;
    const url = new URL(request.url);
    const cache = await caches.open(CACHE);

    if (request.mode === 'navigate') {
      const exact = await cache.match(request, { ignoreSearch: false });
      if (exact) return exact;
      const pagePath = PAGE_ROUTES[routeKey(url)];
      if (pagePath) {
        const page = await cache.match(pagePath);
        if (page) return page;
      }
      return (await cache.match('/index.html')) || new Response('Offline archive is incomplete', { status: 503 });
    }

    if (request.method === 'GET') {
      const pagePath = PAGE_ROUTES[routeKey(url)];
      if (pagePath) {
        const page = await cache.match(pagePath);
        if (page) return page;
      }
    }

    const snapshot = findSnapshot(request.url, request.method, await bodyFor(request));
    if (snapshot) {
      const response = await cache.match(snapshot.localPath);
      if (!response) return new Response(null, { status: 503, statusText: 'Saved API response is unavailable' });
      const headers = new Headers(response.headers);
      if (snapshot.mimeType) headers.set('content-type', snapshot.mimeType);
      return new Response(await response.arrayBuffer(), { status: snapshot.status, statusText: snapshot.statusText, headers });
    }

    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    if (url.origin !== self.location.origin || request.method !== 'GET') {
      return new Response(null, { status: 503, statusText: 'External network blocked by openSave' });
    }
    return new Response(null, { status: 404, statusText: 'Resource was not saved' });
  })());
});`;
}

function createArchiveReadme() {
  return `openSave Offline Archive

This folder is a static web archive. It does not require Node.js or a build step.

Do not run npm install or npm run dev here. This archive is not a Node.js project and intentionally has no package.json.

Windows
- Double-click open-windows.bat.
- It opens the archive at http://127.0.0.1:4173/ and serves it locally.

macOS / Linux
- Run: sh open-unix.sh
- Or serve the folder yourself with any static server at the origin root.

Opening index.html through file:// is not supported because service workers and ES modules require HTTP(S).

Files
- index.html: captured entry document
- assets/: captured CSS, JS, media, fonts, and images, grouped by source host
- api-snapshots/: captured Fetch/XHR response bodies
- sitesaver-sw.js: offline service worker
- sitesaver-offline.js: offline bootstrap
- sitesaver-report.json: capture diagnostics and completeness score
- sitesaver-manifest.json: archive metadata
- open-windows.bat / open-windows.ps1: Windows local launcher
- open-unix.sh: macOS/Linux local launcher
`;
}

function createWindowsBatchLauncher() {
  return `@echo off
setlocal
cd /d "%~dp0"
set PORT=4173

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  py -3 -m http.server %PORT% --bind 127.0.0.1
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" "http://127.0.0.1:%PORT%/"
  python -m http.server %PORT% --bind 127.0.0.1
  exit /b %ERRORLEVEL%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-windows.ps1" -Port %PORT%
`;
}

function createWindowsPowerShellLauncher() {
  return `param([int]$Port = 4173)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = 'http://127.0.0.1:' + $Port + '/'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host 'Could not start the local archive server.'
  Write-Host $_.Exception.Message
  Read-Host 'Press Enter to close'
  exit 1
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.gif' = 'image/gif'
  '.ico' = 'image/x-icon'
  '.wasm' = 'application/wasm'
  '.woff' = 'font/woff'
  '.woff2' = 'font/woff2'
  '.glb' = 'model/gltf-binary'
  '.gltf' = 'model/gltf+json'
}

Start-Process $prefix
Write-Host ('openSave archive server: ' + $prefix)
Write-Host 'Press Ctrl+C to stop.'

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $bytes = $null
  $full = $null
  try {
    $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = 'index.html' }

    $candidate = Join-Path $root $requestPath
    $resolvedRoot = [System.IO.Path]::GetFullPath($root)
    $full = [System.IO.Path]::GetFullPath($candidate)
    if (-not $full.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped archive root' }

    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      if ([System.IO.Path]::GetExtension($requestPath)) {
        $context.Response.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
      } else {
        $full = Join-Path $root 'index.html'
        $bytes = [IO.File]::ReadAllBytes($full)
      }
    } else {
      $bytes = [IO.File]::ReadAllBytes($full)
    }

    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    $context.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
  } catch {
    $context.Response.StatusCode = 500
    $bytes = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
    $context.Response.ContentType = 'text/plain; charset=utf-8'
  }

  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.Close()
}
`;
}

function createUnixLauncher() {
  return `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
PORT="\${PORT:-4173}"
URL="http://127.0.0.1:$PORT/"

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
  if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true; fi
}

if command -v python3 >/dev/null 2>&1; then
  (sleep 1; open_url) &
  python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  (sleep 1; open_url) &
  python -m http.server "$PORT" --bind 127.0.0.1
else
  echo "Python is required to run this launcher. Serve this folder with any static HTTP server."
  exit 1
fi
`;
}

function createOfflineReplayScript(snapshots, renderedPages = []) {
  const manifest = snapshots.map((snapshot) => ({
    method: snapshot.method,
    url: snapshot.url,
    postData: snapshot.postData,
    status: snapshot.status,
    statusText: snapshot.statusText,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath
  }));

  const historyRoutes = renderedPages.filter((page) => page.transitionKind === 'history').map((page) => {
    const url = new URL(page.routeUrl || page.url);
    return { route: url.pathname + url.search + url.hash, localPath: `/${page.localPath}` };
  });

  return `(() => {
  const snapshots = ${JSON.stringify(manifest)};
  const historyRoutes = ${JSON.stringify(historyRoutes)};
  const currentRoute = location.pathname + location.search + location.hash;
  const historyPage = historyRoutes.find((route) => route.route === currentRoute);
  const historyKey = 'opensave-history:' + currentRoute;
  if (historyPage && sessionStorage.getItem(historyKey) !== 'loaded') {
    sessionStorage.setItem(historyKey, 'loaded');
    fetch(historyPage.localPath).then((response) => response.text()).then((html) => {
      document.open();
      document.write(html);
      document.close();
    }).catch(() => {});
  }
  const restoreLiveState = (root = document) => {
    for (const template of root.querySelectorAll('template[data-opensave-shadowroot]')) {
      const host = template.parentElement;
      if (!host) continue;
      let root = host.shadowRoot;
      if (!root) {
        try { root = host.attachShadow({ mode: 'open' }); } catch (error) { continue; }
      }
      root.replaceChildren(template.content.cloneNode(true));
      template.remove();
      restoreLiveState(root);
    }
    for (const element of root.querySelectorAll('[data-opensave-indeterminate]')) element.indeterminate = true;
    for (const element of root.querySelectorAll('[data-opensave-popover-open]')) {
      try { if (element.showPopover) element.showPopover(); } catch (error) {}
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => restoreLiveState(), { once: true });
  else restoreLiveState();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sitesaver-sw.js').catch(() => {});
  }
  const route = new URLSearchParams(location.search).get('__sitesaver_route');
  if (route) history.replaceState(null, '', route);

  const normalizeUrl = (value) => {
    const url = new URL(value, location.href);
    url.hash = '';
    return url.href;
  };

  const normalizeBody = (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return '';
  };

  const blockedResponse = () => new Response(null, { status: 503, statusText: 'Offline snapshot is unavailable' });

  const matchSnapshot = (method, url, body) => {
    const requestUrl = new URL(url, location.href);
    requestUrl.hash = '';
    return snapshots.find((snapshot) => {
      if (snapshot.method !== method || snapshot.postData !== body) return false;
      if (snapshot.url === requestUrl.href) return true;
      const savedUrl = new URL(snapshot.url);
      return requestUrl.origin === location.origin && savedUrl.pathname + savedUrl.search === requestUrl.pathname + requestUrl.search;
    });
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init);
    let body = normalizeBody(init.body);
    if (!body && request.method !== 'GET' && request.method !== 'HEAD') {
      try { body = await request.clone().text(); } catch (error) { return blockedResponse(); }
    }
    const snapshot = matchSnapshot(request.method, request.url, body);
    if (!snapshot) return blockedResponse();

    const local = await nativeFetch(snapshot.localPath);
    if (!local.ok) return new Response(null, { status: 503, statusText: 'Saved API response is unavailable' });
    const headers = new Headers(local.headers);
    if (snapshot.mimeType) headers.set('content-type', snapshot.mimeType);
    return new Response(await local.arrayBuffer(), {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers
    });
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__siteSaverRequest = { method: String(method).toUpperCase(), url, rest };
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = this.__siteSaverRequest;
    const snapshot = request && matchSnapshot(request.method, request.url, normalizeBody(body));
    if (!snapshot) {
      this.abort();
      return;
    }
    nativeOpen.call(this, 'GET', snapshot.localPath, true);
    return nativeSend.call(this);
  };

  navigator.sendBeacon = () => false;
  window.WebSocket = function() { throw new Error('WebSocket is unavailable in the offline archive'); };
  window.EventSource = function() { throw new Error('EventSource is unavailable in the offline archive'); };
})();`;
}

function createCatalog(bodies, pageUrl) {
  const resources = [];
  const byUrl = new Map();
  const routePages = new Map();
  const usedPaths = new Set();

  const add = (resource) => {
    let url;
    try {
      url = normalizeUrl(resource.url);
    } catch (error) {
      return null;
    }
    if (resource.routePage && resource.routeId && routePages.has(resource.routeId)) return routePages.get(resource.routeId);
    if (!resource.routePage && byUrl.has(url)) return byUrl.get(url);

    const basePath = archivePathFor(url, resource.mimeType);
    let localPath = basePath;
    let suffix = 2;
    while (usedPaths.has(localPath)) {
      const dot = basePath.lastIndexOf('.');
      localPath = dot > 0
        ? `${basePath.slice(0, dot)}-${suffix}${basePath.slice(dot)}`
        : `${basePath}-${suffix}`;
      suffix += 1;
    }

    const entry = { ...resource, url, localPath };
    usedPaths.add(localPath);
    if (!byUrl.has(url)) byUrl.set(url, entry);
    if (resource.routePage && resource.routeId) routePages.set(resource.routeId, entry);
    resources.push(entry);
    return entry;
  };

  bodies.forEach(add);

  return { resources, byUrl, routePages, add };
}

async function finalProjectionParity(graph, catalog, replaySnapshots) {
  const projectedBodies = CaptureGraph.projectV1Bodies(graph);
  const projectedPages = CaptureGraph.projectRenderedPages(graph);
  const projectedSnapshots = CaptureGraph.projectV1ApiSnapshots(graph);
  const bodyFields = ['url', 'mimeType'];
  const snapshotFields = ['url', 'method', 'postData', 'status', 'statusText', 'mimeType'];
  const bodyHash = (item) => item.contentHash || CaptureGraph.contentHashForBody(item.body, item.base64Encoded);
  const renderedDocumentUrls = new Set(projectedPages.map((page) => normalizeUrl(page.url)));
  const expectedBodies = projectedBodies.filter((body) => !((body.mimeType || '').toLowerCase().startsWith('text/html') && renderedDocumentUrls.has(normalizeUrl(body.url))));
  const projectedBodyHashes = await Promise.all(expectedBodies.map(bodyHash));
  const projectedPageHashes = await Promise.all(projectedPages.map(bodyHash));
  const catalogBodyHashes = await Promise.all(catalog.resources.map(bodyHash));
  const projectedSnapshotHashes = await Promise.all(projectedSnapshots.map(bodyHash));
  const replaySnapshotHashes = await Promise.all(replaySnapshots.map(bodyHash));
  const bodyMatches = expectedBodies.map((item, index) => catalog.resources.some((catalogItem, catalogIndex) =>
    !catalogItem.routePage && bodyFields.every((field) => item[field] === catalogItem[field]) && Boolean(item.preserveUrl) === Boolean(catalogItem.preserveUrl) && projectedBodyHashes[index] === catalogBodyHashes[catalogIndex]
  ));
  const pageMatches = projectedPages.map((item, index) => catalog.resources.some((catalogItem, catalogIndex) =>
    catalogItem.routePage && catalogItem.routeId === item.routeId && projectedPageHashes[index] === catalogBodyHashes[catalogIndex]
  ));
  const bodiesMatch = bodyMatches.every(Boolean) && pageMatches.every(Boolean);
  const snapshotsMatch = projectedSnapshots.length === replaySnapshots.length && projectedSnapshots.every((item, index) =>
    snapshotFields.every((field) => item[field] === replaySnapshots[index][field]) && projectedSnapshotHashes[index] === replaySnapshotHashes[index]
  );
  const bodyMismatchIndex = bodiesMatch ? -1 : bodyMatches.findIndex((match) => !match);
  const pageMismatchIndex = bodiesMatch ? -1 : pageMatches.findIndex((match) => !match);
  return {
    bodiesMatch,
    snapshotsMatch,
    bodyCounts: { projected: expectedBodies.length, renderedPages: projectedPages.length, catalog: catalog.resources.length },
    firstBodyMismatch: bodyMismatchIndex >= 0 ? {
      index: bodyMismatchIndex,
      projectedUrl: expectedBodies[bodyMismatchIndex].url,
      differingFields: ['missing-network-body']
    } : pageMismatchIndex >= 0 ? {
      index: pageMismatchIndex,
      projectedUrl: projectedPages[pageMismatchIndex].url,
      differingFields: ['missing-rendered-page']
    } : null
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function collectMissingFiles(html, pageUrl, catalog, report, includePages = true, graph = null, fallbackPageUrls = []) {
  const queue = [];
  const queued = new Set();
  let pagesQueued = 0;
  const missionId = graph && graph.missions[0] && graph.missions[0].id;
  const targetId = graph && graph.targets[0] && graph.targets[0].id;
  const ownerEvidenceId = graph && graph.documents[0] && graph.documents[0].id;

  const enqueue = (url, kind, discoveredFrom = ownerEvidenceId, syntaxKind = 'legacy-discovery', reference = null) => {
    const normalized = normalizeUrl(url);
    if (kind === 'resource') addReportItem(report, 'discoveredResources', { url: normalized });
    if (graph) {
      CaptureGraph.addDependencyEdge(graph, {
        missionId,
        ownerEvidenceId: discoveredFrom,
        originalUrl: normalized,
        syntaxKind: reference ? reference.syntaxKind : syntaxKind,
        rawValue: reference ? reference.rawValue : normalized,
        resolvedUrl: reference ? reference.resolvedUrl : normalized,
        sourceLocation: reference ? reference.location : null,
        role: reference ? reference.role : kind,
        rewritePolicy: reference ? reference.rewritePolicy : 'block-unresolved-subresource',
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
    }
    if (catalog.byUrl.has(normalized) || queued.has(normalized)) return;
    if (kind === 'page') {
      if (pagesQueued >= MAX_PAGES) {
        addReportItem(report, 'truncatedDiscovery', { kind: 'page', limit: MAX_PAGES });
        return;
      }
      pagesQueued += 1;
    }
    if (queue.length >= MAX_FALLBACK_RESOURCES) {
      addReportItem(report, 'truncatedDiscovery', { kind: 'resource', limit: MAX_FALLBACK_RESOURCES });
      return;
    }
    queued.add(normalized);
    queue.push({ url: normalized, kind });
  };

  const siteOrigin = new URL(pageUrl).origin;
  const runParserAdapter = (adapter, discoveredFrom, callback) => {
    try {
      return callback();
    } catch (error) {
      if (graph) CaptureGraph.addDiagnostic(graph, {
        missionId,
        code: `resource-parser-${adapter}-failed`,
        severity: 'warning',
        phase: 'resource-discovery',
        message: error.message,
        evidenceRefs: [discoveredFrom].filter(Boolean),
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
      return [];
    }
  };
  const discover = (content, baseUrl, includePages, discoveredFrom = ownerEvidenceId) => {
    runParserAdapter('html', discoveredFrom, () => extractResourceReferences(content, baseUrl, discoveredFrom)).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', discoveredFrom, reference.syntaxKind, reference));
    extractLegacyImportMapUrls(content, baseUrl).forEach((url) => enqueue(url, 'resource', discoveredFrom, 'legacy-import-map'));
    if (includePages) extractPageUrls(content, baseUrl, siteOrigin).forEach((url) => enqueue(url, 'page', discoveredFrom, 'html-link'));
  };

  discover(html, pageUrl, includePages);
  fallbackPageUrls.forEach((url) => enqueue(url, 'page', ownerEvidenceId, 'rendered-navigation-fallback'));

  for (const resource of [...catalog.resources]) {
    if (!isTextResource(resource) || resource.preserveUrl) continue;
    try {
      const text = resource.base64Encoded ? base64ToText(resource.body) : resource.body instanceof Blob
        ? await resource.body.text()
        : resource.body;
      const type = (resource.mimeType || '').toLowerCase();
      const resourceEvidenceId = (resource.evidenceRefs || []).findLast((id) => String(id).startsWith('body-')) || ownerEvidenceId;
      if (type.startsWith('text/html')) discover(text, resource.url, includePages, resourceEvidenceId);
      if (type.startsWith('text/css')) runParserAdapter('css', resourceEvidenceId, () => extractCssReferences(text, resource.url, resourceEvidenceId)).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', resourceEvidenceId, reference.syntaxKind, reference));
      if (type.startsWith('image/svg+xml')) runParserAdapter('svg', resourceEvidenceId, () => ResourceParser.discoverSvgReferences(text, { baseUrl: resource.url, ownerArtifact: resourceEvidenceId }).filter((reference) => reference.resolvedUrl && isHttpUrl(reference.resolvedUrl))).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', resourceEvidenceId, reference.syntaxKind, reference));
      if (isGltfResource(resource)) extractGltfUrls(text, resource.url).forEach((url) => enqueue(url, 'resource', resourceEvidenceId, 'gltf'));
      if (/(?:java|ecma)script/.test(type) || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)) {
        runParserAdapter('javascript', resourceEvidenceId, () => extractJavaScriptReferences(text, resource.url, resourceEvidenceId)).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', resourceEvidenceId, reference.syntaxKind, reference));
        extractSourceMapUrls(text, resource.url).forEach((url) => enqueue(url, 'resource', resourceEvidenceId, 'source-map'));
      }
    } catch (error) {
      addReportItem(report, 'unresolvedResources', { url: resource.url, reason: `Cannot inspect captured text: ${error.message}` });
    }
  }

  let fetched = 0;
  while (queue.length > 0) {
    const item = queue.shift();
    let graphRequest = null;
    let graphResponse = null;
    status(`Дозагрузка ${fetched + 1}/${fetched + queue.length + 1}`, 15 + Math.round((fetched / MAX_FALLBACK_RESOURCES) * 35));
    try {
      if (graph) {
        graphRequest = CaptureGraph.addRequest(graph, {
          missionId,
          targetId,
          method: 'GET',
          originalUrl: item.url,
          timestamp: Date.now(),
          provenance: CaptureGraph.PROVENANCE.REFETCHED,
          evidenceRefs: graph.dependencyEdges.filter((edge) => edge.normalizedUrl === item.url).map((edge) => edge.id)
        });
      }
      const response = await fetch(item.url, { credentials: 'include', cache: 'no-store' });
      if (graph) {
        graphResponse = CaptureGraph.addResponse(graph, {
          missionId,
          targetId,
          requestId: graphRequest.id,
          originalUrl: response.url || item.url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          mimeType: response.headers.get('content-type') || '',
          resourceType: item.kind === 'page' ? 'Document' : 'Resource',
          timestamp: Date.now(),
          provenance: CaptureGraph.PROVENANCE.REFETCHED,
          evidenceRefs: [graphRequest.id]
        });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.size > MAX_FALLBACK_FILE_SIZE) throw new Error('файл больше 200 MB');

      const graphBody = graph && await CaptureGraph.addBody(graph, {
        missionId,
        responseId: graphResponse.id,
        body: blob,
        base64Encoded: false,
        mimeType: response.headers.get('content-type') || blob.type,
        provenance: CaptureGraph.PROVENANCE.REFETCHED,
        evidenceRefs: [graphRequest.id]
      }, { bodyStore: captureStorage });
      let fetchedOwnerId = graphBody && graphBody.id;
      if (graph && item.kind === 'page') {
        const document = CaptureGraph.addDocument(graph, {
          missionId,
          targetId,
          responseId: graphResponse.id,
          originalUrl: response.url || item.url,
          documentKind: 'unrendered-refetch',
          bodyId: graphBody.id,
          provenance: CaptureGraph.PROVENANCE.REFETCHED,
          evidenceRefs: [graphRequest.id, graphResponse.id, graphBody.id]
        });
        fetchedOwnerId = document.id;
        const route = graph.routes.find((candidate) => candidate.routeUrl === item.url && candidate.state === 'failed');
        if (route) {
          route.state = 'captured';
          route.decisionReason = 'rendered-navigation-failed-fetch-fallback';
          route.finalUrl = response.url || item.url;
          route.documentId = document.id;
          route.fidelity = 'unrendered-refetch';
          route.idleResult = route.idleResult || 'navigation-failed';
          document.routeId = route.id;
        }
      }

      const resource = catalog.add({
        url: item.url,
        mimeType: response.headers.get('content-type') || blob.type,
        body: blob,
        base64Encoded: false,
        storageKey: graphBody && graphBody.storageKey,
        contentHash: graphBody && graphBody.contentHash,
        provenance: CaptureGraph.PROVENANCE.REFETCHED,
        evidenceRefs: graph ? [graphRequest.id, graphResponse.id, graphBody.id] : []
      });
      if (graph) {
        graph.dependencyEdges.filter((edge) => edge.normalizedUrl === item.url && !edge.targetEvidenceId).forEach((edge) => {
          edge.targetEvidenceId = graphResponse.id;
          edge.disposition = 'refetched';
        });
        await saveGraphMission(graph, 'exporting');
      }
      fetched += 1;
      log(`+ ${resource.localPath}`, 'ok');

      if (isTextResource(resource)) {
        const text = await blob.text();
        if ((resource.mimeType || '').toLowerCase().startsWith('text/html')) discover(text, item.url, includePages, fetchedOwnerId);
        if ((resource.mimeType || '').toLowerCase().startsWith('text/css')) {
          runParserAdapter('css', fetchedOwnerId, () => extractCssReferences(text, item.url, fetchedOwnerId)).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', fetchedOwnerId, reference.syntaxKind, reference));
        }
        if ((resource.mimeType || '').toLowerCase().startsWith('image/svg+xml')) {
          runParserAdapter('svg', fetchedOwnerId, () => ResourceParser.discoverSvgReferences(text, { baseUrl: item.url, ownerArtifact: fetchedOwnerId }).filter((reference) => reference.resolvedUrl && isHttpUrl(reference.resolvedUrl))).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', fetchedOwnerId, reference.syntaxKind, reference));
        }
        if (isGltfResource(resource)) {
          extractGltfUrls(text, item.url).forEach((url) => enqueue(url, 'resource', fetchedOwnerId, 'gltf'));
        }
        if (/(?:java|ecma)script/.test(resource.mimeType || '') || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)) {
          runParserAdapter('javascript', fetchedOwnerId, () => extractJavaScriptReferences(text, item.url, fetchedOwnerId)).forEach((reference) => enqueue(reference.resolvedUrl, 'resource', fetchedOwnerId, reference.syntaxKind, reference));
          extractSourceMapUrls(text, item.url).forEach((url) => enqueue(url, 'resource', fetchedOwnerId, 'source-map'));
        }
      }
    } catch (error) {
      if (graph) {
        if (graphResponse && graphResponse.bodyState === 'pending') CaptureGraph.markResponseBodyUnavailable(graph, graphResponse.id, error.message);
        CaptureGraph.addDiagnostic(graph, {
          missionId,
          code: item.kind === 'page' ? 'refetch-page-failed' : 'refetch-resource-failed',
          severity: 'warning',
          phase: 'refetch',
          message: error.message,
          evidenceRefs: [graphRequest && graphRequest.id, graphResponse && graphResponse.id].filter(Boolean),
          provenance: CaptureGraph.PROVENANCE.REFETCHED
        });
      }
      if (error && error.code === 'quota-exhausted') throw error;
      if (item.kind === 'page') {
        addReportItem(report, 'unavailablePages', { url: item.url, reason: error.message });
        log(`Страница недоступна: ${item.url} (${error.message})`, 'err');
      } else {
        addReportItem(report, 'unresolvedResources', { url: item.url, reason: error.message });
        log(`Ресурс не сохранён: ${item.url} (${error.message})`, 'err');
      }
    }
  }

  return fetched;
}

async function rewriteTextResources(resources, resolver, byUrl, graph = null) {
  for (const resource of resources) {
    if (!isTextResource(resource) || resource.preserveUrl) continue;
    try {
      const text = resource.base64Encoded ? base64ToText(resource.body) : resource.body instanceof Blob
        ? await resource.body.text()
        : resource.body;
      const type = (resource.mimeType || '').toLowerCase();
      let rewritten = text;
      let diagnostics = [];
      if (type.startsWith('text/html')) rewritten = rewriteHtmlResource(text, resource.url, resolver, diagnostics);
      else if (type.startsWith('text/css')) ({ source: rewritten, diagnostics } = rewriteCssUrls(text, resource.url, resolver));
      else if (type.startsWith('image/svg+xml')) ({ source: rewritten, diagnostics } = ResourceParser.rewriteSvg(text, { baseUrl: resource.url, resolver }));
      else if (isGltfResource(resource)) rewritten = rewriteGltfUrls(text, resource.url, byUrl);
      else if (/(?:java|ecma)script/.test(type) || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)) ({ source: rewritten, diagnostics } = rewriteJavaScriptUrls(text, resource.url, resolver));
      if (graph) {
        for (const diagnostic of diagnostics) {
          CaptureGraph.addDiagnostic(graph, {
            missionId: graph.missions[0] && graph.missions[0].id,
            code: diagnostic.code,
            severity: diagnostic.severity,
            phase: diagnostic.phase,
            message: diagnostic.message,
            evidenceRefs: resource.evidenceRefs || [],
            provenance: CaptureGraph.PROVENANCE.DERIVED
          });
        }
        const artifact = await CaptureGraph.addDerivedArtifact(graph, {
          missionId: graph.missions[0] && graph.missions[0].id,
          artifactType: 'rewritten-resource',
          body: rewritten,
          mimeType: resource.mimeType || '',
          originalUrl: resource.url,
          inputEvidenceIds: resource.evidenceRefs || [],
          transform: 'typed-resource-rewriter',
          transformVersion: 2
        }, { bodyStore: captureStorage });
        resource.evidenceRefs = [...(resource.evidenceRefs || []), artifact.id, artifact.bodyId];
        resource.derivedArtifactId = artifact.id;
      }
      resource.body = resource.routePage && type.startsWith('text/html') ? injectOfflineBootstrap(rewritten) : rewritten;
      resource.base64Encoded = false;
    } catch (error) {
      if (error && error.code === 'quota-exhausted') throw error;
      if (graph) CaptureGraph.addDiagnostic(graph, {
        missionId: graph.missions[0] && graph.missions[0].id,
        code: 'resource-parser-rewrite-failed',
        severity: 'warning',
        phase: 'resource-rewrite',
        message: error.message,
        evidenceRefs: resource.evidenceRefs || [],
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
      log(`Не удалось переписать ${resource.localPath}: ${error.message}`, 'err');
    }
  }
}

function resetInterface() {
  btnCapture.disabled = false;
  btnRecord.disabled = false;
  btnFinishScenario.hidden = true;
  btnRecord.hidden = false;
  btnPickElement.disabled = false;
  btnPickElement.textContent = 'Выбрать блок на странице';
  btnCancelCapture.hidden = true;
  btnCancelCapture.disabled = false;
  captureModeEl.querySelectorAll('input').forEach((input) => { input.disabled = false; });
  updateCaptureLabel();
}

function selectedCaptureMode() {
  return captureModeEl.querySelector('input:checked').value;
}

function updateCaptureLabel() {
  btnCapture.textContent = selectedCaptureMode() === 'deep' ? 'Скачать сайт глубоко' : 'Скачать страницу быстро';
}

function createSelectedDocument(selected) {
  const document = new DOMParser().parseFromString(`<!doctype html><html><head>${selected.head}</head><body>${selected.html}</body></html>`, 'text/html');
  document.querySelectorAll('base').forEach((element) => element.remove());
  document.title = selected.title;
  document.body.className = selected.bodyClass || '';
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

async function downloadZip(zip, filename) {
  const archive = await zip.generateAsync({ type: 'blob', streamFiles: true });
  await downloadArchiveBlob(archive, filename);
  return archive.size;
}

async function downloadArchiveBlob(archive, filename) {
  const url = URL.createObjectURL(archive);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        if (error) reject(error);
        else resolve();
      };
      const inspect = async () => {
        try {
          const [download] = await chrome.downloads.search({ id: downloadId });
          if (!download || download.state === 'interrupted') {
            finish(new Error(`Скачивание архива прервано${download && download.error ? `: ${download.error}` : ''}`));
          } else if (download.state === 'complete') {
            finish();
          }
        } catch (error) {
          // The onChanged listener remains authoritative if a status query fails.
        }
      };
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.error) {
          finish(new Error(`Скачивание архива прервано: ${delta.error.current}`));
          return;
        }
        if (delta.state && delta.state.current === 'complete') finish();
      };
      const poll = setInterval(inspect, 50);
      const timeout = setTimeout(() => finish(new Error('Скачивание архива не завершилось за 5 минут')), 5 * 60 * 1000);
      chrome.downloads.onChanged.addListener(listener);
      inspect();
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function exportSelectedElement(selected) {
  btnCapture.disabled = true;
  btnRecord.disabled = true;
  btnPickElement.disabled = true;
  btnPickElement.disabled = true;
  progress.style.display = 'block';
  logEl.textContent = '';
  logEl.style.display = 'none';
  reportEl.style.display = 'none';

  try {
    if (!selected || !selected.html || !selected.pageUrl) throw new Error('Расширение не получило выбранный блок');
    status('Собираю стили и ассеты блока...', 15);
    log(`Выбран: ${selected.label}`);

    const report = { unresolvedResources: [], unavailablePages: [], truncatedDiscovery: [], discoveredResources: [] };
    const markup = createSelectedDocument(selected);
    const graph = CaptureGraph.createCaptureGraph();
    const mission = CaptureGraph.addMission(graph, {
      id: `capture-${crypto.randomUUID()}`,
      missionType: 'selection',
      captureMode: 'selection',
      sourceUrl: selected.pageUrl,
      startedAt: Date.now()
    });
    await captureStorageReady;
    await captureStorage.createMission({
      id: mission.id,
      state: 'exporting',
      sourceUrl: selected.pageUrl,
      captureMode: 'selection',
      graph
    });
    exportingMissionId = mission.id;
    const target = CaptureGraph.addTarget(graph, {
      missionId: mission.id,
      targetType: 'page',
      originalUrl: selected.pageUrl
    });
    const markupArtifact = await CaptureGraph.addDerivedArtifact(graph, {
      missionId: mission.id,
      artifactType: 'selected-document-html',
      body: markup,
      mimeType: 'text/html',
      originalUrl: selected.pageUrl,
      transform: 'selection-serializer',
      transformVersion: 1
    }, { bodyStore: captureStorage });
    const graphDocument = CaptureGraph.addDocument(graph, {
      missionId: mission.id,
      targetId: target.id,
      originalUrl: selected.pageUrl,
      documentKind: 'selection',
      bodyId: markupArtifact.bodyId,
      snapshotVersion: selected.version || 1,
      stateSummary: selected.summary || {},
      provenance: CaptureGraph.PROVENANCE.DERIVED,
      evidenceRefs: [markupArtifact.id]
    });
    for (const diagnostic of selected.diagnostics || []) {
      CaptureGraph.addDiagnostic(graph, {
        missionId: mission.id,
        code: diagnostic.code,
        severity: 'warning',
        phase: 'live-dom-state',
        message: diagnostic.reason,
        occurrenceCount: diagnostic.count,
        evidenceRefs: [graphDocument.id, markupArtifact.id],
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
    }
    const catalog = createCatalog([], selected.pageUrl);
    const fetched = await collectMissingFiles(markup, selected.pageUrl, catalog, report, false, graph);
    log(`Дозагружено зависимостей: ${fetched}`);

    status('Переписываю пути...', 55);
    const resolver = createResourceResolver(catalog.byUrl, graph);
    const entryDiagnostics = [];
    const html = rewriteHtmlResource(markup, selected.pageUrl, resolver, entryDiagnostics);
    for (const diagnostic of entryDiagnostics) CaptureGraph.addDiagnostic(graph, {
      missionId: mission.id,
      code: diagnostic.code,
      severity: diagnostic.severity,
      phase: diagnostic.phase,
      message: diagnostic.message,
      evidenceRefs: [markupArtifact.id],
      provenance: CaptureGraph.PROVENANCE.DERIVED
    });
    await rewriteTextResources(catalog.resources, resolver, catalog.byUrl, graph);
    mission.state = 'completed';
    mission.completedAt = Date.now();
    await saveGraphMission(graph, 'completed');
    const finalReport = CaptureGraph.projectReport(graph, finalizeReport(report, catalog));
    renderReport(finalReport);

    status('Собираю точечный архив...', 75);
    const zip = new JSZip();
    zip.file('index.html', html);
    zip.file('sitesaver-selection.json', JSON.stringify({
      pageUrl: selected.pageUrl,
      label: selected.label,
      exportedAt: new Date().toISOString()
    }, null, 2));
    zip.file('sitesaver-report.json', JSON.stringify(finalReport, null, 2));
    for (const resource of catalog.resources) {
      zip.file(resource.localPath, resource.body, resource.base64Encoded ? { base64: true } : undefined);
    }

    status('Скачиваю блок...', 92);
    const size = await downloadZip(zip, 'sitesaver-selection.zip');
    await captureStorage.cleanupMission(mission.id);
    exportingMissionId = null;
    log(`Точечный архив: ${(size / 1024 / 1024).toFixed(2)} MB, ${catalog.resources.length + 3} файлов`, 'ok');
    status('Готово', 100);
  } catch (error) {
    if (exportingMissionId) {
      await captureStorage.saveMission(exportingMissionId, {
        state: 'export-failed',
        pendingWork: [],
        recovery: { recoverable: true, interruptedAt: Date.now(), reason: error.code || 'export-failed' }
      }).catch(() => {});
      await captureStorage.cleanupTemporaryBodies(exportingMissionId).catch(() => {});
    }
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
  } finally {
    exportingMissionId = null;
    progress.style.display = 'none';
    resetInterface();
  }
}

async function capture(action = 'fullCapture') {
  const mode = selectedCaptureMode();
  let graph = null;
  let missionId = null;
  btnCapture.disabled = true;
  btnRecord.disabled = true;
  btnCapture.textContent = 'Захват...';
  captureModeEl.querySelectorAll('input').forEach((input) => { input.disabled = true; });
  btnCancelCapture.hidden = mode !== 'deep';
  progress.style.display = 'block';
  logEl.textContent = '';
  logEl.style.display = 'none';
  reportEl.style.display = 'none';

  try {
    const tab = await getActiveTab();
    if (!tab) throw new Error('Нет активной вкладки');

    status(mode === 'deep' ? 'Глубокий захват: подключаюсь...' : 'Быстрый захват: подключаюсь...', 5);
    const result = await chrome.runtime.sendMessage({ action, tabId: tab.id, mode });
    if (!result || !result.ok) throw new Error((result && result.error) || 'нет ответа от расширения');

    const { html, captureGraph: capturedGraph, interaction, liveDomState, report, domain, htmlMethod, pageUrl, mode: capturedMode = mode } = result;
    graph = capturedGraph;
    if (!html) throw new Error('Страница вернула пустой HTML');
    const graphErrors = CaptureGraph.validateGraph(graph);
    if (graphErrors.length) throw new Error(`Некорректный граф захвата: ${graphErrors[0]}`);
    missionId = graph.missions[0] && graph.missions[0].id;
    exportingMissionId = missionId;
    await captureStorageReady;
    await saveGraphMission(graph, 'exporting');
    const bodyProjection = CaptureGraph.projectV1Bodies(graph);
    const snapshotProjection = CaptureGraph.projectV1ApiSnapshots(graph);
    const renderedProjection = CaptureGraph.projectRenderedPages(graph);
    const hydratedProjection = await hydrateDurableProjection([...bodyProjection, ...snapshotProjection, ...renderedProjection]);
    const bodies = hydratedProjection.slice(0, bodyProjection.length);
    const apiSnapshots = hydratedProjection.slice(bodyProjection.length, bodyProjection.length + snapshotProjection.length);
    const renderedPages = hydratedProjection.slice(bodyProjection.length + snapshotProjection.length);

    log(`HTML: ${(html.length / 1024).toFixed(1)} KB (${htmlMethod})`);
    log(`Перехвачено ответов: ${bodies.length}`);
    log(capturedMode === 'deep' ? 'Режим: глубокий захват' : 'Режим: быстрый захват');
    if (interaction) log(`Интерактивных элементов: ${interaction.clicked} нажато, ${interaction.skipped} пропущено`);
    if (interaction && interaction.startActivation && interaction.startActivation.clicked) log(`Стартовый overlay активирован после ${interaction.startActivation.waited} мс ожидания`);
    if (interaction && interaction.hover) log(`Hover-элементов: ${interaction.hover.hovered}, scroll-контейнеров: ${interaction.scrollContainers}`);
    if (interaction && interaction.replayedScenario.total) log(`Сценарий: ${interaction.replayedScenario.replayed}/${interaction.replayedScenario.total} действий повторено`);
    if (liveDomState) log(`Live DOM: ${liveDomState.shadowRoots || 0} shadow, ${liveDomState.canvases || 0} canvas, ${liveDomState.redactedFields || 0} redacted`);
    renderReport(report);
    status('Собираю ресурсы...', 10);

    const captureReport = CaptureGraph.projectReport(graph, report || {});
    captureReport.captureMode = capturedMode;
    captureReport.pageUrl = pageUrl;
    const catalog = createCatalog(renderedPages.map((page) => ({ ...page, routePage: true })), pageUrl);
    bodies.forEach((body) => catalog.add(body));
    const fallbackPageUrls = graph.routes.filter((route) => route.state === 'failed' && route.decisionReason === 'rendered-navigation-failed').map((route) => route.routeUrl);
    const fetched = await collectMissingFiles(html, pageUrl, catalog, captureReport, false, graph, fallbackPageUrls);
    log(`Дозагружено ссылок и ресурсов: ${fetched}`);
    const pageOrigin = new URL(pageUrl).origin;
    const savedPageCount = graph.routes.filter((route) => route.state === 'captured').length || catalog.resources.filter((resource) => {
      try {
        return (resource.mimeType || '').toLowerCase().startsWith('text/html') && new URL(resource.url).origin === pageOrigin;
      } catch (error) {
        return false;
      }
    }).length;
    captureReport.savedPageCount = savedPageCount;
    log(`Сохранено HTML-страниц: ${savedPageCount}`);

    const replaySnapshots = [];
    for (const snapshot of apiSnapshots) {
      try {
        replaySnapshots.push({
          ...snapshot,
          localPath: `/${apiSnapshotPath(snapshot)}`
        });
      } catch (error) {
        // Skip invalid URL snapshot entries without failing the whole archive build.
      }
    }
    log(`Снимков Fetch/XHR: ${replaySnapshots.length}`);
    captureReport.captureGraphParity.finalArchiveInputsMatch = await finalProjectionParity(graph, catalog, replaySnapshots);

    status('Переписываю пути...', 55);
    const resolver = createResourceResolver(catalog.byUrl, graph);
    const entryDiagnostics = [];
    const rewrittenHtml = rewriteHtmlResource(html, pageUrl, resolver, entryDiagnostics);
    const hydratedHtml = restoreSsrHydration(rewrittenHtml, bodies, pageUrl);
    const fixedHtml = injectOfflineBootstrap(hydratedHtml);
    for (const diagnostic of entryDiagnostics) CaptureGraph.addDiagnostic(graph, {
      missionId: graph.missions[0] && graph.missions[0].id,
      code: diagnostic.code,
      severity: diagnostic.severity,
      phase: diagnostic.phase,
      message: diagnostic.message,
      evidenceRefs: graph.documents.map((document) => document.id),
      provenance: CaptureGraph.PROVENANCE.DERIVED
    });
    await CaptureGraph.addDerivedArtifact(graph, {
      missionId: graph.missions[0] && graph.missions[0].id,
      artifactType: 'archive-entry-html',
      body: fixedHtml,
      mimeType: 'text/html',
      originalUrl: pageUrl,
      inputEvidenceIds: graph.documents.map((document) => document.id),
      transform: 'typed-entry-html-writer',
      transformVersion: 2
    }, { bodyStore: captureStorage });
    await rewriteTextResources(catalog.resources, resolver, catalog.byUrl, graph);
    const mission = graph.missions[0];
    if (mission && mission.state !== 'partial') mission.state = 'completed';
    if (mission) mission.completedAt = Date.now();
    const finalGraphErrors = CaptureGraph.validateGraph(graph);
    if (finalGraphErrors.length) throw new Error(`Некорректный итоговый граф захвата: ${finalGraphErrors[0]}`);
    const finalReport = CaptureGraph.projectReport(graph, finalizeReport(captureReport, catalog));
    await saveGraphMission(graph, 'exporting');
    renderReport(finalReport);

    status('Собираю архив...', 75);
    const zip = new JSZip();
    zip.file('index.html', fixedHtml);
    zip.file('404.html', createSpaFallback());
    zip.file('sitesaver-offline.js', createOfflineReplayScript(replaySnapshots, catalog.resources.filter((resource) => resource.routePage)));
    zip.file('sitesaver-sw.js', createOfflineServiceWorker(catalog.resources, replaySnapshots));
    zip.file('sitesaver-report.json', JSON.stringify(finalReport, null, 2));
    zip.file('sitesaver-manifest.json', JSON.stringify({
      format: 'sitesaver-offline-archive',
      version: 1,
      sourceUrl: pageUrl,
      captureMode: capturedMode,
      capturedAt: new Date().toISOString(),
      resourceCount: catalog.resources.length,
      pageCount: savedPageCount,
      apiSnapshotCount: replaySnapshots.length
    }, null, 2));
    zip.file('README.txt', createArchiveReadme());
    zip.file('open-windows.bat', createWindowsBatchLauncher());
    zip.file('open-windows.ps1', createWindowsPowerShellLauncher());
    zip.file('open-unix.sh', createUnixLauncher(), { unixPermissions: '755' });
    replaySnapshots.forEach((snapshot) => {
      zip.file(snapshot.localPath.slice(1), snapshot.body, snapshot.base64Encoded ? { base64: true } : undefined);
    });
    for (const resource of catalog.resources) {
      zip.file(resource.localPath, resource.body, resource.base64Encoded ? { base64: true } : undefined);
    }

    status('Генерирую архив...', 88);
    const archive = await zip.generateAsync({ type: 'blob', streamFiles: true });
    log(`Архив: ${(archive.size / 1024 / 1024).toFixed(2)} MB, ${catalog.resources.length + 1} файлов`, 'ok');

    status('Скачиваю...', 95);
    await downloadArchiveBlob(archive, `${domain}.zip`);

    await captureStorage.cleanupMission(missionId);
    exportingMissionId = null;

    status('Готово', 100);
    log('Готово. Архив содержит статическую офлайн-копию.', 'ok');
  } catch (error) {
    if (missionId) {
      await captureStorage.saveMission(missionId, {
        state: 'export-failed',
        graph,
        pendingWork: [],
        recovery: { recoverable: true, interruptedAt: Date.now(), reason: error.code || 'export-failed' }
      }).catch(() => {});
      await captureStorage.cleanupTemporaryBodies(missionId).catch(() => {});
    }
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
  } finally {
    exportingMissionId = null;
    progress.style.display = 'none';
    resetInterface();
  }
}

btnCapture.addEventListener('click', () => capture());

btnCancelCapture.addEventListener('click', async () => {
  btnCancelCapture.disabled = true;
  status('Отменяю захват...');
  const result = await chrome.runtime.sendMessage({ action: 'cancelCapture', reason: 'user-cancelled' }).catch((error) => ({ ok: false, error: error.message }));
  if (!result || !result.ok) log((result && result.error) || 'Не удалось отменить захват', 'err');
});

window.addEventListener('beforeunload', () => {
  if (!exportingMissionId) return;
  captureStorage.saveMission(exportingMissionId, {
    state: 'interrupted',
    pendingWork: [],
    recovery: { recoverable: true, interruptedAt: Date.now(), reason: 'side-panel-closed' }
  }).catch(() => {});
  captureStorage.cleanupTemporaryBodies(exportingMissionId).catch(() => {});
});

captureModeEl.addEventListener('change', updateCaptureLabel);
updateCaptureLabel();

btnPickElement.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab) throw new Error('Нет активной вкладки');
    btnCapture.disabled = true;
    btnRecord.disabled = true;
    btnPickElement.disabled = true;
    btnPickElement.textContent = 'Выберите блок на странице';
    status('Наведите на блок и кликните. Esc отменяет выбор.', 0);
    progress.style.display = 'block';
    const result = await chrome.runtime.sendMessage({ action: 'startElementPicker', tabId: tab.id });
    if (!result || !result.ok) throw new Error((result && result.error) || 'не удалось включить выбор блока');
  } catch (error) {
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
    resetInterface();
  }
});

btnRecord.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab) throw new Error('Нет активной вкладки');
    const result = await chrome.runtime.sendMessage({ action: 'recordScenario', tabId: tab.id });
    if (!result || !result.ok) throw new Error((result && result.error) || 'не удалось начать запись');
    btnRecord.hidden = true;
    btnFinishScenario.hidden = false;
    btnCapture.disabled = true;
    captureModeEl.querySelectorAll('input').forEach((input) => { input.disabled = true; });
    status('Сценарий записывается: вручную откройте нужные элементы', 0);
    progress.style.display = 'block';
  } catch (error) {
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
  }
});

btnFinishScenario.addEventListener('click', () => capture('finishScenario'));
