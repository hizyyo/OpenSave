let activeTabId = null;
let activePageOrigin = '';
let activeOperation = null;
let nextOperationId = 1;
let detachingTabId = null;
const capturedBodies = new Map();
const pendingResponses = new Map();
const pendingBodyReads = new Set();
const pendingRequests = new Map();
const apiSnapshots = new Map();
const streamedBodies = new Map();
let captureReport = createCaptureReport();
let reportUpdateScheduled = false;

const KEEP_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/manifest+json',
  'application/json',
  'application/octet-stream',
  'model/',
  'image/',
  'font/',
  'application/font',
  'application/x-font',
  'audio/',
  'video/',
  'application/wasm'
];

const STATIC_EXTENSIONS = /\.(?:avif|basis|bin|bmp|css|dds|drc|eot|exr|fbx|gif|glb|gltf|hdr|ico|jpeg|jpg|js|ktx2?|meshopt|mjs|mp3|mp4|obj|ogg|otf|ply|png|svg|tga|ttf|usdz|vrm|wasm|wav|webm|webp|woff2?)(?:$|[?#])/i;
const MAX_STREAM_BODY_BYTES = 300 * 1024 * 1024;
const ENABLE_EXPERIMENTAL_STREAMING = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'attach') {
    const operation = beginOperation(msg.tabId, 'attach');
    if (!operation) {
      sendResponse({ ok: false, error: 'Уже выполняется захват в другой вкладке' });
      return;
    }
    attach(msg.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    }).finally(() => {
      finishOperation(operation);
    });
    return true;
  }
  if (msg.action === 'fullCapture') {
    const operation = beginOperation(msg.tabId, 'capture');
    if (!operation) {
      sendResponse({ ok: false, error: 'Уже выполняется захват в другой вкладке' });
      return;
    }
    const mode = msg.mode === 'deep' ? 'deep' : 'quick';
    fullCapture(msg.tabId, sendResponse, [], operation, mode).finally(() => finishOperation(operation));
    return true;
  }
  if (msg.action === 'startBuilder') {
    const operation = beginOperation(msg.tabId, 'builder');
    if (!operation) {
      sendResponse({ ok: false, error: 'Уже выполняется захват в другой вкладке' });
      return;
    }
    startBuilder(msg.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    }).finally(() => finishOperation(operation));
    return true;
  }
  if (msg.action === 'recordScenario') {
    const operation = beginOperation(msg.tabId, 'recording');
    if (!operation) {
      sendResponse({ ok: false, error: 'Уже выполняется захват в другой вкладке' });
      return;
    }
    recordScenario(msg.tabId).then((result) => {
      if (!result.ok) finishOperation(operation);
      sendResponse(result);
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message });
      finishOperation(operation);
    });
    return true;
  }
  if (msg.action === 'finishScenario') {
    const operation = activeOperation;
    if (!operation || operation.tabId !== msg.tabId || operation.mode !== 'recording') {
      sendResponse({ ok: false, error: 'Нет активной записи сценария для этой вкладки' });
      return;
    }
    // A recorded scenario only has meaning when replayed through the deep pipeline.
    finishScenario(msg.tabId, sendResponse, operation, 'deep').finally(() => finishOperation(operation));
    return true;
  }
  if (msg.action === 'startElementPicker') {
    const operation = beginOperation(msg.tabId, 'picker');
    if (!operation) {
      sendResponse({ ok: false, error: 'Уже выполняется захват в другой вкладке' });
      return;
    }
    startElementPicker(msg.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
      finishOperation(operation);
    });
    return true;
  }
});

