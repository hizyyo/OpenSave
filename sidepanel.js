const btnCapture = document.getElementById('btnCapture');
const progress = document.getElementById('progress');
const stageEl = document.getElementById('stage');
const statusEl = document.getElementById('status');
const fillEl = document.getElementById('fill');
const summaryCardEl = document.getElementById('summaryCard');
const detailsToggleEl = document.getElementById('detailsToggle');
const toggleIconEl = document.getElementById('toggleIcon');
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
const ArchiveValidator = OpenSaveArchiveValidator;
const captureStorage = CaptureStorage.createCaptureStorage();
const captureStorageReady = captureStorage.initialize();
let exportingMissionId = null;
let activeValidation = null;
let currentProgressStage = '';
let currentProgressPercent = 0;

detailsToggleEl.addEventListener('click', () => {
  const isHidden = logEl.style.display === 'none' || logEl.style.display === '';
  logEl.style.display = isHidden ? 'block' : 'none';
  reportEl.style.display = isHidden ? 'block' : 'none';
  toggleIconEl.textContent = isHidden ? '▼' : '▶';
});

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
    if (!resource.storageKey) {
      hydrated.push(resource);
      continue;
    }
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
  detailsToggleEl.style.display = 'flex';
  const line = document.createElement('div');
  line.className = type || '';
  line.textContent = message;
  logEl.appendChild(line);
}

function setStage(stageName) {
  currentProgressStage = stageName;
  if (stageEl) stageEl.textContent = stageName;
}

function status(message, percent) {
  if (percent !== undefined) {
    currentProgressPercent = Math.max(currentProgressPercent, percent);
    fillEl.style.width = `${currentProgressPercent}%`;
  }
  statusEl.textContent = message;
}

function isAnalyticsOrTracker(url) {
  return /google-analytics|googletagmanager|analytics|mc\.yandex|metrika|hotjar|segment|amplitude|mixpanel|facebook\.net|connect\.facebook|clarity\.ms|sentry/i.test(url || '');
}

