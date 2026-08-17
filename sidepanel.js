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

const MAX_FALLBACK_RESOURCES = 400;
const MAX_PAGES = 40;
const MAX_FALLBACK_FILE_SIZE = 200 * 1024 * 1024;
const CSS_URL_EXPRESSION = /(?:url\(\s*|@import\s+(?:url\(\s*)?)["']?([^"'()\s]+)["']?\s*\)?/gi;
const GLTF_EXTENSION = /\.gltf(?:$|[?#])/i;
const JAVASCRIPT_IMPORT_EXPRESSION = /(?:\bimport\s*\(\s*|\bimport\s+(?:[^'"`]*?\s+from\s+)?|\bimportScripts\s*\(\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*|\bnew\s+URL\s*\(\s*)["']([^"'`\s]+)["']/gi;
const SOURCE_MAP_EXPRESSION = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/gi;

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
  const completeness = report.completeness;
  const diagnostics = (report.networkFailures || []).length + (report.httpErrors || []).length + (report.unreadableResponses || []).length;
  reportEl.style.display = 'block';
  reportEl.innerHTML = `<strong>Отчёт захвата</strong><br>${completeness ? `Полнота: <strong>${completeness.score}%</strong> (${completeness.saved}/${completeness.discovered} зависимостей)<br>` : ''}Кэш: ${report.cacheResources || 0}/${report.cacheEntries || 0} сохранено<br>Iframe/worker: ${(report.childTargets || []).length}<br>${missing ? `<span class="warn">Недоступные ассеты: ${missing}</span><br>` : 'Недоступных ассетов не найдено'}${pages ? `<span class="warn">Страницы с 404: ${pages}</span><br>` : ''}${truncated ? `<span class="warn">Лимит обхода достигнут: ${truncated}</span><br>` : ''}${diagnostics ? `Диагностика сети: ${diagnostics} (аналитика/API не считаются потерей ассетов)` : ''}`;
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
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch (error) {
    return false;
  }
}

function extractResourceUrls(html, baseUrl) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const urls = new Set();
  const add = (value, sameOriginOnly = false) => {
    if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return;
    try {
      const url = normalizeUrl(new URL(value, baseUrl).href);
      if (isHttpUrl(url) && (!sameOriginOnly || new URL(url).origin === new URL(baseUrl).origin)) urls.add(url);
    } catch (error) {
      // Ignore malformed attributes.
    }
  };

  document.querySelectorAll('script[src], img[src], img[data-src], source[src], source[data-src], video[src], video[poster], audio[src], track[src], object[data], embed[src], input[src]').forEach((element) => {
    add(element.getAttribute(element.hasAttribute('data') ? 'data' : element.hasAttribute('poster') ? 'poster' : element.hasAttribute('data-src') ? 'data-src' : 'src'));
  });
  document.querySelectorAll('iframe[src]').forEach((element) => add(element.getAttribute('src'), true));

  document.querySelectorAll('link[href]').forEach((element) => {
    const rel = (element.getAttribute('rel') || '').toLowerCase();
    if (/\b(?:stylesheet|icon|manifest|modulepreload|preload)\b/.test(rel)) add(element.getAttribute('href'));
  });

  document.querySelectorAll('script[type="importmap"]').forEach((element) => {
    try {
      const imports = JSON.parse(element.textContent || '{}').imports || {};
      Object.values(imports).forEach((value) => add(value));
    } catch (error) {
      // Invalid import maps are left to the browser and reported by its console.
    }
  });

  document.querySelectorAll('[srcset], [data-srcset]').forEach((element) => {
    (element.getAttribute('srcset') || element.getAttribute('data-srcset')).split(',').forEach((candidate) => add(candidate.trim().split(/\s+/)[0]));
  });

  document.querySelectorAll('style, [style]').forEach((element) => {
    extractCssUrls(element.tagName === 'STYLE' ? element.textContent : element.getAttribute('style'), baseUrl).forEach((url) => urls.add(url));
  });

  return [...urls];
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

function extractCssUrls(css, baseUrl) {
  const urls = new Set();
  let match;
  while ((match = CSS_URL_EXPRESSION.exec(css || '')) !== null) {
    const value = match[1];
    if (/^(?:data:|blob:|#)/i.test(value)) continue;
    try {
      const url = normalizeUrl(new URL(value, baseUrl).href);
      if (isHttpUrl(url)) urls.add(url);
    } catch (error) {
      // Ignore malformed CSS URLs.
    }
  }
  return [...urls];
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

function dataUrlToBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
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

function rewriteCssUrls(css, baseUrl, byUrl) {
  return (css || '').replace(CSS_URL_EXPRESSION, (whole, value) => {
    const localPath = localPathFor(value, baseUrl, byUrl);
    return localPath === value ? whole : whole.replace(value, localPath);
  });
}

function rewriteJavaScriptUrls(source, baseUrl, byUrl) {
  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  return (source || '').replace(literal, (whole, quote, value) => {
    if (value.includes('\\') || value.includes('${')) return whole;
    const localPath = localPathFor(value, baseUrl, byUrl);
    return localPath === value ? whole : `${quote}${localPath}${quote}`;
  });
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

function extractJavaScriptUrls(source, baseUrl) {
  const urls = new Set();
  let match;
  while ((match = JAVASCRIPT_IMPORT_EXPRESSION.exec(source || '')) !== null) {
    const value = match[1];
    if (!isStaticModuleReference(value)) continue;
    try {
      const url = normalizeUrl(new URL(value, baseUrl).href);
      if (isHttpUrl(url)) urls.add(url);
    } catch (error) {
      // Ignore non-URL module specifiers such as react or @scope/package.
    }
  }
  return [...urls];
}

function isStaticModuleReference(value) {
  if (!value || /[${}\\\s]/.test(value)) return false;
  return /^(?:\.\/|\.\.\/|\/)/.test(value);
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

function rewriteHtmlResource(html, baseUrl, byUrl) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const attributes = ['src', 'href', 'data', 'poster'];

  document.querySelectorAll('[src], [href], [data], [poster]').forEach((element) => {
    for (const attribute of attributes) {
      if (!element.hasAttribute(attribute)) continue;
      const value = element.getAttribute(attribute);
      const localPath = localPathFor(value, baseUrl, byUrl);
      if (localPath !== value) element.setAttribute(attribute, localPath);
    }
  });

  document.querySelectorAll('script:not([src])').forEach((element) => {
    element.textContent = rewriteJavaScriptUrls(element.textContent, baseUrl, byUrl);
  });

  document.querySelectorAll('[srcset]').forEach((element) => {
    const sourceSet = element.getAttribute('srcset').split(',').map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const localPath = localPathFor(parts[0], baseUrl, byUrl);
      return [localPath, ...parts.slice(1)].join(' ');
    });
    element.setAttribute('srcset', sourceSet.join(', '));
  });

  document.querySelectorAll('style').forEach((element) => {
    element.textContent = rewriteCssUrls(element.textContent, baseUrl, byUrl);
  });
  document.querySelectorAll('[style]').forEach((element) => {
    element.setAttribute('style', rewriteCssUrls(element.getAttribute('style'), baseUrl, byUrl));
  });

  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function injectOfflineBootstrap(html) {
  const script = '<script src="/sitesaver-offline.js"></script>';
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${script}`);
  }
  return `${script}${html}`;
}

function resourceText(resource) {
  if (!resource || resource.body == null) return '';
  return resource.base64Encoded ? base64ToText(resource.body) : typeof resource.body === 'string' ? resource.body : '';
}

function restoreSsrHydration(html, bodies, pageUrl, byUrl) {
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
    scripts.push(`<script${match[1]}>${rewriteJavaScriptUrls(match[2], pageUrl, byUrl)}</script>`);
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
  const apiSnapshots = snapshots.map((snapshot) => ({
    method: snapshot.method,
    url: snapshot.url,
    postData: snapshot.postData,
    status: snapshot.status,
    statusText: snapshot.statusText,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath
  }));

  return `const CACHE = 'sitesaver-offline-v1';
const PRECACHE = ${JSON.stringify([...new Set(precache)])};
const SNAPSHOTS = ${JSON.stringify(apiSnapshots)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (path) => {
      try { await cache.add(path); } catch (error) { /* Reported in sitesaver-report.json. */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const request = event.request;
    const url = new URL(request.url);
    const cache = await caches.open(CACHE);

    if (request.mode === 'navigate') {
      return (await cache.match('/index.html')) || new Response('Offline archive is incomplete', { status: 503 });
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

Serve this folder from any static HTTP(S) host at the host root to enable the generated service worker, SPA fallback, and saved API responses. Opening index.html through file:// is not supported because service workers and ES modules require HTTP(S).

Files
- index.html: captured entry document
- assets/: captured CSS, JS, media, fonts, and images, grouped by source host
- api-snapshots/: captured Fetch/XHR response bodies
- sitesaver-sw.js: offline service worker
- sitesaver-offline.js: offline bootstrap
- sitesaver-report.json: capture diagnostics and completeness score
- sitesaver-manifest.json: archive metadata
`;
}

function createOfflineReplayScript(snapshots) {
  const manifest = snapshots.map((snapshot) => ({
    method: snapshot.method,
    url: snapshot.url,
    postData: snapshot.postData,
    status: snapshot.status,
    statusText: snapshot.statusText,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath
  }));

  return `(() => {
  const snapshots = ${JSON.stringify(manifest)};
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
  const usedPaths = new Set();
  const pageOrigin = new URL(pageUrl).origin;

  const add = (resource) => {
    const url = normalizeUrl(resource.url);
    if (byUrl.has(url)) return byUrl.get(url);

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
    byUrl.set(url, entry);
    resources.push(entry);
    return entry;
  };

  bodies.forEach(add);

  const createReplacements = () => {
    const aliases = new Map();
    for (const entry of resources) {
      const url = new URL(entry.url);
      // The captured document is already exported as root index.html. Replacing
      // its URL would corrupt every same-origin absolute URL by matching a prefix.
      if (url.origin === pageOrigin && url.pathname === '/' && !url.search) continue;
      if (entry.preserveUrl) continue;
      aliases.set(entry.url, `/${entry.localPath}`);
      if (url.origin === pageOrigin && url.pathname !== '/') aliases.set(`${url.pathname}${url.search}`, `/${entry.localPath}`);
    }
    return [...aliases.entries()].sort((a, b) => b[0].length - a[0].length);
  };

  return { resources, byUrl, add, createReplacements };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function collectMissingFiles(html, pageUrl, catalog, report, includePages = true) {
  const queue = [];
  const queued = new Set();
  let pagesQueued = 0;

  const enqueue = (url, kind) => {
    const normalized = normalizeUrl(url);
    if (kind === 'resource') addReportItem(report, 'discoveredResources', { url: normalized });
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
  const discover = (content, baseUrl, includePages) => {
    extractResourceUrls(content, baseUrl).forEach((url) => enqueue(url, 'resource'));
    if (includePages) extractPageUrls(content, baseUrl, siteOrigin).forEach((url) => enqueue(url, 'page'));
  };

  discover(html, pageUrl, includePages);

  for (const resource of [...catalog.resources]) {
    if (!isTextResource(resource) || resource.preserveUrl) continue;
    try {
      const text = resource.base64Encoded ? base64ToText(resource.body) : resource.body instanceof Blob
        ? await resource.body.text()
        : resource.body;
      const type = (resource.mimeType || '').toLowerCase();
      if (type.startsWith('text/html')) discover(text, resource.url, includePages);
      if (type.startsWith('text/css')) extractCssUrls(text, resource.url).forEach((url) => enqueue(url, 'resource'));
      if (isGltfResource(resource)) extractGltfUrls(text, resource.url).forEach((url) => enqueue(url, 'resource'));
      if (/(?:java|ecma)script/.test(type) || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)) {
        extractJavaScriptUrls(text, resource.url).forEach((url) => enqueue(url, 'resource'));
        extractSourceMapUrls(text, resource.url).forEach((url) => enqueue(url, 'resource'));
      }
    } catch (error) {
      addReportItem(report, 'unresolvedResources', { url: resource.url, reason: `Cannot inspect captured text: ${error.message}` });
    }
  }

  let fetched = 0;
  while (queue.length > 0) {
    const item = queue.shift();
    status(`Дозагрузка ${fetched + 1}/${fetched + queue.length + 1}`, 15 + Math.round((fetched / MAX_FALLBACK_RESOURCES) * 35));
    try {
      const response = await fetch(item.url, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.size > MAX_FALLBACK_FILE_SIZE) throw new Error('файл больше 200 MB');

      const resource = catalog.add({
        url: item.url,
        mimeType: response.headers.get('content-type') || blob.type,
        body: blob,
        base64Encoded: false
      });
      fetched += 1;
      log(`+ ${resource.localPath}`, 'ok');

      if (isTextResource(resource)) {
        const text = await blob.text();
        if ((resource.mimeType || '').toLowerCase().startsWith('text/html')) discover(text, item.url, includePages);
        if ((resource.mimeType || '').toLowerCase().startsWith('text/css')) {
          extractCssUrls(text, item.url).forEach((url) => enqueue(url, 'resource'));
        }
        if (isGltfResource(resource)) {
          extractGltfUrls(text, item.url).forEach((url) => enqueue(url, 'resource'));
        }
        if (/(?:java|ecma)script/.test(resource.mimeType || '') || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)) {
          extractJavaScriptUrls(text, item.url).forEach((url) => enqueue(url, 'resource'));
          extractSourceMapUrls(text, item.url).forEach((url) => enqueue(url, 'resource'));
        }
      }
    } catch (error) {
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

async function rewriteTextResources(resources, replacements, byUrl) {
  for (const resource of resources) {
    if (!isTextResource(resource) || resource.preserveUrl) continue;
    try {
      const text = resource.base64Encoded ? base64ToText(resource.body) : resource.body instanceof Blob
        ? await resource.body.text()
        : resource.body;
      const type = (resource.mimeType || '').toLowerCase();
      resource.body = type.startsWith('text/html')
        ? rewriteHtmlResource(text, resource.url, byUrl)
        : type.startsWith('text/css')
          ? rewriteCssUrls(text, resource.url, byUrl)
          : isGltfResource(resource)
            ? rewriteGltfUrls(text, resource.url, byUrl)
            : /(?:java|ecma)script/.test(type) || /\.(?:js|mjs)(?:$|[?#])/i.test(resource.url)
              ? rewriteJavaScriptUrls(text, resource.url, byUrl)
              : text;
      resource.base64Encoded = false;
    } catch (error) {
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
  const document = new DOMParser().parseFromString(`<!doctype html><html><head>${selected.head}</head><body class="${selected.bodyClass}">${selected.html}</body></html>`, 'text/html');
  document.querySelectorAll('base').forEach((element) => element.remove());
  document.title = selected.title;
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

async function downloadZip(zip, filename) {
  const archive = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(archive);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    URL.revokeObjectURL(url);
  }
  return archive.size;
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
    const catalog = createCatalog([], selected.pageUrl);
    const fetched = await collectMissingFiles(markup, selected.pageUrl, catalog, report, false);
    log(`Дозагружено зависимостей: ${fetched}`);

    status('Переписываю пути...', 55);
    const replacements = catalog.createReplacements();
    const html = rewriteHtmlResource(markup, selected.pageUrl, catalog.byUrl);
    await rewriteTextResources(catalog.resources, replacements, catalog.byUrl);
    const finalReport = finalizeReport(report, catalog);
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
    log(`Точечный архив: ${(size / 1024 / 1024).toFixed(2)} MB, ${catalog.resources.length + 3} файлов`, 'ok');
    status('Готово', 100);
  } catch (error) {
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
  } finally {
    progress.style.display = 'none';
    resetInterface();
  }
}

async function capture(action = 'fullCapture') {
  const mode = selectedCaptureMode();
  btnCapture.disabled = true;
  btnRecord.disabled = true;
  btnCapture.textContent = 'Захват...';
  captureModeEl.querySelectorAll('input').forEach((input) => { input.disabled = true; });
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

    const { html, bodies = [], apiSnapshots = [], interaction, canvasSnapshots = [], report, domain, htmlMethod, pageUrl, mode: capturedMode = mode } = result;
    if (!html) throw new Error('Страница вернула пустой HTML');

    log(`HTML: ${(html.length / 1024).toFixed(1)} KB (${htmlMethod})`);
    log(`Перехвачено ответов: ${bodies.length}`);
    log(capturedMode === 'deep' ? 'Режим: глубокий захват' : 'Режим: быстрый захват');
    if (interaction) log(`Интерактивных элементов: ${interaction.clicked} нажато, ${interaction.skipped} пропущено`);
    if (interaction && interaction.startActivation && interaction.startActivation.clicked) log(`Стартовый overlay активирован после ${interaction.startActivation.waited} мс ожидания`);
    if (interaction && interaction.hover) log(`Hover-элементов: ${interaction.hover.hovered}, scroll-контейнеров: ${interaction.scrollContainers}`);
    if (interaction && interaction.replayedScenario.total) log(`Сценарий: ${interaction.replayedScenario.replayed}/${interaction.replayedScenario.total} действий повторено`);
    if (canvasSnapshots.length) log(`Canvas-снимков: ${canvasSnapshots.length}`);
    renderReport(report);
    status('Собираю ресурсы...', 10);

    const captureReport = report || {};
    captureReport.captureMode = capturedMode;
    captureReport.pageUrl = pageUrl;
    const catalog = createCatalog(bodies, pageUrl);
    const fetched = await collectMissingFiles(html, pageUrl, catalog, captureReport, capturedMode === 'deep');
    log(`Дозагружено ссылок и ресурсов: ${fetched}`);

    const replaySnapshots = apiSnapshots.map((snapshot) => ({
      ...snapshot,
      localPath: `/${apiSnapshotPath(snapshot)}`
    }));
    log(`Снимков Fetch/XHR: ${replaySnapshots.length}`);

    const finalReport = finalizeReport(captureReport, catalog);
    renderReport(finalReport);

    status('Переписываю пути...', 55);
    const replacements = catalog.createReplacements();
    const rewrittenHtml = rewriteHtmlResource(html, pageUrl, catalog.byUrl);
    const hydratedHtml = restoreSsrHydration(rewrittenHtml, bodies, pageUrl, catalog.byUrl);
    const fixedHtml = injectOfflineBootstrap(hydratedHtml);
    await rewriteTextResources(catalog.resources, replacements, catalog.byUrl);

    status('Собираю архив...', 75);
    const zip = new JSZip();
    zip.file('index.html', fixedHtml);
    zip.file('404.html', createSpaFallback());
    zip.file('sitesaver-offline.js', createOfflineReplayScript(replaySnapshots));
    zip.file('sitesaver-sw.js', createOfflineServiceWorker(catalog.resources, replaySnapshots));
    zip.file('sitesaver-report.json', JSON.stringify(finalReport, null, 2));
    zip.file('sitesaver-manifest.json', JSON.stringify({
      format: 'sitesaver-offline-archive',
      version: 1,
      sourceUrl: pageUrl,
      captureMode: capturedMode,
      capturedAt: new Date().toISOString(),
      resourceCount: catalog.resources.length,
      apiSnapshotCount: replaySnapshots.length
    }, null, 2));
    zip.file('README.txt', createArchiveReadme());
    replaySnapshots.forEach((snapshot) => {
      zip.file(snapshot.localPath.slice(1), snapshot.body, snapshot.base64Encoded ? { base64: true } : undefined);
    });
    canvasSnapshots.forEach((snapshot, index) => {
      zip.file(`screenshots/canvas-${index + 1}.png`, dataUrlToBase64(snapshot.dataUrl), { base64: true });
    });

    for (const resource of catalog.resources) {
      zip.file(resource.localPath, resource.body, resource.base64Encoded ? { base64: true } : undefined);
    }

    status('Генерирую архив...', 88);
    const archive = await zip.generateAsync({ type: 'blob' });
    log(`Архив: ${(archive.size / 1024 / 1024).toFixed(2)} MB, ${catalog.resources.length + 1} файлов`, 'ok');

    status('Скачиваю...', 95);
    const url = URL.createObjectURL(archive);
    try {
      await chrome.downloads.download({ url, filename: `${domain}.zip`, saveAs: true });
    } finally {
      URL.revokeObjectURL(url);
    }

    status('Готово', 100);
    log('Готово. Архив содержит статическую офлайн-копию.', 'ok');
  } catch (error) {
    status(`Ошибка: ${error.message}`);
    log(error.message, 'err');
  } finally {
    progress.style.display = 'none';
    resetInterface();
  }
}

btnCapture.addEventListener('click', () => capture());

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