chrome.debugger.onDetach.addListener((debuggeeId) => {
  if (debuggeeId.tabId === activeTabId && !debuggeeId.sessionId) {
    resetCapture();
    if (detachingTabId !== debuggeeId.tabId) activeOperation = null;
  }
});

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
  if (debuggeeId.tabId !== activeTabId) return;
  const key = requestKey(debuggeeId, params && params.requestId);

  if (method === 'Target.attachedToTarget') {
    attachChildTarget({ ...debuggeeId, sessionId: params.sessionId }, params.targetInfo).catch((error) => {
      addReport('unreadableResponses', { url: params.targetInfo.url, reason: `Child target: ${error.message}` });
    });
    return;
  }

  if (method === 'Runtime.bindingCalled' && params.name === '__siteSaverRecordAction' && activeOperation && activeOperation.mode === 'recording') {
    try {
      const action = JSON.parse(params.payload);
      if (action && typeof action.selector === 'string' && activeOperation.scenario.length < 200) {
        const previous = activeOperation.scenario.at(-1);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(action)) activeOperation.scenario.push(action);
      }
    } catch (error) {
      addReport('unreadableResponses', { url: 'Scenario action', reason: error.message });
    }
    return;
  }

  if (method === 'Runtime.bindingCalled' && params.name === '__siteSaverPickElement' && activeOperation && activeOperation.mode === 'picker') {
    completeElementPicker(debuggeeId.tabId, params.payload, activeOperation).catch((error) => {
      addReport('unreadableResponses', { url: 'Element picker', reason: error.message });
    });
    return;
  }

  if (method === 'Page.loadEventFired' && activeOperation && activeOperation.mode === 'recording') {
    installScenarioRecorder(activeTabId).catch((error) => {
      addReport('unreadableResponses', { url: 'Scenario recorder', reason: error.message });
    });
    return;
  }

  if (method === 'Network.responseReceived') {
    const { response, requestId } = params;
    if (response.status >= 400) addReport('httpErrors', { url: response.url, status: response.status, mimeType: response.mimeType || '' });
    if (shouldCapture(response, params.type)) {
      const capture = {
        response,
        request: pendingRequests.get(key),
        resourceType: params.type,
        debuggeeId,
        operationId: activeOperation && activeOperation.id
      };
      pendingResponses.set(key, capture);
      if (ENABLE_EXPERIMENTAL_STREAMING && isDeepCapture()) startNetworkStream(key, requestId, capture);
    } else {
      addReport('skippedResponses', { url: response.url, mimeType: response.mimeType || '', reason: 'Unsupported response type' });
    }
    return;
  }

  if (method === 'Network.dataReceived') {
    const stream = streamedBodies.get(key);
    if (stream && params.data) {
      stream.chunks.push(params.data);
      stream.bytes += params.dataLength || 0;
      if (stream.bytes > MAX_STREAM_BODY_BYTES) stream.overflow = true;
    }
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    pendingRequests.set(key, {
      url: params.request.url,
      method: params.request.method,
      postData: params.request.postData || ''
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const capture = pendingResponses.get(key);
    if (!capture) {
      pendingRequests.delete(key);
      return;
    }
    pendingResponses.delete(key);
    const stream = streamedBodies.get(key);
    if (stream && !stream.overflow && !stream.starting) {
      streamedBodies.delete(key);
      finalizeNetworkStream(key, capture, stream);
    } else {
      streamedBodies.delete(key);
      pendingBodyReads.add(key);
      captureResponseBody(key, params.requestId, capture);
    }
    return;
  }

  if (method === 'Network.loadingFailed') {
    const request = pendingRequests.get(key);
    addReport('networkFailures', { url: request && request.url, error: params.errorText || 'Network loading failed', type: params.type || '' });
    pendingResponses.delete(key);
    streamedBodies.delete(key);
    pendingRequests.delete(key);
  }
});

function createCaptureReport() {
  return {
    networkFailures: [],
    httpErrors: [],
    unreadableResponses: [],
    skippedResponses: [],
    childTargets: [],
    cacheEntries: 0,
    cacheResources: 0,
    streamedResponses: 0,
    streamedBytes: 0
  };
}

function beginOperation(tabId, mode) {
  if (activeOperation) return null;
  activeOperation = { id: nextOperationId, tabId, mode, scenario: mode === 'recording' ? [] : undefined };
  nextOperationId += 1;
  return activeOperation;
}

function finishOperation(operation) {
  if (activeOperation && activeOperation.id === operation.id) activeOperation = null;
}

function isCurrentOperation(operationId) {
  return Boolean(activeOperation && activeOperation.id === operationId);
}

function addReport(type, item) {
  const collection = captureReport[type];
  if (!Array.isArray(collection) || collection.length >= 100) return;
  collection.push(item);
  scheduleReportUpdate();
}

function scheduleReportUpdate() {
  if (reportUpdateScheduled) return;
  reportUpdateScheduled = true;
  setTimeout(() => {
    reportUpdateScheduled = false;
    chrome.runtime.sendMessage({ action: 'captureReport', report: captureReport }).catch(() => {});
  }, 250);
}

function requestKey(debuggeeId, requestId) {
  return `${debuggeeId.sessionId || 'root'}:${requestId || ''}`;
}

function shouldCapture(response, resourceType) {
  const url = response.url || '';
  if (!/^https?:/i.test(url)) return false;
  if (resourceType === 'Document' && activePageOrigin && new URL(url).origin !== activePageOrigin) return false;
  const mimeType = (response.mimeType || '').toLowerCase();
  return KEEP_TYPES.some((type) => mimeType.startsWith(type)) || mimeType.includes('json') || STATIC_EXTENSIONS.test(url);
}