function renderSummary(summary) {
  if (!summaryCardEl) return;
  summaryCardEl.className = `summary-card ${summary.status}`;
  summaryCardEl.style.display = 'block';

  let headlineText = 'Копия готова к просмотру';
  if (summary.status === 'partial') headlineText = 'Копия сохранена частично';
  if (summary.status === 'failed') headlineText = 'Не удалось сохранить сайт';
  if (summary.status === 'cancelled') headlineText = 'Сохранение отменено';

  let html = `<div class="summary-headline ${summary.status}">${headlineText}</div>`;
  html += `<div>• Сохранено страниц: <strong>${summary.savedPages}</strong> из <strong>${summary.totalDiscoveredPages}</strong></div>`;
  html += `<div>• Сохранено файлов контента: <strong>${summary.savedFiles}</strong> из <strong>${summary.totalRequiredFiles}</strong></div>`;
  
  if (summary.ignoredAnalyticsCount > 0) {
    html += `<div>• Игнорировано аналитики и трекеров: <strong>${summary.ignoredAnalyticsCount}</strong> (не влияет на сайт)</div>`;
  }
  
  if (summary.testedRoutes > 0) {
    if (summary.failedRoutes === 0) {
      html += `<div>• Все проверенные страницы (<strong>${summary.testedRoutes}</strong>) открываются успешно</div>`;
    } else {
      html += `<div style="color:#ef4444">• Не удалось открыть страниц при проверке: <strong>${summary.failedRoutes}</strong> из <strong>${summary.testedRoutes}</strong></div>`;
    }
  }

  if (summary.recommendedAction) {
    html += `<div class="action-banner"><strong>Рекомендация:</strong> ${summary.recommendedAction}</div>`;
  }

  summaryCardEl.innerHTML = html;
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
  const validation = report.validation;
  const validationLabel = validation && ({ ready: 'Готово', partial: 'Частично', failed: 'Ошибка', cancelled: 'Проверка отменена' }[validation.status] || validation.status);
  const validationClass = validation && validation.status !== 'ready' ? 'warn' : '';

  reportEl.innerHTML = `<strong>Технические подробности</strong><br>${validation ? `<span class="${validationClass}">Проверка архива: <strong>${validationLabel}</strong></span> (${validation.checkedRoutes}/${validation.totalRoutes} маршрутов, ${validation.issueCount ?? validation.diagnostics.length} замечаний, ${(validation.durationMs / 1000).toFixed(1)} с)<br>` : ''}${quotaFailure ? `<span class="warn">${quotaFailure.reason}</span><br>` : ''}${completeness ? `Полнота: <strong>${completeness.score}%</strong> (${completeness.saved}/${completeness.discovered} зависимостей)<br>` : ''}${typeof savedPageCount === 'number' ? `HTML-страниц: ${savedPageCount}<br>` : ''}Кэш: ${report.cacheResources || 0}/${report.cacheEntries || 0} сохранено<br>Iframe/worker: ${(report.childTargets || []).length}<br>${refetched ? `Дозагружено openSave: ${refetched} (не CDP-наблюдение)<br>` : ''}${missing ? `<span class="warn">Недоступные ассеты: ${missing}</span><br>` : 'Недоступных ассетов не найдено'}${pages ? `<span class="warn">Страницы с 404: ${pages}</span><br>` : ''}${truncated ? `<span class="warn">Лимит обхода достигнут: ${truncated}</span><br>` : ''}${diagnostics ? `Диагностика сети: ${diagnostics} (аналитика/API не считаются потерей ассетов)` : ''}`;
  detailsToggleEl.style.display = 'flex';
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

function apiSnapshotPath(snapshot, index = 0) {
  const extension = extensionForMimeType(snapshot.mimeType) || '.bin';
  const key = `${snapshot.method}\n${snapshot.url}\n${snapshot.postData}\n${snapshot.sequence || index}`;
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
  const bootstrap = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' blob:; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; media-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\'; frame-src \'self\'; worker-src \'self\' blob:; object-src \'none\'; form-action \'none\'; base-uri \'self\'"><script src="/replay-matcher.js"></script><script src="/sitesaver-offline.js"></script>';
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

function createOfflineServiceWorker(resources, snapshots, captureMisses = []) {
  const precache = ['/', '/index.html', '/404.html', '/replay-matcher.js', '/replay-misses.json', '/sitesaver-offline.js', '/sitesaver-sw.js', ...resources.map((resource) => `/${resource.localPath}`), ...snapshots.filter((snapshot) => snapshot.localPath).map((snapshot) => snapshot.localPath)];
  const pageRoutes = {};
  const pageUrls = {};
  resources.forEach((resource) => {
    if (!(resource.mimeType || '').toLowerCase().startsWith('text/html')) return;
    try {
      const url = new URL(resource.url);
      url.hash = '';
      pageUrls[url.href] = `/${resource.localPath}`;
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const key = pathname + url.search;
      if (key !== '/') pageRoutes[key] = `/${resource.localPath}`;
      for (const alias of resource.aliases || []) {
        const aliasUrl = new URL(alias);
        aliasUrl.hash = '';
        pageUrls[aliasUrl.href] = `/${resource.localPath}`;
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
    exchangeId: snapshot.exchangeId,
    sequence: snapshot.sequence,
    method: snapshot.method,
    url: snapshot.url,
    contentType: snapshot.contentType,
    requestBodyHash: snapshot.requestBodyHash,
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath || null,
    evidenceRefs: snapshot.evidenceRefs
  }));
  const resourceRoutes = {};
  const resourceUrls = {};
  const resourceRouteOrigins = new Map();
  for (const resource of resources) {
    try {
      const url = new URL(resource.url);
      url.hash = '';
      resourceUrls[url.href] = `/${resource.localPath}`;
      const key = url.pathname + url.search;
      if (!resourceRouteOrigins.has(key)) resourceRouteOrigins.set(key, new Set());
      resourceRouteOrigins.get(key).add(url.origin);
      resourceRoutes[key] = `/${resource.localPath}`;
    } catch (error) {
      // Invalid resource URLs are already reported during catalog creation.
    }
  }
  for (const [key, origins] of resourceRouteOrigins) {
    if (origins.size > 1) delete resourceRoutes[key];
  }

  return `importScripts('/replay-matcher.js');
const CACHE = ${JSON.stringify(cacheName)};
const PRECACHE = ${JSON.stringify([...new Set(precache)])};
const SNAPSHOTS = ${JSON.stringify(apiSnapshots)};
const PAGE_ROUTES = ${JSON.stringify(pageRoutes)};
const PAGE_URLS = ${JSON.stringify(pageUrls)};
const RESOURCE_ROUTES = ${JSON.stringify(resourceRoutes)};
const RESOURCE_URLS = ${JSON.stringify(resourceUrls)};
const CAPTURE_MISSES = ${JSON.stringify(captureMisses)};
const RUNTIME_MISSES = [];
const MATCHERS = new Map();
const matcherFor = (clientId) => {
  const key = clientId || 'unidentified-client';
  if (!MATCHERS.has(key)) MATCHERS.set(key, OpenSaveReplayMatcher.createMatcher(SNAPSHOTS, { runtimeOrigin: self.location.origin }));
  return MATCHERS.get(key);
};

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

const routeKey = (url) => {
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\\/+$/, '') : url.pathname;
  return pathname + url.search;
};

const recordMiss = (miss, identity, source = 'service-worker') => {
  const entry = { timestamp: Date.now(), source, reasonCode: miss.reasonCode, evidence: { ...(miss.evidence || {}), identity } };
  RUNTIME_MISSES.push(entry);
  if (RUNTIME_MISSES.length > 500) RUNTIME_MISSES.shift();
  return entry;
};

const missResponse = (miss, identity) => {
  recordMiss(miss, identity);
  return new Response(JSON.stringify({ error: 'Offline replay miss', reasonCode: miss.reasonCode }), {
    status: 503,
    statusText: 'Offline replay miss',
    headers: { 'content-type': 'application/json', 'x-opensave-replay-miss': miss.reasonCode }
  });
};

const snapshotResponse = async (snapshot, cache, requestMethod) => {
  const headers = new Headers(snapshot.headers || {});
  for (const name of ['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding']) headers.delete(name);
  if (snapshot.mimeType) headers.set('content-type', snapshot.mimeType);
  if (snapshot.localPath) {
    const response = await cache.match(snapshot.localPath);
    if (!response) return missResponse({ reasonCode: 'saved-response-unavailable', evidence: { exchangeId: snapshot.exchangeId, localPath: snapshot.localPath } }, null);
    return new Response(requestMethod === 'HEAD' ? null : await response.arrayBuffer(), { status: snapshot.status, statusText: snapshot.statusText, headers });
  }
  if ([204, 205, 301, 302, 303, 307, 308].includes(snapshot.status)) return new Response(null, { status: snapshot.status, statusText: snapshot.statusText, headers });
  return missResponse({ reasonCode: 'response-body-unavailable', evidence: { exchangeId: snapshot.exchangeId } }, null);
};

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'opensave-replay-miss') recordMiss(event.data.miss, event.data.identity, 'bootstrap');
  if (event.data && event.data.type === 'opensave-replay-ledger' && event.ports[0]) {
    event.ports[0].postMessage({ schemaVersion: 1, captureMisses: CAPTURE_MISSES, runtimeMisses: RUNTIME_MISSES });
  }
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const request = event.request;
    const url = new URL(request.url);
    const cache = await caches.open(CACHE);

    if (url.origin === self.location.origin && url.pathname === '/replay-misses.json') {
      return new Response(JSON.stringify({ schemaVersion: 1, captureMisses: CAPTURE_MISSES, runtimeMisses: RUNTIME_MISSES }, null, 2), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    if (request.mode === 'navigate' && ['GET', 'HEAD'].includes(request.method)) {
      const exact = await cache.match(request, { ignoreSearch: false });
      if (exact) return exact;
      const pagePath = PAGE_URLS[url.href] || (url.origin === self.location.origin ? PAGE_ROUTES[routeKey(url)] : null);
      if (pagePath) {
        const page = await cache.match(pagePath);
        if (page) return page;
      }
      if (url.origin !== self.location.origin) return missResponse({ reasonCode: 'external-navigation-blocked', evidence: { url: url.href } }, null);
      return (await cache.match('/index.html')) || new Response('Offline archive is incomplete', { status: 503 });
    }

    if (request.method === 'GET') {
      const pagePath = PAGE_URLS[url.href] || (url.origin === self.location.origin ? PAGE_ROUTES[routeKey(url)] : null);
      if (pagePath) {
        const page = await cache.match(pagePath);
        if (page) return page;
      }
      const resourcePath = RESOURCE_URLS[url.href] || (url.origin === self.location.origin ? RESOURCE_ROUTES[url.pathname + url.search] : null);
      if (resourcePath) {
        const resource = await cache.match(resourcePath);
        if (resource) return resource;
      }
    }

    const matched = await matcherFor(event.clientId || event.resultingClientId).match(request);
    if (matched.snapshot) return snapshotResponse(matched.snapshot, cache, request.method);
    if (matched.miss && matched.miss.reasonCode !== 'not-found') return missResponse(matched.miss, matched.identity);

    const cached = await cache.match(request.method === 'HEAD' ? new Request(request.url, { method: 'GET' }) : request, { ignoreSearch: false });
    if (cached) return cached;
    if (matched.miss) return missResponse(matched.miss, matched.identity);
    if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(request.method)) return missResponse({ reasonCode: 'external-network-blocked', evidence: { method: request.method, url: request.url } }, null);
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
- replay-matcher.js: exact request identity and ordered response matching
- replay-misses.json: capture-time and live replay miss ledger with reason codes
- validation-report.json: automatic route, runtime, and zero-egress validation result
- validation-plan.json: bounded route and required-file validation inputs
- validate-windows.bat / validate-unix.sh: optional final localhost validator when browser restrictions limit in-extension service-worker checks
- sitesaver-sw.js: offline service worker
- sitesaver-offline.js: offline bootstrap
- sitesaver-report.json: capture diagnostics and completeness score
- sitesaver-manifest.json: archive metadata
- open-windows.bat / open-windows.ps1: Windows local launcher
- open-unix.sh: macOS/Linux local launcher
`;
}

function createWindowsValidatorLauncher() {
  return `@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for the optional final validator.
  exit /b 1
)
node archive-validator-companion.mjs .
`;
}

function createUnixValidatorLauncher() {
  return `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for the optional final validator."
  exit 1
fi
node archive-validator-companion.mjs .
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
    exchangeId: snapshot.exchangeId,
    sequence: snapshot.sequence,
    method: snapshot.method,
    url: snapshot.url,
    contentType: snapshot.contentType,
    requestBodyHash: snapshot.requestBodyHash,
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
    location: snapshot.location,
    mimeType: snapshot.mimeType,
    localPath: snapshot.localPath || null,
    evidenceRefs: snapshot.evidenceRefs
  }));

  const historyRoutes = renderedPages.filter((page) => page.transitionKind === 'history').map((page) => {
    const url = new URL(page.routeUrl || page.url);
    return { route: url.pathname + url.search + url.hash, localPath: `/${page.localPath}` };
  });

  return `(() => {
  const snapshots = ${JSON.stringify(manifest)};
  const matcher = OpenSaveReplayMatcher.createMatcher(snapshots, { runtimeOrigin: location.origin });
  const bootstrapControls = !navigator.serviceWorker.controller;
  const runtimeMisses = [];
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

  const bodyText = (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return null;
  };

  const reportMiss = (miss, identity) => {
    const entry = { timestamp: Date.now(), source: 'bootstrap', reasonCode: miss.reasonCode, evidence: { ...(miss.evidence || {}), identity } };
    runtimeMisses.push(entry);
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'opensave-replay-miss', miss, identity });
    return entry;
  };

  navigator.serviceWorker?.ready.then(() => {
    if (!navigator.serviceWorker.controller) return;
    for (const entry of runtimeMisses) navigator.serviceWorker.controller.postMessage({ type: 'opensave-replay-miss', miss: { reasonCode: entry.reasonCode, evidence: entry.evidence }, identity: entry.evidence.identity });
  }).catch(() => {});

  window.__openSaveReplayLedger = () => new Promise((resolve) => {
    if (!navigator.serviceWorker.controller) {
      resolve({ schemaVersion: 1, captureMisses: [], runtimeMisses: [...runtimeMisses] });
      return;
    }
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve({ schemaVersion: 1, captureMisses: [], runtimeMisses: [...runtimeMisses] }), 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'opensave-replay-ledger' }, [channel.port2]);
  });

  const blockedResponse = (miss, identity) => {
    reportMiss(miss, identity);
    return new Response(JSON.stringify({ error: 'Offline replay miss', reasonCode: miss.reasonCode }), { status: 503, statusText: 'Offline replay miss', headers: { 'content-type': 'application/json', 'x-opensave-replay-miss': miss.reasonCode } });
  };

  const responseFor = async (snapshot, method) => {
    const headers = new Headers(snapshot.headers || {});
    for (const name of ['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding']) headers.delete(name);
    if (snapshot.mimeType) headers.set('content-type', snapshot.mimeType);
    if (!snapshot.localPath) {
      if ([204, 205, 301, 302, 303, 307, 308].includes(snapshot.status)) return new Response(null, { status: snapshot.status, statusText: snapshot.statusText, headers });
      return blockedResponse({ reasonCode: 'response-body-unavailable', evidence: { exchangeId: snapshot.exchangeId } }, null);
    }
    const local = await nativeFetch(snapshot.localPath);
    if (!local.ok) return blockedResponse({ reasonCode: 'saved-response-unavailable', evidence: { exchangeId: snapshot.exchangeId, localPath: snapshot.localPath } }, null);
    return new Response(method === 'HEAD' ? null : await local.arrayBuffer(), { status: snapshot.status, statusText: snapshot.statusText, headers });
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
      if (typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream) return blockedResponse({ reasonCode: 'streaming-request', evidence: { url: String(input) } }, null);
      let request;
      try { request = input instanceof Request ? input : new Request(input, init); }
      catch (error) { return blockedResponse({ reasonCode: 'streaming-request', evidence: { error: error.message } }, null); }
      const unsupported = OpenSaveReplayMatcher.unsupportedReason(request);
      if (unsupported) return blockedResponse({ reasonCode: unsupported, evidence: { method: request.method, url: request.url } }, null);
      if (!bootstrapControls) return nativeFetch(request);
      const matched = await matcher.match(request, init.body);
      if (!matched.snapshot) {
        const url = new URL(request.url);
        if (url.origin === location.origin && ['GET', 'HEAD'].includes(request.method)) return nativeFetch(request);
        return blockedResponse(matched.miss, matched.identity);
      }
      const snapshot = matched.snapshot;
      if ([301, 302, 303, 307, 308].includes(snapshot.status) && snapshot.location && request.redirect !== 'manual') {
        const preserveMethod = snapshot.status === 307 || snapshot.status === 308;
        const redirectUrl = new URL(snapshot.location, request.url).href;
        return preserveMethod ? window.fetch(new Request(redirectUrl, request)) : window.fetch(redirectUrl, { method: 'GET' });
      }
      return responseFor(snapshot, request.method);
    };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__siteSaverRequest = { method: String(method).toUpperCase(), url: new URL(url, location.href).href, headers: {} };
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.__siteSaverRequest) this.__siteSaverRequest.headers[String(name).toLowerCase()] = String(value);
    return nativeSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (!bootstrapControls) return nativeSend.call(this, body);
    const request = this.__siteSaverRequest;
    const text = bodyText(body);
    const matched = request && text != null && matcher.matchIdentity({ ...request, body: text, contentType: request.headers['content-type'] || '' });
    if (!matched || !matched.snapshot) {
      reportMiss(matched && matched.miss || { reasonCode: text == null ? 'streaming-request' : 'not-found', evidence: {} }, matched && matched.identity || request);
      this.abort();
      return;
    }
    const snapshot = matched.snapshot;
    if (!snapshot.localPath) {
      reportMiss({ reasonCode: 'response-body-unavailable', evidence: { exchangeId: snapshot.exchangeId } }, matched.identity);
      this.abort();
      return;
    }
    nativeOpen.call(this, 'GET', snapshot.localPath, true);
    return nativeSend.call(this);
  };

  navigator.sendBeacon = (url) => { reportMiss({ reasonCode: 'beacon', evidence: { url: new URL(url, location.href).href } }, null); return false; };
  window.WebSocket = function(url) { reportMiss({ reasonCode: 'websocket', evidence: { url: new URL(url, location.href).href } }, null); throw new Error('WebSocket is unavailable in the offline archive'); };
  window.EventSource = function(url) { reportMiss({ reasonCode: 'sse', evidence: { url: new URL(url, location.href).href } }, null); throw new Error('EventSource is unavailable in the offline archive'); };
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
  currentProgressPercent = 0;
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

