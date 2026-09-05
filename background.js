importScripts('capture-graph.js', 'capture-storage.js', 'privacy-guardrails.js', 'live-dom-state.js', 'rendered-page-crawler.js');

const CaptureGraph = OpenSaveCaptureGraph;
const CaptureStorage = OpenSaveCaptureStorage;
const PrivacyGuardrails = OpenSavePrivacyGuardrails;
const LiveDomState = OpenSaveLiveDomState;
const RenderedPageCrawler = OpenSaveRenderedPageCrawler;
const captureStorage = CaptureStorage.createCaptureStorage();
const captureStorageReady = captureStorage.initialize().then(() => captureStorage.recoverInterruptedMissions());
let activeTabId = null;
let activePageOrigin = '';
let activeOperation = null;
let nextOperationId = 1;
let detachingTabId = null;
const pendingResponses = new Map();
const pendingBodyReads = new Set();
const bodyReadQueue = [];
let activeBodyReads = 0;
const pendingRequests = new Map();
const streamedBodies = new Map();
let captureReport = createCaptureReport();
let reportUpdateScheduled = false;
let captureGraph = CaptureGraph.createCaptureGraph();
let activeMissionId = null;
const targetIdsBySession = new Map();
let missionPersistence = Promise.resolve();
let captureStorageFailure = null;
let queuedMissionSnapshot = null;
let missionSnapshotTimer = null;
const inFlightRequestKeys = new Set();
let lastNetworkActivityAt = 0;
let lastNavigationKind = 'document';
let isolatedCaptureTabId = null;
let crawlBytesCaptured = 0;

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
const MAX_CONCURRENT_BODY_READS = 4;
const ENABLE_EXPERIMENTAL_STREAMING = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'cancelCapture') {
    cancelActiveCapture(msg.missionId, msg.reason).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.action === 'deleteMission') {
    captureStorageReady.then(() => captureStorage.cleanupMission(msg.missionId)).then((result) => sendResponse({ ok: true, ...result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
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
    if (detachingTabId !== debuggeeId.tabId) interruptActiveMission('debugger-detached');
    else resetCapture();
    if (detachingTabId !== debuggeeId.tabId) activeOperation = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeTabId) return;
  interruptActiveMission('source-tab-closed');
  activeOperation = null;
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

  if (method === 'Page.frameNavigated') lastNavigationKind = 'document';
  if (method === 'Page.navigatedWithinDocument') lastNavigationKind = 'history';

  if (method === 'Network.responseReceived') {
    const { response, requestId } = params;
    let request = pendingRequests.get(key);
    if (!request) request = registerRequest(debuggeeId, key, requestId, { request: { url: response.url, method: 'GET', headers: {} }, timestamp: params.timestamp, frameId: params.frameId });
    const graphResponse = registerResponse(debuggeeId, request, response, params);
    request.responseId = graphResponse.id;
    if (params.type === 'Fetch' || params.type === 'XHR') {
      CaptureGraph.addApiExchange(captureGraph, {
        missionId: activeMissionId,
        requestId: request.graphRequestId,
        responseId: graphResponse.id,
        resourceType: params.type
      });
    }
    if (response.status >= 400) addReport('httpErrors', { url: response.url, status: response.status, mimeType: response.mimeType || '' }, [graphResponse.id], CaptureGraph.PROVENANCE.OBSERVED);
    if (shouldCapture(response, params.type)) {
      captureReport.eligibleResponses += 1;
      const capture = {
        response,
        request,
        graphResponseId: graphResponse.id,
        resourceType: params.type,
        debuggeeId,
        operationId: activeOperation && activeOperation.id
      };
      pendingResponses.set(key, capture);
      if (ENABLE_EXPERIMENTAL_STREAMING && isDeepCapture()) startNetworkStream(key, requestId, capture);
    } else {
      graphResponse.bodyState = 'not-captured';
      graphResponse.failureReason = 'Unsupported response type';
      addReport('skippedResponses', { url: response.url, mimeType: response.mimeType || '', reason: 'Unsupported response type' }, [graphResponse.id], CaptureGraph.PROVENANCE.OBSERVED);
    }
    queueMissionSnapshot();
    return;
  }

  if (method === 'Network.dataReceived') {
    if (trackForRouteIdle(debuggeeId)) lastNetworkActivityAt = Date.now();
    const stream = streamedBodies.get(key);
    if (stream && params.data) {
      stream.chunks.push(params.data);
      stream.bytes += params.dataLength || 0;
      if (stream.bytes > MAX_STREAM_BODY_BYTES) stream.overflow = true;
    }
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    if (trackForRouteIdle(debuggeeId)) {
      inFlightRequestKeys.add(key);
      lastNetworkActivityAt = Date.now();
    }
    const previous = pendingRequests.get(key);
    let predecessorRequestId = null;
    let redirectResponse = null;
    if (params.redirectResponse && previous) {
      redirectResponse = registerResponse(debuggeeId, previous, params.redirectResponse, {
        ...params,
        type: previous.resourceType || 'Document',
        timestamp: params.timestamp
      });
      redirectResponse.bodyState = 'not-applicable';
      previous.responseId = redirectResponse.id;
      predecessorRequestId = previous.graphRequestId;
      if (previous.resourceType === 'Fetch' || previous.resourceType === 'XHR') {
        CaptureGraph.addApiExchange(captureGraph, {
          missionId: activeMissionId,
          requestId: previous.graphRequestId,
          responseId: redirectResponse.id,
          resourceType: previous.resourceType
        });
      }
    }
    const request = registerRequest(debuggeeId, key, params.requestId, params, predecessorRequestId);
    if (predecessorRequestId) {
      const predecessor = captureGraph.requests.find((item) => item.id === predecessorRequestId);
      if (predecessor) predecessor.redirectSuccessorRequestId = request.graphRequestId;
      redirectResponse.redirectSuccessorRequestId = request.graphRequestId;
    }
    queueMissionSnapshot();
    return;
  }

  if (method === 'Network.loadingFinished') {
    if (trackForRouteIdle(debuggeeId)) {
      inFlightRequestKeys.delete(key);
      lastNetworkActivityAt = Date.now();
    }
    const capture = pendingResponses.get(key);
    const request = pendingRequests.get(key);
    const response = request && captureGraph.responses.find((item) => item.id === request.responseId);
    if (response) {
      response.encodedSize = params.encodedDataLength ?? response.encodedSize;
      if (response.bodyState === 'pending' && !capture) response.bodyState = 'not-captured';
    }
    if (!capture) {
      pendingRequests.delete(key);
      queueMissionSnapshot();
      return;
    }
    pendingResponses.delete(key);
    const stream = streamedBodies.get(key);
    if (stream && !stream.overflow && !stream.starting) {
      streamedBodies.delete(key);
      pendingBodyReads.add(key);
      finalizeNetworkStream(key, capture, stream).finally(() => {
        pendingBodyReads.delete(key);
        pendingRequests.delete(key);
        queueMissionSnapshot();
      });
    } else {
      streamedBodies.delete(key);
      enqueueBodyRead(key, params.requestId, capture);
    }
    queueMissionSnapshot();
    return;
  }

  if (method === 'Network.loadingFailed') {
    if (trackForRouteIdle(debuggeeId)) {
      inFlightRequestKeys.delete(key);
      lastNetworkActivityAt = Date.now();
    }
    const request = pendingRequests.get(key);
    if (request && request.responseId) CaptureGraph.markResponseBodyUnavailable(captureGraph, request.responseId, params.errorText || 'Network loading failed');
    addReport('networkFailures', { url: request && request.url, error: params.errorText || 'Network loading failed', type: params.type || '' }, [request && request.graphRequestId, request && request.responseId].filter(Boolean), CaptureGraph.PROVENANCE.OBSERVED);
    pendingResponses.delete(key);
    streamedBodies.delete(key);
    pendingRequests.delete(key);
    queueMissionSnapshot();
  }
});

function createCaptureReport() {
  return {
    networkFailures: [],
    httpErrors: [],
    unreadableResponses: [],
    quotaFailures: [],
    skippedResponses: [],
    childTargets: [],
    cacheEntries: 0,
    cacheResources: 0,
    streamedResponses: 0,
    streamedBytes: 0,
    eligibleResponses: 0,
    capturedResponseBodies: 0,
    retainedBodies: 0,
    apiSnapshotCount: 0,
    peakBodyBytesHeld: 0,
    peakBodyBytesMeasurement: 'largest-decoded-body-estimate',
    durableStorage: { backend: 'indexeddb', persistedBodies: 0, persistedBytes: 0, duplicateBodies: 0 },
    liveDomState: null
  };
}

function pendingWorkSnapshot() {
  return [
    ...[...pendingResponses.entries()].map(([key, capture]) => ({ key, kind: 'waiting-for-finish', responseId: capture.graphResponseId })),
    ...[...pendingBodyReads].map((key) => ({ key, kind: 'reading-body' })),
    ...[...streamedBodies.keys()].map((key) => ({ key, kind: 'streaming-body' }))
  ];
}

async function persistMissionSnapshot(state, extra = {}) {
  const missionId = activeMissionId;
  if (!missionId) return null;
  await captureStorageReady;
  const mission = captureGraph.missions.find((item) => item.id === missionId);
  if (state && mission) mission.state = state;
  const snapshot = PrivacyGuardrails.sanitizeCaptureGraph(captureGraph).graph;
  if (missionSnapshotTimer) clearTimeout(missionSnapshotTimer);
  missionSnapshotTimer = null;
  queuedMissionSnapshot = null;
  missionPersistence = missionPersistence.catch(() => {}).then(() => captureStorage.saveMission(missionId, {
    state: state || (mission && mission.state) || 'capturing',
    sourceTabId: activeTabId,
    graph: snapshot,
    pendingWork: pendingWorkSnapshot(),
    cancellation: {
      requested: Boolean(activeOperation && activeOperation.cancelRequested),
      reason: activeOperation && activeOperation.cancelReason || null,
      requestedAt: activeOperation && activeOperation.cancelRequestedAt || null
    },
    ...PrivacyGuardrails.sanitizeMetadata(extra, 'mission.extra')
  }));
  return missionPersistence;
}

function queueMissionSnapshot() {
  const missionId = activeMissionId;
  if (!missionId) return;
  queuedMissionSnapshot = { missionId, graph: captureGraph, sourceTabId: activeTabId };
  if (missionSnapshotTimer) return;
  missionSnapshotTimer = setTimeout(flushQueuedMissionSnapshot, 100);
}

function flushQueuedMissionSnapshot() {
  missionSnapshotTimer = null;
  const queued = queuedMissionSnapshot;
  queuedMissionSnapshot = null;
  if (!queued) return;
  const graph = PrivacyGuardrails.sanitizeCaptureGraph(queued.graph).graph;
  const mission = graph.missions.find((item) => item.id === queued.missionId);
  const pendingWork = queued.missionId === activeMissionId ? pendingWorkSnapshot() : [];
  missionPersistence = missionPersistence.catch(() => {}).then(() => captureStorage.saveMission(queued.missionId, {
    state: mission && mission.state || 'capturing',
    sourceTabId: queued.sourceTabId,
    graph,
    pendingWork
  })).catch(() => {});
}

async function interruptActiveMission(reason) {
  const missionId = activeMissionId;
  const graph = captureGraph;
  if (!missionId) {
    resetCapture();
    return;
  }
  graph.captureEvidenceClosed = true;
  const mission = graph.missions.find((item) => item.id === missionId);
  if (mission) mission.state = 'interrupted';
  resetCapture();
  try {
    await captureStorageReady;
    await captureStorage.saveMission(missionId, {
      state: 'interrupted',
      graph: PrivacyGuardrails.sanitizeCaptureGraph(graph).graph,
      pendingWork: [],
      recovery: { recoverable: true, interruptedAt: Date.now(), reason }
    });
    await captureStorage.cleanupTemporaryBodies(missionId);
  } catch (error) {
    // Recovery is retried by recoverInterruptedMissions on the next extension start.
  }
}

async function cancelActiveCapture(missionId, reason = 'user-cancelled') {
  if (activeOperation && activeOperation.cancelRequested) return { ok: true, missionId: activeMissionId };
  if (activeOperation && !activeMissionId) {
    activeOperation.cancelRequested = true;
    activeOperation.cancelReason = reason;
    activeOperation.cancelRequestedAt = Date.now();
    return { ok: true, missionId: null };
  }
  if (!activeMissionId || (missionId && missionId !== activeMissionId)) return { ok: false, error: 'Активная миссия захвата не найдена' };
  const currentMissionId = activeMissionId;
  if (activeOperation) {
    activeOperation.cancelRequested = true;
    activeOperation.cancelReason = reason;
    activeOperation.cancelRequestedAt = Date.now();
  }
  captureGraph.captureEvidenceClosed = true;
  await persistMissionSnapshot('cancelling');
  if (activeTabId) await detach();
  await captureStorage.cancelMission(currentMissionId, reason);
  return { ok: true, missionId: currentMissionId };
}

function beginOperation(tabId, mode) {
  if (activeOperation) return null;
  activeOperation = { id: nextOperationId, tabId, mode, scenario: mode === 'recording' ? [] : undefined, cancelRequested: false };
  nextOperationId += 1;
  return activeOperation;
}

function finishOperation(operation) {
  if (activeOperation && activeOperation.id === operation.id) activeOperation = null;
}

function isCurrentOperation(operationId) {
  return Boolean(activeOperation && activeOperation.id === operationId);
}

function addReport(type, item, evidenceRefs = [], provenance = CaptureGraph.PROVENANCE.INFERRED) {
  const collection = captureReport[type];
  let diagnostic = null;
  if (activeMissionId) {
    diagnostic = CaptureGraph.addDiagnostic(captureGraph, {
      missionId: activeMissionId,
      code: type,
      severity: type === 'skippedResponses' ? 'info' : 'warning',
      phase: 'capture',
      message: item.reason || item.error || `${type}: ${item.url || 'unknown'}`,
      evidenceRefs,
      provenance
    });
  }
  if (!Array.isArray(collection)) return;
  if (collection.length >= 100) {
    if (diagnostic) diagnostic.truncated = true;
    return;
  }
  collection.push(item);
  scheduleReportUpdate();
}

function scheduleReportUpdate() {
  if (reportUpdateScheduled) return;
  reportUpdateScheduled = true;
  setTimeout(() => {
    reportUpdateScheduled = false;
    chrome.runtime.sendMessage({ action: 'captureReport', report: PrivacyGuardrails.sanitizeMetadata(captureReport, 'captureReport') }).catch(() => {});
  }, 250);
}

function reportCaptureProgress(operation, stage, status, percent, logMessage = '') {
  if (!operation || !isCurrentOperation(operation.id) || operation.cancelRequested) return;
  chrome.runtime.sendMessage({ action: 'captureProgress', stage, status, percent, logMessage }).catch(() => {});
}

function requestKey(debuggeeId, requestId) {
  return `${debuggeeId.sessionId || 'root'}:${requestId || ''}`;
}

function trackForRouteIdle(debuggeeId) {
  return !debuggeeId.sessionId;
}

function targetIdFor(debuggeeId) {
  return targetIdsBySession.get(debuggeeId.sessionId || 'root') || null;
}

function registerRequest(debuggeeId, key, requestId, params, redirectPredecessorRequestId = null) {
  const source = params.request || {};
  const input = {
    missionId: activeMissionId,
    targetId: targetIdFor(debuggeeId),
    frameId: params.frameId || null,
    cdpRequestId: requestId,
    method: source.method || 'GET',
    originalUrl: source.url || '',
    headers: source.headers || {},
    timestamp: params.timestamp ?? Date.now(),
    wallTime: params.wallTime ?? null,
    initiator: params.initiator || null,
    redirectPredecessorRequestId
  };
  if (Object.prototype.hasOwnProperty.call(source, 'postData')) input.requestBody = source.postData;
  const graphRequest = CaptureGraph.addRequest(captureGraph, input);
  const request = {
    url: source.url || '',
    method: source.method || 'GET',
    postData: source.postData || '',
    resourceType: params.type || '',
    graphRequestId: graphRequest.id,
    responseId: null
  };
  pendingRequests.set(key, request);
  return request;
}

function registerResponse(debuggeeId, request, response, params) {
  return CaptureGraph.addResponse(captureGraph, {
    missionId: activeMissionId,
    requestId: request && request.graphRequestId,
    targetId: targetIdFor(debuggeeId),
    frameId: params.frameId || null,
    originalUrl: response.url || (request && request.url) || '',
    status: response.status,
    statusText: response.statusText || '',
    headers: response.headers || {},
    mimeType: response.mimeType || '',
    protocol: response.protocol || '',
    resourceType: params.type || '',
    timestamp: params.timestamp ?? Date.now(),
    responseTime: response.responseTime ?? null,
    fromDiskCache: response.fromDiskCache,
    fromServiceWorker: response.fromServiceWorker,
    encodedSize: response.encodedDataLength ?? null
  });
}

function shouldCapture(response, resourceType) {
  const url = response.url || '';
  if (!/^https?:/i.test(url)) return false;
  try {
    if (resourceType === 'Document' && activePageOrigin && new URL(url).origin !== activePageOrigin) return false;
  } catch (error) {
    return false;
  }
  const mimeType = (response.mimeType || '').toLowerCase();
  return KEEP_TYPES.some((type) => mimeType.startsWith(type)) || mimeType.includes('json') || STATIC_EXTENSIONS.test(url);
}

async function captureResponseBody(key, requestId, capture) {
  if (!activeTabId || captureGraph.captureEvidenceClosed || !isCurrentOperation(capture.operationId)) return;

  try {
    const body = await chrome.debugger.sendCommand(capture.debuggeeId, 'Network.getResponseBody', { requestId });
    if (!activeTabId || !body || captureGraph.captureEvidenceClosed || !isCurrentOperation(capture.operationId)) return;

    await saveCapturedBody(capture, body.body, body.base64Encoded);
  } catch (error) {
    // Responses are evicted by Chrome for very large or cancelled requests.
    if (error && error.code === 'quota-exhausted') {
      captureStorageFailure = error;
      const mission = captureGraph.missions.find((item) => item.id === activeMissionId);
      if (mission) mission.state = 'partial';
    }
    CaptureGraph.markResponseBodyUnavailable(captureGraph, capture.graphResponseId, error.message);
    addReport(error && error.code === 'quota-exhausted' ? 'quotaFailures' : 'unreadableResponses', { url: capture.response.url, reason: error.message }, [capture.graphResponseId], CaptureGraph.PROVENANCE.OBSERVED);
  } finally {
    pendingBodyReads.delete(key);
    pendingRequests.delete(key);
    if (captureStorageFailure) {
      await persistMissionSnapshot('partial', { recovery: { recoverable: true, interruptedAt: Date.now(), reason: 'quota-exhausted' } });
    } else {
      queueMissionSnapshot();
    }
  }
}

function enqueueBodyRead(key, requestId, capture) {
  pendingBodyReads.add(key);
  bodyReadQueue.push({ key, requestId, capture });
  drainBodyReadQueue();
}

function drainBodyReadQueue() {
  while (activeBodyReads < MAX_CONCURRENT_BODY_READS && bodyReadQueue.length) {
    const job = bodyReadQueue.shift();
    activeBodyReads += 1;
    captureResponseBody(job.key, job.requestId, job.capture).finally(() => {
      activeBodyReads -= 1;
      drainBodyReadQueue();
    });
  }
}

async function saveCapturedBody(capture, body, base64Encoded) {
  if (captureGraph.captureEvidenceClosed) return;
  const estimatedBytes = body instanceof Blob
    ? body.size
    : base64Encoded && typeof body === 'string'
      ? Math.floor((body.length * 3) / 4)
      : new TextEncoder().encode(String(body || '')).byteLength;
  if (isDeepCapture() && crawlBytesCaptured + estimatedBytes > RenderedPageCrawler.DEFAULT_POLICY.maxBytes) {
    if (activeOperation) activeOperation.crawlStopReason = 'byte-budget';
    const error = new Error('Rendered crawl byte budget reached');
    error.code = 'byte-budget';
    throw error;
  }
  captureReport.capturedResponseBodies += 1;
  const graphBody = await CaptureGraph.addBody(captureGraph, {
    missionId: activeMissionId,
    responseId: capture.graphResponseId,
    body,
    base64Encoded,
    mimeType: capture.response.mimeType || '',
    provenance: CaptureGraph.PROVENANCE.OBSERVED,
    evidenceRefs: [capture.request && capture.request.graphRequestId].filter(Boolean)
  }, { bodyStore: captureStorage });
  captureReport.durableStorage.persistedBodies = captureGraph.bodies.filter((item) => item.storageKey).length;
  captureReport.durableStorage.persistedBytes = captureGraph.bodies.reduce((total, item) => total + (item.storageKey ? item.size : 0), 0);
  captureReport.peakBodyBytesHeld = Math.max(captureReport.peakBodyBytesHeld, graphBody.size);
  if (isDeepCapture()) crawlBytesCaptured += graphBody.size;
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

async function finalizeNetworkStream(key, capture, stream) {
  if (!isCurrentOperation(capture.operationId)) return;
  try {
    const blob = new Blob(stream.chunks.flatMap(base64ToByteChunks), { type: capture.response.mimeType || 'application/octet-stream' });
    await saveCapturedBody(capture, blob, false);
    captureReport.streamedResponses += 1;
    captureReport.streamedBytes += blob.size;
  } catch (error) {
    CaptureGraph.markResponseBodyUnavailable(captureGraph, capture.graphResponseId, error.message);
    addReport('unreadableResponses', { url: capture.response.url, reason: `Network stream: ${error.message}` }, [capture.graphResponseId], CaptureGraph.PROVENANCE.OBSERVED);
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

async function attach(tabId, source = null) {
  if (activeTabId) await detach();

  await captureStorageReady;
  activeTabId = tabId;
  pendingResponses.clear();
  pendingBodyReads.clear();
  bodyReadQueue.length = 0;
  pendingRequests.clear();
  streamedBodies.clear();
  captureReport = createCaptureReport();
  captureStorageFailure = null;
  captureGraph = CaptureGraph.createCaptureGraph();
  activeMissionId = null;
  targetIdsBySession.clear();
  inFlightRequestKeys.clear();
  lastNetworkActivityAt = Date.now();
  lastNavigationKind = 'document';

  try {
    const tab = await chrome.tabs.get(tabId);
    const missionSourceTabId = source && source.tabId != null ? source.tabId : tabId;
    const missionSourceUrl = source && source.url ? source.url : tab.url;
    const mission = CaptureGraph.addMission(captureGraph, {
      id: `capture-${crypto.randomUUID()}`,
      missionType: activeOperation ? activeOperation.mode : 'capture',
      captureMode: activeOperation && activeOperation.captureMode || 'quick',
      sourceTabId: missionSourceTabId,
      sourceUrl: missionSourceUrl,
      startedAt: Date.now()
    });
    activeMissionId = mission.id;
    const sanitizedMissionSourceUrl = PrivacyGuardrails.sanitizeUrl(missionSourceUrl, 'mission.sourceUrl').url;
    await captureStorage.createMission({
      id: mission.id,
      state: 'capturing',
      sourceTabId: missionSourceTabId,
      sourceUrl: sanitizedMissionSourceUrl,
      captureMode: mission.captureMode,
      graph: PrivacyGuardrails.sanitizeCaptureGraph(captureGraph).graph
    });
    const rootTarget = CaptureGraph.addTarget(captureGraph, {
      missionId: activeMissionId,
      targetType: 'page',
      cdpSessionId: 'root',
      originalUrl: missionSourceUrl
    });
    targetIdsBySession.set('root', rootTarget.id);
    activePageOrigin = new URL(missionSourceUrl).origin;
    await chrome.debugger.attach({ tabId }, '1.3');
    await enableNetworkCapture({ tabId }, true);
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });
    await persistMissionSnapshot('capturing');
    return { ok: true };
  } catch (error) {
    const failedMissionId = activeMissionId;
    resetCapture();
    if (failedMissionId) await captureStorage.cleanupMission(failedMissionId).catch(() => {});
    return { ok: false, error: error.message };
  }
}

function syncPlannerRoutes(planner) {
  const existing = new Map(captureGraph.routes.map((route) => [route.id, route]));
  for (const planned of planner.routes) {
    const input = {
      ...planned,
      missionId: activeMissionId,
      provenance: CaptureGraph.PROVENANCE.DERIVED,
      evidenceRefs: []
    };
    if (existing.has(planned.id)) CaptureGraph.updateRoute(captureGraph, planned.id, input);
    else CaptureGraph.addRoute(captureGraph, input);
  }
}

async function installRouteIdleObserver(tabId) {
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      if (window.__openSaveRouteObserver) window.__openSaveRouteObserver.disconnect();
      window.__openSaveLastMutationAt = Date.now();
      window.__openSaveRouteObserver = new MutationObserver(() => { window.__openSaveLastMutationAt = Date.now(); });
      window.__openSaveRouteObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      return true;
    })()`,
    returnByValue: true
  });
}

async function waitForRouteIdle(tabId, operation, policy) {
  const startedAt = Date.now();
  let networkIdle = false;
  let domIdle = false;
  while (Date.now() - startedAt < policy.maxRouteDurationMs) {
    if (!isCurrentOperation(operation.id) || operation.cancelRequested) return { result: 'cancelled', networkIdle, domIdle };
    networkIdle = inFlightRequestKeys.size === 0 && Date.now() - lastNetworkActivityAt >= policy.networkIdleMs;
    try {
      const mutation = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'Date.now() - (window.__openSaveLastMutationAt || Date.now())',
        returnByValue: true
      });
      domIdle = Number(mutation.result && mutation.result.value || 0) >= policy.domIdleMs;
    } catch (error) {
      domIdle = false;
    }
    if (networkIdle && domIdle) return { result: 'settled', networkIdle, domIdle };
    await sleep(100);
  }
  return { result: !networkIdle ? 'network-idle-timeout' : 'dom-idle-timeout', networkIdle, domIdle };
}

async function discoverRenderedRoutes(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => ({
      url: location.href,
      canonicalUrl: document.querySelector('link[rel~="canonical"][href]')?.href || null,
      anchors: [...document.querySelectorAll('a[href]')].map((anchor) => ({
        url: anchor.getAttribute('href') || '',
        absoluteUrl: anchor.href || '',
        target: anchor.getAttribute('target') || '',
        download: anchor.hasAttribute('download')
      }))
    }))()`,
    returnByValue: true
  });
  return result.result && result.result.value || { url: '', canonicalUrl: null, anchors: [] };
}