async function captureResponseBody(key, requestId, capture) {
  if (!activeTabId || !isCurrentOperation(capture.operationId)) return;

  try {
    const body = await chrome.debugger.sendCommand(capture.debuggeeId, 'Network.getResponseBody', { requestId });
    if (!activeTabId || !body || !isCurrentOperation(capture.operationId)) return;

    saveCapturedBody(capture, body.body, body.base64Encoded);
  } catch (error) {
    // Responses are evicted by Chrome for very large or cancelled requests.
    addReport('unreadableResponses', { url: capture.response.url, reason: error.message });
  } finally {
    pendingBodyReads.delete(key);
    pendingRequests.delete(key);
  }
}

function saveCapturedBody(capture, body, base64Encoded) {
  const url = new URL(capture.response.url);
  url.hash = '';
  if (!capturedBodies.has(url.href)) {
    capturedBodies.set(url.href, {
      url: url.href,
      mimeType: capture.response.mimeType || '',
      body,
      base64Encoded,
      preserveUrl: capture.resourceType === 'Fetch' || capture.resourceType === 'XHR'
    });
  } else if (capture.resourceType === 'Fetch' || capture.resourceType === 'XHR') {
    capturedBodies.get(url.href).preserveUrl = true;
  }

  if ((capture.resourceType === 'Fetch' || capture.resourceType === 'XHR') && capture.response.status >= 200 && capture.response.status < 300) {
    const request = capture.request || { url: url.href, method: 'GET', postData: '' };
    const snapshotKey = `${request.method}\n${url.href}\n${request.postData}`;
    if (!apiSnapshots.has(snapshotKey)) {
      apiSnapshots.set(snapshotKey, {
        url: url.href,
        method: request.method,
        postData: request.postData,
        status: capture.response.status,
        statusText: capture.response.statusText || '',
        mimeType: capture.response.mimeType || '',
        body,
        base64Encoded
      });
    }
  }
}

async function startNetworkStream(key, requestId, capture) {
  streamedBodies.set(key, { chunks: [], bytes: 0, overflow: false, starting: true });
  try {
    const result = await chrome.debugger.sendCommand(capture.debuggeeId, 'Network.streamResourceContent', { requestId });
    const stream = streamedBodies.get(key);
    if (!stream || !isCurrentOperation(capture.operationId)) return;
    if (result.bufferedData) {
      stream.chunks.unshift(result.bufferedData);
      stream.bytes += Math.floor((result.bufferedData.length * 3) / 4);
    }
    if (stream.bytes > MAX_STREAM_BODY_BYTES) stream.overflow = true;
    stream.starting = false;
  } catch (error) {
    // Network.getResponseBody remains the fallback for unsupported responses.
    streamedBodies.delete(key);
  }
}

function finalizeNetworkStream(key, capture, stream) {
  if (!isCurrentOperation(capture.operationId)) return;
  try {
    const blob = new Blob(stream.chunks.flatMap(base64ToByteChunks), { type: capture.response.mimeType || 'application/octet-stream' });
    saveCapturedBody(capture, blob, false);
    captureReport.streamedResponses += 1;
    captureReport.streamedBytes += blob.size;
  } catch (error) {
    addReport('unreadableResponses', { url: capture.response.url, reason: `Network stream: ${error.message}` });
  }
}

function base64ToByteChunks(value) {
  const chunks = [];
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const binary = atob(value.slice(offset, offset + chunkSize));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    chunks.push(bytes);
  }
  return chunks;
}

async function attach(tabId) {
  if (activeTabId) await detach();

  activeTabId = tabId;
  capturedBodies.clear();
  pendingResponses.clear();
  pendingBodyReads.clear();
  pendingRequests.clear();
  apiSnapshots.clear();
  streamedBodies.clear();
  captureReport = createCaptureReport();

  try {
    const tab = await chrome.tabs.get(tabId);
    activePageOrigin = new URL(tab.url).origin;
    await chrome.debugger.attach({ tabId }, '1.3');
    await enableNetworkCapture({ tabId }, true);
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });
    return { ok: true };
  } catch (error) {
    resetCapture();
    return { ok: false, error: error.message };
  }
}

async function enableNetworkCapture(debuggeeId, attachChildren = false) {
  await chrome.debugger.sendCommand(debuggeeId, 'Network.enable', {
    maxTotalBufferSize: 500 * 1024 * 1024,
    maxResourceBufferSize: 200 * 1024 * 1024,
    maxPostDataSize: 10 * 1024 * 1024,
    enableDurableMessages: true
  });
  if (!attachChildren) return;
  try {
    await chrome.debugger.sendCommand(debuggeeId, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [
        { type: 'iframe', exclude: false },
        { type: 'worker', exclude: false },
        { type: 'shared_worker', exclude: false },
        { type: 'service_worker', exclude: false }
      ]
    });
  } catch (error) {
    addReport('unreadableResponses', { url: 'Target.setAutoAttach', reason: error.message });
  }
}