function injectValidationMarker(html, marker) {
  const script = `<script>document.documentElement.dataset.opensaveValidationMarker=${JSON.stringify(marker)};</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${script}`);
  return `${script}${html}`;
}

function archiveMimeType(path) {
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  return {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json'
  }[extension] || 'application/octet-stream';
}

function bytesToBase64(bytes) {
  let binary = '';
  const size = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += size) binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  return btoa(binary);
}

async function archiveFiles(zip) {
  const files = new Map();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async('uint8array');
    files.set(ArchiveValidator.normalizePath(path), {
      path: ArchiveValidator.normalizePath(path),
      bytes,
      text: /(?:html?|css|js|json|svg|txt|md)$/i.test(path) ? new TextDecoder().decode(bytes) : null,
      mimeType: archiveMimeType(path)
    });
  }
  return files;
}

async function waitForValidationCondition(callback, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (activeValidation && activeValidation.cancelled) return false;
    try {
      if (await callback()) return true;
    } catch (error) {
      // Navigation can replace the execution context while it is being inspected.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function validateArchive(zip, input) {
  const startedAt = Date.now();
  const plan = ArchiveValidator.createPlan(input);
  const files = await archiveFiles(zip);
  const diagnostics = [
    ...ArchiveValidator.inputDiagnostics({ report: input.report, routes: input.captureRoutes, replayMisses: input.replayMisses }),
    ...ArchiveValidator.inspectArchive({ files, requiredFiles: plan.requiredFiles })
  ];
  const routeResults = [];
  const requiredPaths = new Set(plan.requiredFiles.map((file) => file.path));
  const routePaths = new Map(plan.routes.filter((route) => route.localPath).map((route) => {
    const url = new URL(route.url, 'https://validation.invalid/');
    return [`${url.pathname}${url.search}`, route.localPath];
  }));
  const validationId = crypto.randomUUID();
  const validationOrigin = `http://validation-${validationId}.localhost`;
  const debuggeeSessions = new Set();
  let tabId = null;
  let serviceWorkerControlled = false;
  let checkedRoutes = 0;
  const runnerEvidence = { networkRequests: 0, pausedRequests: 0, fulfilledRequests: 0, requestUrls: [] };

  const addDiagnostic = (item) => {
    const entry = ArchiveValidator.diagnostic(item);
    const signature = JSON.stringify(entry);
    if (!diagnostics.some((existing) => JSON.stringify(existing) === signature)) diagnostics.push(entry);
  };

  const pathForRequest = (requestUrl) => {
    const url = new URL(requestUrl);
    const routePath = routePaths.get(`${url.pathname}${url.search}`);
    if (routePath) return routePath;
    const path = ArchiveValidator.normalizePath(url.pathname);
    return path || 'index.html';
  };

  const configureSession = async (debuggeeId, child = false) => {
    const key = debuggeeId.sessionId || 'root';
    if (debuggeeSessions.has(key)) return;
    debuggeeSessions.add(key);
    await chrome.debugger.sendCommand(debuggeeId, 'Runtime.enable').catch(() => {});
    await chrome.debugger.sendCommand(debuggeeId, 'Log.enable').catch(() => {});
    await chrome.debugger.sendCommand(debuggeeId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    if (child) await chrome.debugger.sendCommand(debuggeeId, 'Runtime.runIfWaitingForDebugger').catch(() => {});
  };

  const onEvent = (debuggeeId, method, params) => {
    if (debuggeeId.tabId !== tabId) return;
    if (method === 'Target.attachedToTarget') {
      configureSession({ tabId, sessionId: params.sessionId }, true).catch((error) => addDiagnostic({ category: 'validator-infrastructure', code: 'child-session-setup-failed', severity: 'error', message: error.message, url: params.targetInfo && params.targetInfo.url }));
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      runnerEvidence.networkRequests += 1;
      if (runnerEvidence.requestUrls.length < 30) runnerEvidence.requestUrls.push(params.request.url);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      addDiagnostic({ category: 'replay-runtime-failure', code: 'runtime-exception', severity: 'error', message: params.exceptionDetails.exception?.description || params.exceptionDetails.text || 'Runtime exception', url: params.exceptionDetails.url || null });
      return;
    }
    if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      if (/Failed to load resource/i.test(params.entry.text)) return;
      addDiagnostic({ category: 'replay-runtime-failure', code: 'console-error', severity: 'warning', message: params.entry.text, url: params.entry.url || null });
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    runnerEvidence.pausedRequests += 1;
    (async () => {
      const requestUrl = params.request.url;
      let url;
      try { url = new URL(requestUrl); } catch (error) {
        await chrome.debugger.sendCommand(debuggeeId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        addDiagnostic({ category: 'replay-runtime-failure', code: 'invalid-runtime-request-url', severity: 'warning', message: requestUrl });
        return;
      }
      if (url.origin !== validationOrigin) {
        addDiagnostic({ category: 'replay-runtime-failure', code: 'external-request-attempt', severity: 'warning', message: 'Archive attempted an external request; the validator blocked it.', url: requestUrl });
        await chrome.debugger.sendCommand(debuggeeId, 'Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 503, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: btoa('Blocked by openSave validator') }).catch(() => {});
        return;
      }
      const path = pathForRequest(requestUrl);
      const file = files.get(path);
      if (!file) {
        addDiagnostic({ category: 'rewrite-failure', code: requiredPaths.has(path) ? 'failed-required-request' : 'unsaved-local-request', severity: requiredPaths.has(path) ? 'error' : 'info', message: `Archive requested an unavailable local file: ${path}`, path, url: requestUrl });
        await chrome.debugger.sendCommand(debuggeeId, 'Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 404, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: btoa('Not found') }).catch(() => {});
        return;
      }
      await chrome.debugger.sendCommand(debuggeeId, 'Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: file.mimeType }, { name: 'cache-control', value: 'public, max-age=3600' }],
        body: params.request.method === 'HEAD' ? '' : bytesToBase64(file.bytes)
      }).then(() => { runnerEvidence.fulfilledRequests += 1; }, (error) => addDiagnostic({ category: 'validator-infrastructure', code: 'request-fulfillment-failed', severity: 'error', message: error.message, path, url: requestUrl }));
    })();
  };

  const evaluate = async (expression) => {
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Validation expression failed');
      runnerEvidence.lastEvaluationType = result.result && result.result.type || null;
      runnerEvidence.lastEvaluationValue = result.result && result.result.value;
      return result.result && result.result.value;
    } catch (error) {
      runnerEvidence.lastEvaluationError = error.message;
      throw error;
    }
  };

  const checkRoute = async (route, isRoot = false) => {
    const routeStartedAt = Date.now();
    if (activeValidation.cancelled) return;
    const sourceUrl = new URL(route.url, validationOrigin);
    const validationUrl = `${validationOrigin}${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`;
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: validationUrl });
    const loaded = await waitForValidationCondition(() => evaluate(`document.documentElement?.dataset.opensaveValidationMarker === ${JSON.stringify(route.expectedMarker)}`), plan.budget.maxRouteDurationMs);
    if (!loaded) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      addDiagnostic({ category: 'replay-runtime-failure', code: 'route-load-timeout', severity: 'error', message: 'Saved route did not finish loading within the validation budget.', routeId: route.routeId, url: route.url, evidence: { ...runnerEvidence, tabUrl: tab && tab.url || null } });
      routeResults.push({ routeId: route.routeId, url: route.url, validationUrl, expectedMarker: route.expectedMarker, actualMarker: null, status: 'failed', durationMs: Date.now() - routeStartedAt });
      return;
    }
    if (isRoot) {
      serviceWorkerControlled = await waitForValidationCondition(() => evaluate(`Promise.race([navigator.serviceWorker?.ready.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 250))])`), plan.budget.maxServiceWorkerDurationMs);
      if (serviceWorkerControlled) {
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: true });
        await waitForValidationCondition(() => evaluate('document.readyState === "complete" && Boolean(navigator.serviceWorker.controller)'), plan.budget.maxRouteDurationMs);
      } else {
        const registration = await evaluate(`(async () => ({
          secureContext: isSecureContext,
          registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((item) => ({ scope: item.scope, installing: item.installing?.state || null, waiting: item.waiting?.state || null, active: item.active?.state || null })) : [],
          error: 'serviceWorker' in navigator ? await Promise.race([
            navigator.serviceWorker.register('/sitesaver-sw.js').then(() => '', (error) => error.message),
            new Promise((resolve) => setTimeout(() => resolve('registration-timeout'), 1000))
          ]) : 'Service worker API unavailable'
        }))()`).catch((error) => ({ error: error.message }));
        addDiagnostic({ category: 'validator-infrastructure', code: 'local-companion-required', severity: 'warning', message: 'Chrome did not expose the service-worker update fetch to the in-extension validator. Run the included local validator for a final ready/failed result.', evidence: { ...runnerEvidence, registration } });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const actualMarker = await evaluate('document.documentElement.dataset.opensaveValidationMarker || null').catch(() => null);
    const replayLedger = await evaluate('window.__openSaveReplayLedger ? window.__openSaveReplayLedger() : null').catch(() => null);
    for (const miss of replayLedger && replayLedger.runtimeMisses || []) {
      addDiagnostic({ category: 'replay-runtime-failure', code: `runtime-replay-${miss.reasonCode || 'miss'}`, severity: 'warning', message: `Replay runtime miss: ${miss.reasonCode || 'unknown'}.`, routeId: route.routeId, evidence: miss.evidence || null });
    }
    const routeStatus = actualMarker === route.expectedMarker ? 'ready' : 'failed';
    if (routeStatus === 'failed') addDiagnostic({ category: 'replay-runtime-failure', code: 'route-content-mismatch', severity: 'error', message: 'Saved route rendered different page content than its captured checkpoint.', routeId: route.routeId, url: route.url, evidence: { expectedMarker: route.expectedMarker, actualMarker } });
    routeResults.push({ routeId: route.routeId, url: route.url, validationUrl, expectedMarker: route.expectedMarker, actualMarker, status: routeStatus, durationMs: Date.now() - routeStartedAt });
    checkedRoutes += 1;
  };

  activeValidation = { cancelled: false, tabId: null };
  btnCancelCapture.hidden = false;
  btnCancelCapture.disabled = false;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    activeValidation.tabId = tabId;
    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.attach({ tabId }, '1.3');
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
      chrome.debugger.sendCommand({ tabId }, 'Network.enable'),
      configureSession({ tabId }),
      chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { type: 'shared_worker', exclude: false }, { type: 'service_worker', exclude: false }] })
    ]);
    await checkRoute({ routeId: 'root', url: plan.root.url, expectedMarker: plan.root.expectedMarker }, true);
    for (const route of plan.routes) {
      if (activeValidation.cancelled || Date.now() - startedAt >= plan.budget.maxDurationMs) break;
      status(`Проверяю архив: ${checkedRoutes + 1}/${plan.routes.length + 1}`, 90);
      await checkRoute(route);
    }
    if (!activeValidation.cancelled && checkedRoutes < plan.routes.length + 1) addDiagnostic({ category: 'validator-infrastructure', code: 'validation-time-budget', severity: 'warning', message: 'Validation stopped at its total time budget.', evidence: { checkedRoutes, totalRoutes: plan.routes.length + 1 } });
  } catch (error) {
    addDiagnostic({ category: 'validator-infrastructure', code: 'validator-runner-failed', severity: 'error', message: error.message });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (tabId) await chrome.debugger.detach({ tabId }).catch(() => {});
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }

  const cancelled = Boolean(activeValidation && activeValidation.cancelled);
  activeValidation = null;
  return ArchiveValidator.finalize({
    plan,
    diagnostics,
    cancelled,
    startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    zeroEgressVerified: true,
    serviceWorkerControlled,
    checkedRoutes,
    totalRoutes: plan.routes.length + 1,
    requiredFilesChecked: plan.requiredFiles.length,
    routeResults
  });
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

    setStage('Подготовка страницы');
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
    const replayProjection = CaptureGraph.projectReplayExchanges(graph);
    const renderedProjection = CaptureGraph.projectRenderedPages(graph);
    const hydratedProjection = await hydrateDurableProjection([...bodyProjection, ...snapshotProjection, ...replayProjection, ...renderedProjection]);
    const bodies = hydratedProjection.slice(0, bodyProjection.length);
    const apiSnapshots = hydratedProjection.slice(bodyProjection.length, bodyProjection.length + snapshotProjection.length);
    const replayExchanges = hydratedProjection.slice(bodyProjection.length + snapshotProjection.length, bodyProjection.length + snapshotProjection.length + replayProjection.length);
    const renderedPages = hydratedProjection.slice(bodyProjection.length + snapshotProjection.length + replayProjection.length);

    setStage('Сбор страниц и ресурсов');
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
    
    setStage('Сохранение медиа и данных');
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

    const replayMisses = CaptureGraph.projectReplayMisses(graph);
    const replaySnapshots = [];
    for (const [index, snapshot] of replayExchanges.entries()) {
      try {
        const parsedUrl = new URL(snapshot.url);
        if (!/^https?:$/.test(parsedUrl.protocol)) continue;
        replaySnapshots.push({
          ...snapshot,
          url: OpenSaveReplayMatcher.normalizeUrl(parsedUrl.href),
          localPath: snapshot.bodyAvailable ? `/${apiSnapshotPath(snapshot, index)}` : null
        });
      } catch (error) {
        // Skip invalid URL snapshot entries without failing the whole archive build.
      }
    }
    log(`Снимков Fetch/XHR: ${replaySnapshots.length}`);
    captureReport.captureGraphParity.finalArchiveInputsMatch = await finalProjectionParity(graph, catalog, apiSnapshots);
    const replayIdentityGroups = new Map();
    for (const snapshot of replaySnapshots) {
      const identity = `${OpenSaveReplayMatcher.pathKey(snapshot.url)}\n${snapshot.method}\n${OpenSaveReplayMatcher.normalizeContentType(snapshot.contentType)}\n${snapshot.requestBodyHash}`;
      if (!replayIdentityGroups.has(identity)) replayIdentityGroups.set(identity, []);
      replayIdentityGroups.get(identity).push(snapshot);
    }
    const replayAmbiguities = [...replayIdentityGroups.entries()].flatMap(([identity, matches]) => {
      const origins = [...new Set(matches.map((snapshot) => new URL(snapshot.url).origin))];
      return origins.length > 1 ? [{ reasonCode: 'ambiguous', evidenceRefs: matches.flatMap((snapshot) => snapshot.evidenceRefs || []), evidence: { identity, candidateCount: matches.length, origins } }] : [];
    });
    replayMisses.push(...replayAmbiguities);
    const supportedReplayCount = replaySnapshots.filter((snapshot) => !replayMisses.some((miss) => miss.evidence && miss.evidence.exchangeId === snapshot.exchangeId)).length;
    captureReport.replay = {
      schemaVersion: 1,
      recordedRequests: replayExchanges.length,
      supportedRequests: supportedReplayCount,
      locallyFulfillableRequests: replaySnapshots.filter((snapshot) => snapshot.bodyAvailable || [204, 205, 301, 302, 303, 307, 308].includes(snapshot.status)).length,
      supportedCoverage: replayExchanges.length ? Number(((supportedReplayCount / replayExchanges.length) * 100).toFixed(1)) : 100,
      ambiguityCount: replayAmbiguities.length,
      captureMissCount: replayMisses.length,
      missReasonCounts: replayMisses.reduce((counts, miss) => ({ ...counts, [miss.reasonCode]: (counts[miss.reasonCode] || 0) + 1 }), {})
    };

    setStage('Сборка копии');
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

    status('Собираю архив...', 75);
    const zip = new JSZip();
    const rootValidationMarker = `root:${graph.documents[0] && graph.documents[0].id || 'entry'}`;
    const archiveHtml = injectValidationMarker(fixedHtml, rootValidationMarker);
    const routeResources = catalog.resources.filter((resource) => resource.routePage);
    for (const resource of routeResources) resource.body = injectValidationMarker(String(resource.body || ''), resource.routeId);
    zip.file('index.html', archiveHtml);
    zip.file('404.html', createSpaFallback());
    zip.file('replay-matcher.js', await fetch(chrome.runtime.getURL('replay-matcher.js')).then((response) => response.text()));
    zip.file('archive-validator.js', await fetch(chrome.runtime.getURL('archive-validator.js')).then((response) => response.text()));
    zip.file('archive-validator-companion.mjs', await fetch(chrome.runtime.getURL('archive-validator-companion.mjs')).then((response) => response.text()));
    zip.file('replay-misses.json', JSON.stringify({ schemaVersion: 1, captureMisses: replayMisses, runtimeMisses: [] }, null, 2));
    zip.file('sitesaver-offline.js', createOfflineReplayScript(replaySnapshots, routeResources));
    zip.file('sitesaver-sw.js', createOfflineServiceWorker(catalog.resources, replaySnapshots, replayMisses));
    const archiveManifest = {
      format: 'sitesaver-offline-archive',
      version: 3,
      sourceUrl: pageUrl,
      captureMode: capturedMode,
      capturedAt: new Date().toISOString(),
      resourceCount: catalog.resources.length,
      pageCount: savedPageCount,
      apiSnapshotCount: replaySnapshots.length,
      replayMissCount: replayMisses.length,
      validationStatus: 'pending'
    };
    zip.file('sitesaver-report.json', JSON.stringify(finalReport, null, 2));
    zip.file('sitesaver-manifest.json', JSON.stringify(archiveManifest, null, 2));
    zip.file('README.txt', createArchiveReadme());
    zip.file('open-windows.bat', createWindowsBatchLauncher());
    zip.file('open-windows.ps1', createWindowsPowerShellLauncher());
    zip.file('open-unix.sh', createUnixLauncher(), { unixPermissions: '755' });
    zip.file('validate-windows.bat', createWindowsValidatorLauncher());
    zip.file('validate-unix.sh', createUnixValidatorLauncher(), { unixPermissions: '755' });
    replaySnapshots.filter((snapshot) => snapshot.localPath).forEach((snapshot) => {
      zip.file(snapshot.localPath.slice(1), snapshot.body, snapshot.base64Encoded ? { base64: true } : undefined);
    });
    for (const resource of catalog.resources) {
      zip.file(resource.localPath, resource.body, resource.base64Encoded ? { base64: true } : undefined);
    }

    setStage('Проверка результата');
    status('Проверяю готовый архив...', 90);
    await saveGraphMission(graph, 'validating');
    const rootPath = `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`;
    const validationRoutes = routeResources.filter((resource) => {
      try {
        const url = new URL(resource.routeUrl || resource.url);
        return `${url.pathname}${url.search}` !== rootPath;
      } catch (error) {
        return true;
      }
    }).map((resource) => ({
      routeId: resource.routeId,
      url: resource.routeUrl || resource.url,
      localPath: resource.localPath,
      expectedMarker: resource.routeId,
      evidenceRefs: [resource.routeId, ...(resource.evidenceRefs || [])].filter(Boolean)
    }));
    const requiredFiles = [
      ...['index.html', '404.html', 'replay-matcher.js', 'replay-misses.json', 'sitesaver-offline.js', 'sitesaver-sw.js', 'sitesaver-report.json', 'sitesaver-manifest.json', 'archive-validator.js', 'archive-validator-companion.mjs', 'validate-windows.bat', 'validate-unix.sh', 'validation-plan.json', 'validation-report.json'].map((path) => ({ path, critical: true })),
      ...catalog.resources.map((resource) => ({ path: resource.localPath, critical: true, evidenceRefs: resource.evidenceRefs || [] })),
      ...replaySnapshots.filter((snapshot) => snapshot.localPath).map((snapshot) => ({ path: snapshot.localPath, critical: true, evidenceRefs: snapshot.evidenceRefs || [] }))
    ];
    const validationInput = {
      rootUrl: '/',
      rootMarker: rootValidationMarker,
      routes: validationRoutes,
      captureRoutes: graph.routes,
      requiredFiles,
      report: finalReport,
      replayMisses,
      budget: { maxRoutes: MAX_PAGES, maxDurationMs: capturedMode === 'deep' ? 60000 : 30000, maxRouteDurationMs: 7000, maxServiceWorkerDurationMs: 2000 }
    };
    const validationPlan = ArchiveValidator.createPlan(validationInput);
    validationPlan.baselineDiagnostics = ArchiveValidator.inputDiagnostics({ report: finalReport, routes: graph.routes, replayMisses });
    zip.file('validation-plan.json', JSON.stringify(validationPlan, null, 2));
    zip.file('validation-report.json', JSON.stringify(ArchiveValidator.finalize({ plan: validationPlan, diagnostics: [{ category: 'validator-infrastructure', code: 'validation-pending', severity: 'warning', message: 'Archive validation has not completed.' }], totalRoutes: validationPlan.routes.length + 1 }), null, 2));
    const validation = await validateArchive(zip, validationInput);
    finalReport.validation = validation;
    archiveManifest.validationStatus = validation.status;
    archiveManifest.validationDurationMs = validation.durationMs;
    zip.file('validation-report.json', JSON.stringify(validation, null, 2));
    zip.file('sitesaver-report.json', JSON.stringify(finalReport, null, 2));
    zip.file('sitesaver-manifest.json', JSON.stringify(archiveManifest, null, 2));
    mission.state = validation.status === 'ready' ? 'completed' : validation.status;
    mission.completedAt = Date.now();
    await saveGraphMission(graph, mission.state, { validation });
    renderReport(finalReport);

    const totalDiscoveredPages = (graph.routes || []).length || 1;
    const totalRequiredFiles = (finalReport.completeness && finalReport.completeness.discovered) || catalog.resources.length;
    const savedFiles = (finalReport.completeness && finalReport.completeness.saved) || catalog.resources.length;
    const ignoredAnalytics = (finalReport.unresolvedResources || []).filter((item) => isAnalyticsOrTracker(item.url)).length;

    let recommendedAction = '';
    if (validation.status === 'partial') {
      if (validation.diagnostics.some((item) => item.code === 'local-companion-required')) {
        recommendedAction = 'Откройте распакованную папку и запустите validate-windows.bat (или validate-unix.sh) для финальной проверки сервис-воркера.';
      } else {
        recommendedAction = 'Проверьте список замечаний в подробностях или повторите глубокий захват страницы.';
      }
    } else if (validation.status === 'failed') {
      recommendedAction = 'Попробуйте обновить страницу и запустить захват заново.';
    }

    renderSummary({
      status: validation.status,
      savedPages: savedPageCount,
      totalDiscoveredPages,
      savedFiles,
      totalRequiredFiles,
      ignoredAnalyticsCount: ignoredAnalytics,
      testedRoutes: validation.checkedRoutes,
      failedRoutes: validation.routes.filter((r) => r.status === 'failed').length,
      recommendedAction
    });

    log(`Проверка архива: ${validation.status}, маршруты ${validation.checkedRoutes}/${validation.totalRoutes}, замечания ${validation.issueCount}`, validation.status === 'ready' ? 'ok' : 'err');
    for (const diagnostic of validation.diagnostics.filter((item) => item.severity !== 'info').slice(0, 10)) {
      log(`[${diagnostic.category}/${diagnostic.code}] ${diagnostic.message}`, 'err');
    }

    setStage('Готово');
    status('Генерирую архив...', 94);
    const archive = await zip.generateAsync({ type: 'blob', streamFiles: true });
    log(`Архив: ${(archive.size / 1024 / 1024).toFixed(2)} MB, ${catalog.resources.length + 1} файлов`, 'ok');

    status('Скачиваю...', 97);
    await downloadArchiveBlob(archive, `${domain}.zip`);

    await captureStorage.cleanupMission(missionId);
    exportingMissionId = null;

    status(validation.status === 'ready' ? 'Архив готов' : `Архив скачан: ${validation.status}`, 100);
    log('Архив скачан. Результат проверки сохранён в validation-report.json.', validation.status === 'ready' ? 'ok' : 'err');
  } catch (error) {
    setStage('Ошибка');
    if (summaryCardEl) {
      renderSummary({
        status: 'failed',
        savedPages: 0,
        totalDiscoveredPages: 1,
        savedFiles: 0,
        totalRequiredFiles: 1,
        ignoredAnalyticsCount: 0,
        testedRoutes: 0,
        failedRoutes: 0,
        recommendedAction: error.message || 'Проверьте соединение или повторите захват.'
      });
    }
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
  if (activeValidation) {
    activeValidation.cancelled = true;
    status('Отменяю проверку архива...');
    if (activeValidation.tabId) await chrome.tabs.remove(activeValidation.tabId).catch(() => {});
    return;
  }
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

if (document.documentElement) document.documentElement.dataset.opensaveReady = 'true';

btnFinishScenario.addEventListener('click', () => capture('finishScenario'));