async function navigateRenderedRoute(tabId, route, operation, policy) {
  lastNavigationKind = route.transitionKind;
  if (route.discoveredFromUrl) {
    const parentNavigation = waitForRouteNavigation(tabId, policy.maxRouteDurationMs);
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: route.discoveredFromUrl });
    await parentNavigation;
    await installRouteIdleObserver(tabId);
    await waitForRouteIdle(tabId, operation, policy);
  }
  const navigation = waitForRouteNavigation(tabId, policy.maxRouteDurationMs);
  let clicked = false;
  if (route.discoveredFromUrl) {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => {
        const target = ${serializeForRuntime(route.routeUrl)};
        const anchor = [...document.querySelectorAll('a[href]')].find((item) => item.href === target && !item.hasAttribute('download') && (!item.target || item.target === '_self'));
        if (!anchor) return false;
        anchor.click();
        return true;
      })()`,
      returnByValue: true,
      userGesture: true
    });
    clicked = Boolean(result.result && result.result.value);
  }
  if (!clicked) await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: route.routeUrl });
  const loadResult = await navigation;
  if (!isCurrentOperation(operation.id) || operation.cancelRequested) return { result: 'cancelled', loadResult };
  await installRouteIdleObserver(tabId);
  const idle = await waitForRouteIdle(tabId, operation, policy);
  return { ...idle, loadResult };
}

function waitForRouteNavigation(tabId, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent.removeListener(handler);
      resolve(result);
    };
    const handler = (debuggeeId, method) => {
      if (debuggeeId.tabId !== tabId) return;
      if (method === 'Page.navigatedWithinDocument') finish('history');
      if (method === 'Page.frameNavigated' || method === 'Page.loadEventFired') finish('document');
    };
    chrome.debugger.onEvent.addListener(handler);
    setTimeout(() => finish('navigation-timeout'), timeout);
  });
}

async function captureRenderedRoute(tabId, route, idle) {
  const tab = await chrome.tabs.get(tabId);
  const finalUrl = tab.url;
  const discovered = await discoverRenderedRoutes(tabId);
  const responseStart = route.responseStart || 0;
  const bodyStart = route.bodyStart || 0;
  const routeResponses = captureGraph.responses.slice(responseStart);
  const routeBodies = captureGraph.bodies.slice(bodyStart);
  const document = await captureLiveDomState(tabId);
  const documentBytes = new TextEncoder().encode(document.html).byteLength;
  if (crawlBytesCaptured + documentBytes > RenderedPageCrawler.DEFAULT_POLICY.maxBytes) {
    if (activeOperation) activeOperation.crawlStopReason = 'byte-budget';
    const error = new Error('Rendered crawl byte budget reached before DOM checkpoint');
    error.code = 'byte-budget';
    throw error;
  }
  const target = CaptureGraph.addTarget(captureGraph, {
    missionId: activeMissionId,
    targetType: 'rendered-route',
    cdpSessionId: 'root',
    originalUrl: finalUrl,
    parentTargetId: targetIdsBySession.get('root') || null,
    provenance: CaptureGraph.PROVENANCE.DERIVED
  });
  const artifact = await CaptureGraph.addDerivedArtifact(captureGraph, {
    missionId: activeMissionId,
    artifactType: 'rendered-route-html',
    body: document.html,
    mimeType: 'text/html',
    originalUrl: finalUrl,
    inputEvidenceIds: routeResponses.map((response) => response.id),
    transform: document.method,
    transformVersion: 1
  }, { bodyStore: captureStorage });
  crawlBytesCaptured += documentBytes;
  const graphDocument = CaptureGraph.addDocument(captureGraph, {
    missionId: activeMissionId,
    targetId: target.id,
    originalUrl: finalUrl,
    documentKind: route.transitionKind === 'history' ? 'rendered-history-state' : 'rendered-page',
    bodyId: artifact.bodyId,
    routeId: route.id,
    snapshotVersion: document.version,
    stateSummary: document.summary,
    provenance: CaptureGraph.PROVENANCE.DERIVED,
    evidenceRefs: [artifact.id]
  });
  for (const diagnostic of document.diagnostics || []) CaptureGraph.addDiagnostic(captureGraph, {
    missionId: activeMissionId,
    code: diagnostic.code,
    severity: 'warning',
    phase: 'rendered-route',
    message: diagnostic.reason,
    occurrenceCount: diagnostic.count,
    evidenceRefs: [graphDocument.id, artifact.id],
    provenance: CaptureGraph.PROVENANCE.DERIVED
  });
  return {
    finalUrl,
    canonicalUrl: discovered.canonicalUrl,
    documentId: graphDocument.id,
    targetId: target.id,
    idleResult: idle.result,
    fidelity: 'rendered',
    capturedBytes: routeBodies.reduce((total, body) => total + body.size, 0),
    discovered,
    document
  };
}

async function runRenderedPageCrawler(tabId, seedUrl, operation) {
  const planner = RenderedPageCrawler.createRoutePlanner(seedUrl, {
    isCancelled: () => !isCurrentOperation(operation.id) || operation.cancelRequested
  });
  while (true) {
    syncPlannerRoutes(planner);
    const route = planner.takeNext();
    if (!route) break;
    route.responseStart = captureGraph.responses.length;
    route.bodyStart = captureGraph.bodies.length;
    try {
      const budget = planner.budgetSnapshot();
      const routeNumber = captureGraph.routes.filter((item) => item.state === 'captured').length + 1;
      reportCaptureProgress(
        operation,
        'Глубокий обход сайта',
        `Открываю страницу ${routeNumber} из максимум ${planner.policy.maxPages}...`,
        Math.min(45, 8 + Math.round((budget.elapsedMs / planner.policy.maxDurationMs) * 37)),
        `Deep: страница ${routeNumber}: ${route.routeUrl}`
      );
      const routePolicy = { ...planner.policy, maxRouteDurationMs: Math.max(1, Math.min(planner.policy.maxRouteDurationMs, planner.policy.maxDurationMs - budget.elapsedMs)) };
      let idle = await navigateRenderedRoute(tabId, route, operation, routePolicy);
      if (idle.result === 'cancelled') {
        planner.fail(route, 'cancelled', { idleResult: idle.result });
        break;
      }
      if (!planner.setTransition(route, lastNavigationKind)) continue;
      const firstScroll = await boundedDebuggerStage('Rendered route scrolling', tabId, () => scrollForLazyResources(tabId, remainingCrawlerBudget(planner, 12000)), remainingCrawlerBudget(planner, 12000), { containers: 0 });
      if (route.discoveryKind === 'seed') {
        reportCaptureProgress(operation, 'Глубокий обход сайта', 'Исследую состояния первой страницы...', 34, 'Deep: исследую lazy-load, hover и безопасные UI-состояния');
        const startActivation = await boundedDebuggerStage('Start overlay activation', tabId, () => activateStartOverlay(tabId, remainingCrawlerBudget(planner, 8000)), remainingCrawlerBudget(planner, 8000), { clicked: 0, waited: 0 });
        const replayedScenario = await boundedDebuggerStage('Scenario replay', tabId, () => replayScenario(tabId, operation.captureScenario || [], remainingCrawlerBudget(planner, 12000)), remainingCrawlerBudget(planner, 12000), { total: 0, replayed: 0 });
        const hover = await boundedDebuggerStage('Hover exploration', tabId, () => exploreHoverStates(tabId, remainingCrawlerBudget(planner, 10000)), remainingCrawlerBudget(planner, 10000), { hovered: 0 });
        const interaction = await boundedDebuggerStage('Interactive exploration', tabId, () => exploreInteractiveElements(tabId, remainingCrawlerBudget(planner, 20000)), remainingCrawlerBudget(planner, 20000), { clicked: 0, skipped: 0, states: 0 });
        const finalScroll = await boundedDebuggerStage('Final scrolling', tabId, () => scrollForLazyResources(tabId, remainingCrawlerBudget(planner, 8000)), remainingCrawlerBudget(planner, 8000), { containers: 0 });
        operation.crawlInteraction = { ...interaction, hover, replayedScenario, startActivation, scrollContainers: firstScroll.containers + finalScroll.containers };
      }
      idle = await waitForRouteIdle(tabId, operation, routePolicy);
      const captured = await captureRenderedRoute(tabId, route, idle);
      planner.complete(route, captured);
      if (route.discoveryKind === 'seed') operation.rootDocument = captured.document;
      for (const anchor of captured.discovered.anchors) planner.discover({
        url: anchor.absoluteUrl || anchor.url,
        baseUrl: captured.finalUrl,
        elementKind: 'anchor',
        target: anchor.target,
        download: anchor.download,
        discoveredFromRouteId: route.id,
        discoveredFromUrl: captured.finalUrl,
        discoveryKind: 'anchor'
      });
      if (operation.crawlStopReason === 'byte-budget') planner.addBytes(planner.policy.maxBytes);
      await persistMissionSnapshot('crawling', { crawlBudget: planner.budgetSnapshot() });
    } catch (error) {
      planner.fail(route, operation.cancelRequested ? 'cancelled' : 'rendered-navigation-failed');
      CaptureGraph.addDiagnostic(captureGraph, {
        missionId: activeMissionId,
        code: 'rendered-route-failed',
        severity: 'warning',
        phase: 'rendered-crawl',
        message: error.message,
        evidenceRefs: [route.id],
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
      if (operation.cancelRequested) break;
    }
  }
  syncPlannerRoutes(planner);
  const capturedRoutes = planner.routes.filter((route) => route.state === 'captured').length;
  reportCaptureProgress(operation, 'Глубокий обход сайта', `Обход завершён: сохранено страниц ${capturedRoutes}.`, 48, `Deep: обход завершён, страниц: ${capturedRoutes}`);
  return planner;
}

function remainingCrawlerBudget(planner, stageLimitMs) {
  const remaining = planner.policy.maxDurationMs - planner.budgetSnapshot().elapsedMs;
  return Math.max(0, Math.min(stageLimitMs, remaining));
}

async function boundedDebuggerStage(name, tabId, action, timeoutMs, fallback) {
  if (timeoutMs <= 0) return fallback;
  let timeoutId;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(`${name} exceeded its ${timeoutMs} ms budget`);
          error.code = 'stage-timeout';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (error && error.code === 'stage-timeout') await chrome.debugger.sendCommand({ tabId }, 'Runtime.terminateExecution').catch(() => {});
    addReport('unreadableResponses', { url: name, reason: error.message });
    return fallback;
  } finally {
    clearTimeout(timeoutId);
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
  const target = CaptureGraph.addTarget(captureGraph, {
    missionId: activeMissionId,
    targetType: targetInfo.type || 'worker',
    cdpTargetId: targetInfo.targetId || null,
    cdpSessionId: debuggeeId.sessionId || null,
    originalUrl: targetInfo.url || '',
    parentTargetId: targetIdsBySession.get('root') || null
  });
  targetIdsBySession.set(debuggeeId.sessionId, target.id);
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
        const graphRequest = CaptureGraph.addRequest(captureGraph, {
          missionId: activeMissionId,
          targetId: targetIdsBySession.get('root') || null,
          method: entry.requestMethod || 'GET',
          originalUrl: entry.requestURL,
          headers: entry.requestHeaders || [],
          timestamp: Date.now()
        });
        const contentType = (entry.responseHeaders || []).find((header) => header.name.toLowerCase() === 'content-type');
        const graphResponse = CaptureGraph.addResponse(captureGraph, {
          missionId: activeMissionId,
          targetId: targetIdsBySession.get('root') || null,
          requestId: graphRequest.id,
          originalUrl: entry.requestURL,
          status: entry.responseStatus,
          statusText: entry.responseStatusText || '',
          headers: entry.responseHeaders || [],
          mimeType: contentType ? contentType.value : '',
          resourceType: 'CacheStorage',
          timestamp: Date.now(),
          evidenceRefs: [graphRequest.id]
        });
        await CaptureGraph.addBody(captureGraph, {
          missionId: activeMissionId,
          responseId: graphResponse.id,
          body: cached.response.body,
          base64Encoded: true,
          mimeType: graphResponse.mimeType,
          provenance: CaptureGraph.PROVENANCE.OBSERVED,
          evidenceRefs: [graphRequest.id]
        }, { bodyStore: captureStorage });
        CaptureGraph.addApiExchange(captureGraph, {
          missionId: activeMissionId,
          requestId: graphRequest.id,
          responseId: graphResponse.id,
          resourceType: 'CacheStorage',
          classification: 'browser-cache'
        });
        captureReport.cacheResources += 1;
        captureReport.durableStorage.persistedBodies = captureGraph.bodies.filter((item) => item.storageKey).length;
        captureReport.durableStorage.persistedBytes = captureGraph.bodies.reduce((total, item) => total + (item.storageKey ? item.size : 0), 0);
        captureReport.peakBodyBytesHeld = Math.max(captureReport.peakBodyBytesHeld, graphResponse.size || 0);
        queueMissionSnapshot();
      } catch (error) {
        if (error && error.code === 'quota-exhausted') {
          captureStorageFailure = error;
          await persistMissionSnapshot('partial', { recovery: { recoverable: true, interruptedAt: Date.now(), reason: 'quota-exhausted' } });
          throw error;
        }
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

  let captureTabId = tabId;
  let crawlPlanner = null;
  try {
    if (operation) operation.captureMode = mode;
    reportCaptureProgress(operation, 'Подготовка страницы', mode === 'deep' ? 'Создаю изолированную вкладку...' : 'Подключаюсь к текущей странице...', 5);
    const sourceTab = await chrome.tabs.get(tabId);
    if (mode === 'deep') {
      const isolatedTab = await chrome.tabs.create({ url: 'about:blank', active: false });
      captureTabId = isolatedTab.id;
      isolatedCaptureTabId = captureTabId;
      operation.captureScenario = scenario;
    }
    const attached = await attach(captureTabId, { tabId, url: sourceTab.url });
    if (!attached.ok) {
      reply(attached);
      return;
    }
    if (operation.cancelRequested) {
      reply({ ok: false, error: 'Захват отменён', missionId: activeMissionId, cancelled: true });
      return;
    }
    reportCaptureProgress(operation, mode === 'deep' ? 'Глубокий обход сайта' : 'Захват страницы', mode === 'deep' ? 'Подключено. Начинаю обход сайта...' : 'Подключено. Перезагружаю страницу...', 8);

    await chrome.debugger.sendCommand({ tabId: captureTabId }, 'Page.enable');
    const initialDocument = mode === 'quick'
      ? await optionalStage('Current live DOM state', () => captureLiveDomState(captureTabId), null)
      : null;
    let interaction = { clicked: 0, skipped: 0, states: 0, hover: { hovered: 0 }, replayedScenario: { total: 0, replayed: 0 }, startActivation: { clicked: 0, waited: 0 }, scrollContainers: 0 };

    if (mode === 'deep') {
      crawlPlanner = await runRenderedPageCrawler(captureTabId, sourceTab.url, operation);
      interaction = operation.crawlInteraction || interaction;
    } else {
      const pageLoaded = waitForPageLoad(captureTabId);
      await chrome.tabs.reload(captureTabId);
      await pageLoaded;
      await sleep(600);
    }

    const bodyReadsComplete = await waitForPendingBodies(mode === 'deep' ? 10000 : 3000);
    captureGraph.captureEvidenceClosed = true;
    if (operation && operation.cancelRequested) {
      reply({ ok: false, error: 'Захват отменён', missionId: activeMissionId, cancelled: true });
      return;
    }
    if (captureStorageFailure) {
      await persistMissionSnapshot('partial', { recovery: { recoverable: true, interruptedAt: Date.now(), reason: 'quota-exhausted' } });
      reply({ ok: false, error: captureStorageFailure.message, missionId: activeMissionId, recoverable: true });
      return;
    }

    const currentTab = await chrome.tabs.get(captureTabId);
    reportCaptureProgress(operation, 'Завершение захвата', 'Собираю перехваченные ответы и DOM...', 50);
    const pageUrl = mode === 'deep' ? sourceTab.url : currentTab.url;
    if (mode === 'deep') await optionalStage('Cache Storage export', () => captureKnownCaches(captureTabId, pageUrl), undefined);
    const domain = new URL(pageUrl).hostname || 'site';
    const document = mode === 'deep' ? operation.rootDocument : initialDocument || await captureLiveDomState(captureTabId);
    if (!document) throw new Error('Rendered crawler did not capture the entry route');

    if (mode !== 'deep') {
      const documentArtifact = await CaptureGraph.addDerivedArtifact(captureGraph, {
        missionId: activeMissionId,
        artifactType: 'live-document-html',
        body: document.html,
        mimeType: 'text/html',
        originalUrl: pageUrl,
        inputEvidenceIds: captureGraph.responses.filter((response) => response.resourceType === 'Document').map((response) => response.id),
        transform: document.method,
        transformVersion: 1
      }, { bodyStore: captureStorage });
      const graphDocument = CaptureGraph.addDocument(captureGraph, {
        missionId: activeMissionId,
        targetId: targetIdsBySession.get('root') || null,
        originalUrl: pageUrl,
        documentKind: 'live-page',
        bodyId: documentArtifact.bodyId,
        snapshotVersion: document.version,
        stateSummary: document.summary,
        provenance: CaptureGraph.PROVENANCE.DERIVED,
        evidenceRefs: [documentArtifact.id]
      });
      for (const diagnostic of document.diagnostics || []) CaptureGraph.addDiagnostic(captureGraph, {
        missionId: activeMissionId,
        code: diagnostic.code,
        severity: 'warning',
        phase: 'live-dom-state',
        message: diagnostic.reason,
        occurrenceCount: diagnostic.count,
        evidenceRefs: [graphDocument.id, documentArtifact.id],
        provenance: CaptureGraph.PROVENANCE.DERIVED
      });
    }

    captureReport.liveDomState = structuredClone(document.summary);
    const graphMission = captureGraph.missions.find((mission) => mission.id === activeMissionId);
    if (graphMission) graphMission.state = bodyReadsComplete ? 'capture-complete' : 'partial';
    const bodies = CaptureGraph.projectV1Bodies(captureGraph);
    const projectedApiSnapshots = CaptureGraph.projectV1ApiSnapshots(captureGraph);
    captureReport.captureGraphParity = {
      bodiesMatch: bodies.every((body) => body.body == null && Boolean(body.storageKey)),
      snapshotsMatch: projectedApiSnapshots.every((snapshot) => snapshot.body == null && Boolean(snapshot.storageKey)),
      measurement: 'durable-projection-integrity'
    };
    captureReport.retainedBodies = bodies.length;
    captureReport.apiSnapshotCount = projectedApiSnapshots.length;
    const projectedReport = CaptureGraph.projectReport(captureGraph, captureReport);
    await persistMissionSnapshot(graphMission && graphMission.state || 'capture-complete', {
      recovery: { recoverable: true, interruptedAt: null, reason: null },
      crawlBudget: crawlPlanner && crawlPlanner.budgetSnapshot()
    });

    reply({
      ok: true,
      html: document.html,
      bodies,
      apiSnapshots: projectedApiSnapshots,
      captureGraph,
      interaction,
      liveDomState: document.summary,
      crawlBudget: crawlPlanner && crawlPlanner.budgetSnapshot(),
      report: PrivacyGuardrails.sanitizeMetadata(projectedReport, 'captureReport'),
      mode,
      domain,
      pageUrl,
      htmlMethod: document.method
    });
  } catch (error) {
    if (activeMissionId && !(operation && operation.cancelRequested)) {
      await persistMissionSnapshot('partial', {
        recovery: { recoverable: true, interruptedAt: Date.now(), reason: error.code || 'capture-failed' }
      }).catch(() => {});
    }
    reply({ ok: false, error: operation && operation.cancelRequested ? 'Захват отменён' : error.message || 'Не удалось захватить страницу', missionId: activeMissionId, recoverable: Boolean(activeMissionId) });
  } finally {
    if (activeTabId === captureTabId) await detach();
    if (captureTabId !== tabId) {
      await chrome.tabs.remove(captureTabId).catch(() => {});
      isolatedCaptureTabId = null;
    }
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
    const serializerSource = serializeForRuntime(LiveDomState.serializerSource());
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
            const serializer = (0, eval)('(' + ${serializerSource} + ')');
            return serializer({ root: element, selection: true }).then((selected) => ({ ...selected, label: describe(element) }));
          };
          const onMove = (event) => update(document.elementFromPoint(event.clientX, event.clientY));
          const onClick = async (event) => {
            if (!current) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
              window.__siteSaverPickElement(JSON.stringify({ selected: await serialize(current) }));
            } catch (error) {
              window.__siteSaverPickElement(JSON.stringify({ cancelled: true, error: error.message }));
            } finally {
              cleanup();
            }
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
  const missionId = activeMissionId;
  if (activeTabId === tabId) await detach();
  if (missionId) await captureStorage.cleanupMission(missionId).catch(() => {});
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
            const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
            const fieldName = [element.getAttribute('name'), element.id, element.getAttribute('aria-label')].filter(Boolean).join(' ');
            const sensitive = inputType === 'password' || inputType === 'file'
              || /(?:^|\s)(?:cc-|current-password|new-password|one-time-code|webauthn)/.test(autocomplete)
              || /(?:^|[_\-.\s])(?:access[_-]?token|api[_-]?key|auth|card(?:holder|number)?|client[_-]?secret|credential|csrf|cvc|cvv|password|passcode|pin|refresh[_-]?token|secret|session(?:id)?|token|xsrf)(?:$|[_\-.\s])/i.test(fieldName);
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

async function replayScenario(tabId, scenario, maxDurationMs = 12000) {
  if (!scenario.length) return { total: 0, replayed: 0 };
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const actions = ${serializeForRuntime(scenario)};
        const deadline = Date.now() + ${Math.max(0, maxDurationMs)};
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let replayed = 0;
        for (const action of actions) {
          if (Date.now() >= deadline) break;
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

async function activateStartOverlay(tabId, maxDurationMs = 8000) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const deadline = Date.now() + ${Math.max(0, maxDurationMs)};
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
        for (; waited < 8000 && Date.now() < deadline; waited += 250) {
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

async function countClosedShadowRoots(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1, pierce: true });
    let count = 0;
    const visit = (node) => {
      for (const shadowRoot of node && node.shadowRoots || []) {
        if (shadowRoot.shadowRootType === 'closed') count += 1;
        visit(shadowRoot);
      }
      for (const child of node && node.children || []) visit(child);
      if (node && node.contentDocument) visit(node.contentDocument);
    };
    visit(result.root);
    return count;
  } catch (error) {
    return 0;
  }
}

async function captureLiveDomState(tabId) {
  const closedShadowRoots = await countClosedShadowRoots(tabId);
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: LiveDomState.expression({ closedShadowRoots }),
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Live DOM serializer failed');
    const snapshot = result.result && result.result.value;
    if (!snapshot || !snapshot.html) throw new Error('Live DOM serializer returned empty HTML');
    return {
      ...snapshot,
      method: 'live-dom-state-v1',
      summary: snapshot.summary || {},
      diagnostics: snapshot.diagnostics || []
    };
  } catch (error) {
    const fallback = await getDocumentHtml(tabId);
    return {
      ...fallback,
      version: 1,
      summary: {},
      diagnostics: [{ code: 'live-dom-state-unavailable', reason: error.message, count: 1 }]
    };
  }
}

async function scrollForLazyResources(tabId, maxDurationMs = 15000) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const deadline = Date.now() + ${Math.max(0, maxDurationMs)};
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
        for (let pass = 0; pass < 4 && Date.now() < deadline; pass += 1) {
          const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          for (let y = 0; y < height; y += Math.max(400, window.innerHeight * 0.75)) {
            if (Date.now() >= deadline) break;
            window.scrollTo(0, y);
            await delay(120);
          }
          for (const container of containers()) {
            if (Date.now() >= deadline) break;
            const originalTop = container.scrollTop;
            for (let top = 0; top < container.scrollHeight; top += Math.max(250, container.clientHeight * 0.75)) {
              if (Date.now() >= deadline) break;
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

async function exploreHoverStates(tabId, maxDurationMs = 10000) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const deadline = Date.now() + ${Math.max(0, maxDurationMs)};
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
          if (Date.now() >= deadline) break;
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

async function exploreInteractiveElements(tabId, maxDurationMs = 20000) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const deadline = Date.now() + ${Math.max(0, maxDurationMs)};
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
        for (let round = 0; round < 8 && clicked < 120 && Date.now() < deadline; round += 1) {
          const candidates = roots().flatMap((root) => [...root.querySelectorAll(selector)]);
          let clickedThisRound = 0;

          for (const element of candidates) {
            if (Date.now() >= deadline) break;
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

function waitForPageLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent.removeListener(handler);
      resolve(result);
    };
    const handler = (debuggeeId, method) => {
      if (debuggeeId.tabId === tabId && method === 'Page.loadEventFired') finish('loaded');
    };
    chrome.debugger.onEvent.addListener(handler);
    setTimeout(() => finish('load-timeout'), timeout);
  });
}

async function waitForPendingBodies(timeout) {
  const started = Date.now();
  while ((pendingResponses.size > 0 || pendingBodyReads.size > 0 || streamedBodies.size > 0) && Date.now() - started < timeout) {
    await sleep(100);
  }
  if (pendingResponses.size > 0 || pendingBodyReads.size > 0 || streamedBodies.size > 0) {
    for (const request of pendingRequests.values()) {
      if (request.responseId) CaptureGraph.markResponseBodyUnavailable(captureGraph, request.responseId, 'Timed out while reading response body');
      addReport('unreadableResponses', { url: request.url || 'Unknown response', reason: 'Timed out while reading response body' }, [request.graphRequestId, request.responseId].filter(Boolean), CaptureGraph.PROVENANCE.OBSERVED);
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
      html: (await captureLiveDomState(tabId)).html,
      bodies: CaptureGraph.projectV1Bodies(captureGraph),
      apiSnapshots: CaptureGraph.projectV1ApiSnapshots(captureGraph),
      captureGraph,
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
  bodyReadQueue.length = 0;
  pendingRequests.clear();
  streamedBodies.clear();
  captureStorageFailure = null;
  activeMissionId = null;
  targetIdsBySession.clear();
  inFlightRequestKeys.clear();
  crawlBytesCaptured = 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