async function attachChildTarget(debuggeeId, targetInfo) {
  addReport('childTargets', { type: targetInfo.type, url: targetInfo.url || '' });
  await enableNetworkCapture(debuggeeId, true);
}

function isDeepCapture() {
  return Boolean(activeOperation && activeOperation.captureMode === 'deep');
}

async function captureKnownCaches(tabId, pageUrl) {
  const origins = new Set([new URL(pageUrl).origin]);
  captureReport.childTargets.forEach((target) => {
    try {
      origins.add(new URL(target.url).origin);
    } catch (error) {
      // Targets without a URL do not expose a Cache Storage origin.
    }
  });

  for (const origin of origins) {
    try {
      const cacheNames = await chrome.debugger.sendCommand({ tabId }, 'CacheStorage.requestCacheNames', { securityOrigin: origin });
      for (const cache of cacheNames.caches || []) await captureCacheEntries({ tabId }, cache.cacheId);
    } catch (error) {
      addReport('unreadableResponses', { url: origin, reason: `Cache Storage: ${error.message}` });
    }
  }
}

async function captureCacheEntries(debuggeeId, cacheId) {
  let skipCount = 0;
  while (true) {
    const page = await chrome.debugger.sendCommand(debuggeeId, 'CacheStorage.requestEntries', {
      cacheId,
      skipCount,
      pageSize: 100
    });
    const entries = page.cacheDataEntries || [];
    captureReport.cacheEntries += entries.length;

    for (const entry of entries) {
      if (!/^https?:/i.test(entry.requestURL) || entry.responseStatus < 200 || entry.responseStatus >= 300) continue;
      try {
        const cached = await chrome.debugger.sendCommand(debuggeeId, 'CacheStorage.requestCachedResponse', {
          cacheId,
          requestURL: entry.requestURL,
          requestHeaders: entry.requestHeaders || []
        });
        const url = new URL(entry.requestURL);
        url.hash = '';
        if (!capturedBodies.has(url.href)) {
          const contentType = (entry.responseHeaders || []).find((header) => header.name.toLowerCase() === 'content-type');
          capturedBodies.set(url.href, {
            url: url.href,
            mimeType: contentType ? contentType.value : '',
            body: cached.response.body,
            base64Encoded: true
          });
          captureReport.cacheResources += 1;
        }
        const method = entry.requestMethod || 'GET';
        const snapshotKey = `${method}\n${url.href}\n`;
        if (!apiSnapshots.has(snapshotKey)) {
          apiSnapshots.set(snapshotKey, {
            url: url.href,
            method,
            postData: '',
            status: entry.responseStatus,
            statusText: entry.responseStatusText || '',
            mimeType: contentType ? contentType.value : '',
            body: cached.response.body,
            base64Encoded: true
          });
        }
      } catch (error) {
        addReport('unreadableResponses', { url: entry.requestURL, reason: `Cache entry: ${error.message}` });
      }
    }

    skipCount += entries.length;
    if (!page.returnCount || entries.length === 0) return;
  }
}

async function fullCapture(tabId, sendResponse, scenario = [], operation, mode = 'quick') {
  const reply = (data) => {
    try {
      sendResponse(data);
    } catch (error) {
      // The side panel can be closed before the capture completes.
    }
  };

  try {
    if (operation) operation.captureMode = mode;
    const attached = await attach(tabId);
    if (!attached.ok) {
      reply(attached);
      return;
    }

    await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

    // Register before reload so a fast page cannot miss its load event.
    const pageLoaded = waitForPageLoad(tabId);
    await chrome.tabs.reload(tabId);
    await pageLoaded;
    await sleep(mode === 'deep' ? 1500 : 600);

    const startActivation = mode === 'deep'
      ? await optionalStage('Start overlay activation', () => activateStartOverlay(tabId), { clicked: 0, waited: 0 })
      : { clicked: 0, waited: 0 };
    const replayedScenario = mode === 'deep'
      ? await optionalStage('Scenario replay', () => replayScenario(tabId, scenario), { total: scenario.length, replayed: 0 })
      : { total: 0, replayed: 0 };
    const firstScroll = mode === 'deep'
      ? await optionalStage('Page scrolling', () => scrollForLazyResources(tabId), { containers: 0 })
      : { containers: 0 };
    const hover = mode === 'deep'
      ? await optionalStage('Hover exploration', () => exploreHoverStates(tabId), { hovered: 0 })
      : { hovered: 0 };
    const interaction = mode === 'deep'
      ? await optionalStage('Interactive exploration', () => exploreInteractiveElements(tabId), { clicked: 0, skipped: 0, states: 0 })
      : { clicked: 0, skipped: 0, states: 0 };
    const finalScroll = mode === 'deep'
      ? await optionalStage('Final scrolling', () => scrollForLazyResources(tabId), { containers: 0 })
      : { containers: 0 };
    const canvasSnapshots = mode === 'deep'
      ? await optionalStage('Canvas fallback', () => captureCanvasFallback(tabId), [])
      : [];
    await waitForPendingBodies(mode === 'deep' ? 10000 : 3000);

    const tab = await chrome.tabs.get(tabId);
    const pageUrl = tab.url;
    if (mode === 'deep') await optionalStage('Cache Storage export', () => captureKnownCaches(tabId, pageUrl), undefined);
    const domain = new URL(pageUrl).hostname || 'site';
    const document = await getDocumentHtml(tabId);

    reply({
      ok: true,
      html: document.html,
      bodies: Array.from(capturedBodies.values()),
      apiSnapshots: Array.from(apiSnapshots.values()),
      interaction: { ...interaction, hover, replayedScenario, startActivation, scrollContainers: firstScroll.containers + finalScroll.containers },
      canvasSnapshots,
      report: captureReport,
      mode,
      domain,
      pageUrl,
      htmlMethod: document.method
    });
  } catch (error) {
    reply({ ok: false, error: error.message || 'Не удалось захватить страницу' });
  } finally {
    if (activeTabId === tabId && isCurrentOperation(operation && operation.id)) await detach();
  }
}

async function optionalStage(name, action, fallback) {
  try {
    return await action();
  } catch (error) {
    addReport('unreadableResponses', { url: name, reason: error.message });
    return fallback;
  }
}

async function recordScenario(tabId) {
  const attached = await attach(tabId);
  if (!attached.ok) return attached;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.addBinding', { name: '__siteSaverRecordAction' });
    await installScenarioRecorder(tabId);
    return { ok: true };
  } catch (error) {
    await detach();
    return { ok: false, error: error.message };
  }
}

async function startElementPicker(tabId) {
  const attached = await attach(tabId);
  if (!attached.ok) return attached;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.addBinding', { name: '__siteSaverPickElement' });
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (() => {
          if (window.__siteSaverPickerCleanup) window.__siteSaverPickerCleanup();

          const overlay = document.createElement('div');
          const label = document.createElement('div');
          overlay.setAttribute('data-sitesaver-picker', 'overlay');
          label.setAttribute('data-sitesaver-picker', 'label');
          Object.assign(overlay.style, {
            position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
            border: '2px solid #64ff9b', background: 'rgba(34, 197, 94, .12)',
            boxShadow: '0 0 0 1px rgba(0,0,0,.7)', transition: 'all .06s ease'
          });
          Object.assign(label.style, {
            position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
            maxWidth: '360px', padding: '5px 8px', borderRadius: '5px',
            background: '#0b1b11', color: '#a7f3c2', border: '1px solid #22c55e',
            font: '12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          });
          document.documentElement.append(overlay, label);

          let current = null;
          const describe = (element) => {
            const id = element.id ? '#' + element.id : '';
            const classes = [...element.classList].slice(0, 2).map((value) => '.' + value).join('');
            return element.tagName.toLowerCase() + id + classes;
          };
          const update = (element) => {
            if (!element || element === document.documentElement || element === document.body || element.closest('[data-sitesaver-picker]')) return;
            current = element;
            const rect = element.getBoundingClientRect();
            Object.assign(overlay.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
            label.textContent = describe(element) + '  ' + Math.round(rect.width) + ' x ' + Math.round(rect.height) + '  Click to export';
            Object.assign(label.style, { left: Math.max(4, rect.left) + 'px', top: Math.max(4, rect.top - 28) + 'px' });
          };
          const serialize = (element) => {
            let context = element.cloneNode(true);
            let parent = element.parentElement;
            while (parent && parent !== document.body) {
              const shell = parent.cloneNode(false);
              shell.append(context);
              context = shell;
              parent = parent.parentElement;
            }
            const head = [...document.head.querySelectorAll('base, meta[charset], meta[name="viewport"], link[rel~="stylesheet"], style')]
              .map((node) => node.outerHTML).join('');
            return {
              pageUrl: location.href,
              title: document.title || 'selected-element',
              bodyClass: document.body.className,
              head,
              html: context.outerHTML,
              label: describe(element)
            };
          };
          const onMove = (event) => update(document.elementFromPoint(event.clientX, event.clientY));
          const onClick = (event) => {
            if (!current) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            window.__siteSaverPickElement(JSON.stringify({ selected: serialize(current) }));
            cleanup();
          };
          const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            window.__siteSaverPickElement(JSON.stringify({ cancelled: true }));
            cleanup();
          };
          const cleanup = () => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            label.remove();
            delete window.__siteSaverPickerCleanup;
          };
          window.__siteSaverPickerCleanup = cleanup;
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('click', onClick, true);
          document.addEventListener('keydown', onKey, true);
          return true;
        })()
      `,
      awaitPromise: true,
      userGesture: true
    });
    return { ok: true };
  } catch (error) {
    await detach();
    return { ok: false, error: error.message };
  }
}

async function completeElementPicker(tabId, payload, operation) {
  if (!isCurrentOperation(operation.id)) return;
  let result;
  try {
    result = JSON.parse(payload);
  } catch (error) {
    result = { cancelled: true };
  }
  if (activeTabId === tabId) await detach();
  finishOperation(operation);
  chrome.runtime.sendMessage({ action: 'elementPicked', ...result }).catch(() => {});
}

async function installScenarioRecorder(tabId) {
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (() => {
          if (window.__siteSaverScenarioRecorderInstalled) return true;
          window.__siteSaverScenarioRecorderInstalled = true;
          const selectorFor = (element) => {
            if (element.id) return '#' + CSS.escape(element.id);
            const testId = element.getAttribute('data-testid');
            if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
              let part = current.tagName.toLowerCase();
              if (current.name) part += '[name="' + CSS.escape(current.name) + '"]';
              else {
                const siblings = [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName);
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
              }
              parts.unshift(part);
              current = current.parentElement;
            }
            return 'body > ' + parts.join(' > ');
          };
          const record = (event) => {
            const element = event.target.closest('button, input, select, textarea, summary, [role="button"], [role="tab"], [aria-expanded], [data-testid]');
            if (!element) return;
            const inputType = (element.getAttribute('type') || '').toLowerCase();
            const sensitive = inputType === 'password' || inputType === 'file' || element.autocomplete === 'cc-number' || element.autocomplete === 'current-password' || element.autocomplete === 'new-password';
            if (sensitive || event.type === 'input' || element.matches('textarea, input:not([type="checkbox"]):not([type="radio"])')) return;
            const action = { type: event.type, selector: selectorFor(element) };
            if (event.type === 'change') {
              action.value = element.value;
              action.checked = Boolean(element.checked);
            }
            window.__siteSaverRecordAction(JSON.stringify(action));
          };
          document.addEventListener('click', record, true);
          document.addEventListener('change', record, true);
          return true;
        })()
      `,
      awaitPromise: true
    });
}

async function finishScenario(tabId, sendResponse, operation, mode) {
  try {
    const scenario = operation.scenario || [];
    if (activeTabId === tabId) await detach();
    await fullCapture(tabId, sendResponse, scenario, operation, mode);
  } catch (error) {
    if (activeTabId === tabId) await detach();
    sendResponse({ ok: false, error: error.message });
  }
}

async function replayScenario(tabId, scenario) {
  if (!scenario.length) return { total: 0, replayed: 0 };
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const actions = ${serializeForRuntime(scenario)};
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let replayed = 0;
        for (const action of actions) {
          const element = document.querySelector(action.selector);
          if (!element) continue;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          if (action.type === 'click') element.click();
          else {
            if ('value' in element) element.value = action.value;
            if ('checked' in element) element.checked = action.checked;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          replayed += 1;
          await delay(350);
        }
        return { total: actions.length, replayed };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  return result.result.value || { total: scenario.length, replayed: 0 };
}

async function activateStartOverlay(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startLabel = /^(?:start|begin|enter|launch)$/i;
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidate = () => [...document.querySelectorAll('button, [role="button"], [onclick], [data-action], [data-testid], div, span')]
          .find((element) => {
            if (!visible(element) || element.closest('form, a[href], [contenteditable="true"]')) return false;
            const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
            return startLabel.test(text);
          });

        let waited = 0;
        for (; waited < 8000; waited += 250) {
          const element = candidate();
          if (!element) {
            await delay(250);
            continue;
          }
          element.scrollIntoView({ block: 'center', inline: 'center' });
          element.click();
          await delay(1500);
          return { clicked: 1, waited };
        }
        return { clicked: 0, waited };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  return result.result.value || { clicked: 0, waited: 0 };
}

function serializeForRuntime(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/`/g, '\\u0060');
}

async function getDocumentHtml(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    const document = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 });
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'DOM.getOuterHTML',
      { nodeId: document.root.nodeId }
    );
    if (result.outerHTML) return { html: `<!doctype html>${result.outerHTML}`, method: 'DOM.getOuterHTML' };
  } catch (error) {
    // Fall through to Runtime.evaluate for pages where DOM is unavailable.
  }

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true
  });
  return { html: result.result.value || '', method: 'Runtime.evaluate' };
}

async function scrollForLazyResources(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const roots = () => {
          const all = [document];
          for (let index = 0; index < all.length; index += 1) {
            all[index].querySelectorAll('*').forEach((element) => {
              if (element.shadowRoot) all.push(element.shadowRoot);
            });
          }
          return all;
        };
        const containers = () => roots().flatMap((root) => [...root.querySelectorAll('*')]).filter((element) => {
          const style = getComputedStyle(element);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 40;
        }).slice(0, 40);
        let previousHeight = 0;
        for (let pass = 0; pass < 4; pass += 1) {
          const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          for (let y = 0; y < height; y += Math.max(400, window.innerHeight * 0.75)) {
            window.scrollTo(0, y);
            await delay(120);
          }
          for (const container of containers()) {
            const originalTop = container.scrollTop;
            for (let top = 0; top < container.scrollHeight; top += Math.max(250, container.clientHeight * 0.75)) {
              container.scrollTop = top;
              container.dispatchEvent(new Event('scroll', { bubbles: true }));
              await delay(80);
            }
            container.scrollTop = originalTop;
          }
          if (height === previousHeight) break;
          previousHeight = height;
          await delay(400);
        }
        window.scrollTo(0, 0);
        return { containers: containers().length };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  return result.result.value || { containers: 0 };
}

async function exploreHoverStates(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const roots = () => {
          const all = [document];
          for (let index = 0; index < all.length; index += 1) {
            all[index].querySelectorAll('*').forEach((element) => {
              if (element.shadowRoot) all.push(element.shadowRoot);
            });
          }
          return all;
        };
        const selector = 'a, button, [role="button"], [role="menuitem"], [data-hover], [data-tooltip], [data-state]';
        const candidates = roots().flatMap((root) => [...root.querySelectorAll(selector)]).slice(0, 150);
        let hovered = 0;
        for (const element of candidates) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
            element.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
          }
          hovered += 1;
          await delay(80);
        }
        return { hovered };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  return result.result.value || { hovered: 0 };
}

async function captureCanvasFallback(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (() => {
        const snapshots = [];
        for (const canvas of [...document.querySelectorAll('canvas')].slice(0, 4)) {
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          try {
            const scale = Math.min(1, 1600 / Math.max(canvas.width || rect.width, canvas.height || rect.height));
            const image = document.createElement('canvas');
            image.width = Math.max(1, Math.round((canvas.width || rect.width) * scale));
            image.height = Math.max(1, Math.round((canvas.height || rect.height) * scale));
            image.getContext('2d').drawImage(canvas, 0, 0, image.width, image.height);
            const dataUrl = image.toDataURL('image/png');
            if (dataUrl.length <= 2 * 1024 * 1024) snapshots.push({ width: image.width, height: image.height, dataUrl });
          } catch (error) {
            // Tainted or context-lost canvases cannot be serialized.
          }
        }
        return snapshots;
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });
  return result.result.value || [];
}

async function exploreInteractiveElements(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visited = new WeakSet();
        const dangerous = /\\b(?:add to cart|buy|cancel|checkout|confirm|delete|disconnect|logout|log out|order|pay|payment|purchase|remove|save|send|sign out|submit|subscribe|wallet)\\b/i;
        const dangerousRussian = /авторизац|выйти|вход|войти|корзин|купить|оплат|удал|отмен|подтверд|подпис|сохран|отправ|заказ/i;
        const externalService = /\\b(?:youtube|youtu\\.be|discord|telegram|twitter|x\\.com|github|instagram|linkedin|tiktok|facebook|spotify|twitch|google play|app store)\\b/i;
        const selector = 'summary, [role="tab"], [role="menuitem"], [aria-expanded], [data-toggle], button[aria-controls], button[data-state], button[data-toggle]';
        let clicked = 0;
        let skipped = 0;
        let rollbacks = 0;
        let stateEdges = 0;
        const states = new Set();

        const fingerprint = () => {
          const source = (document.body.innerHTML || '').slice(0, 50000);
          let hash = 5381;
          for (let index = 0; index < source.length; index += 1) hash = (hash * 33) ^ source.charCodeAt(index);
          return String(hash >>> 0);
        };

        const isVisible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const isSafe = (element) => {
          const linkTarget = element.closest('a[href]');
          const urlAttributes = ['href', 'data-href', 'data-url', 'formaction', 'action'];
          const label = [
            element.textContent,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('name'),
            element.getAttribute('value')
          ].filter(Boolean).join(' ');
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (element.disabled || element.closest('form') || linkTarget || type === 'submit' || type === 'reset') return false;
          if (element.getAttribute('aria-disabled') === 'true') return false;
          if (element.tagName === 'BUTTON' && !element.matches('[aria-controls], [data-state], [data-toggle]')) return false;
          if (element.closest('[target="_blank"]') || externalService.test(label)) return false;
          for (const source of [element]) {
            if (!source) continue;
            for (const attribute of urlAttributes) {
              const value = source.getAttribute(attribute);
              if (!value || value.startsWith('#')) continue;
              try {
                if (new URL(value, location.href).origin !== location.origin) return false;
              } catch (error) {
                return false;
              }
            }
          }
          return !dangerous.test(label) && !dangerousRussian.test(label);
        };

        const activeTab = (element) => {
          const tabList = element.closest('[role="tablist"]');
          return tabList && tabList.querySelector('[role="tab"][aria-selected="true"]');
        };

        const restore = async (element, previousTab, before) => {
          if (element.tagName === 'SUMMARY' || element.hasAttribute('aria-expanded')) {
            element.click();
            rollbacks += 1;
            await delay(180);
            return;
          }
          if (previousTab && previousTab !== element && document.contains(previousTab)) {
            previousTab.click();
            rollbacks += 1;
            await delay(180);
            return;
          }
          if (fingerprint() === before) rollbacks += 1;
        };

        const roots = () => {
          const all = [document];
          for (let index = 0; index < all.length; index += 1) {
            all[index].querySelectorAll('*').forEach((element) => {
              if (element.shadowRoot) all.push(element.shadowRoot);
            });
          }
          return all;
        };

        states.add(fingerprint());
        for (let round = 0; round < 8 && clicked < 120; round += 1) {
          const candidates = roots().flatMap((root) => [...root.querySelectorAll(selector)]);
          let clickedThisRound = 0;

          for (const element of candidates) {
            if (clicked >= 120) break;
            if (visited.has(element) || !isVisible(element)) continue;
            visited.add(element);
            if (!isSafe(element)) {
              skipped += 1;
              continue;
            }

            element.scrollIntoView({ block: 'center', inline: 'center' });
            await delay(120);
            try {
              const before = fingerprint();
              const previousTab = activeTab(element);
              element.click();
              clicked += 1;
              clickedThisRound += 1;
              await delay(350);
              const after = fingerprint();
              if (!states.has(after)) {
                states.add(after);
                stateEdges += 1;
              }
              await restore(element, previousTab, before);
            } catch (error) {
              skipped += 1;
            }
          }

          if (clickedThisRound === 0) break;
          await delay(500);
        }

        return { clicked, skipped, states: states.size, stateEdges, rollbacks };
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  return result.result.value || { clicked: 0, skipped: 0 };
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent.removeListener(handler);
      resolve();
    };
    const handler = (debuggeeId, method) => {
      if (debuggeeId.tabId === tabId && method === 'Page.loadEventFired') finish();
    };
    chrome.debugger.onEvent.addListener(handler);
    setTimeout(finish, 15000);
  });
}

async function waitForPendingBodies(timeout) {
  const started = Date.now();
  while ((pendingResponses.size > 0 || pendingBodyReads.size > 0 || streamedBodies.size > 0) && Date.now() - started < timeout) {
    await sleep(100);
  }
  if (pendingResponses.size > 0 || pendingBodyReads.size > 0 || streamedBodies.size > 0) {
    for (const request of pendingRequests.values()) {
      addReport('unreadableResponses', { url: request.url || 'Unknown response', reason: 'Timed out while reading response body' });
    }
    return false;
  }
  await sleep(500);
  return true;
}

async function startBuilder(tabId) {
  if (activeTabId !== tabId) {
    return { ok: false, error: 'Сначала начните запись через попап' };
  }

  try {
    await scrollForLazyResources(tabId);
    await waitForPendingBodies(10000);
    return {
      ok: true,
      html: (await getDocumentHtml(tabId)).html,
      bodies: Array.from(capturedBodies.values()),
      apiSnapshots: Array.from(apiSnapshots.values()),
      title: 'site'
    };
  } finally {
    if (activeTabId === tabId) await detach();
  }
}

async function detach() {
  const tabId = activeTabId;
  if (!tabId) return;
  detachingTabId = tabId;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    // The tab may already have been closed or detached by DevTools.
  } finally {
    detachingTabId = null;
  }
  resetCapture();
}

function resetCapture() {
  activeTabId = null;
  activePageOrigin = '';
  pendingResponses.clear();
  pendingBodyReads.clear();
  pendingRequests.clear();
  apiSnapshots.clear();
  streamedBodies.clear();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
