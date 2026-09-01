(function initializeCaptureGraph(globalScope) {
  'use strict';

  const SCHEMA_NAME = 'opensave-capture-graph';
  const SCHEMA_VERSION = 1;
  const PROVENANCE = Object.freeze({
    OBSERVED: 'observed',
    REFETCHED: 'refetched',
    DERIVED: 'derived',
    INFERRED: 'inferred',
    USER_SUPPLIED: 'user-supplied'
  });
  const PROVENANCE_VALUES = new Set(Object.values(PROVENANCE));
  const RECORD_FAMILIES = [
    'missions',
    'targets',
    'requests',
    'responses',
    'bodies',
    'documents',
    'routes',
    'dependencyEdges',
    'apiExchanges',
    'derivedArtifacts',
    'diagnostics'
  ];

  function createCaptureGraph() {
    return {
      schemaName: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      minimumReaderVersion: 1,
      createdAt: Date.now(),
      captureEvidenceClosed: false,
      nextIds: {},
      missions: [],
      targets: [],
      requests: [],
      responses: [],
      bodies: [],
      documents: [],
      routes: [],
      dependencyEdges: [],
      apiExchanges: [],
      derivedArtifacts: [],
      diagnostics: []
    };
  }

  function assertGraph(graph) {
    if (!graph || graph.schemaName !== SCHEMA_NAME || graph.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Unsupported capture graph schema; expected ${SCHEMA_NAME} v${SCHEMA_VERSION}`);
    }
  }

  function normalizeProvenance(value, fallback = PROVENANCE.OBSERVED) {
    const provenance = value || fallback;
    if (!PROVENANCE_VALUES.has(provenance)) throw new Error(`Unsupported provenance: ${provenance}`);
    return provenance;
  }

  function nextId(graph, family, prefix) {
    const sequence = (graph.nextIds[family] || 0) + 1;
    graph.nextIds[family] = sequence;
    return `${prefix}-${sequence}`;
  }

  function normalizeUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch (error) {
      return String(value);
    }
  }

  function cloneHeaders(headers) {
    if (!headers) return {};
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers.map((header) => [String(header.name || ''), String(header.value || '')]));
    }
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
  }

  function baseRecord(graph, family, prefix, input, fallbackProvenance) {
    return {
      id: input.id || nextId(graph, family, prefix),
      missionId: input.missionId || null,
      provenance: normalizeProvenance(input.provenance, fallbackProvenance),
      evidenceRefs: [...new Set(input.evidenceRefs || [])]
    };
  }

  function addMission(graph, input = {}) {
    assertGraph(graph);
    const mission = {
      ...baseRecord(graph, 'missions', 'mission', input, PROVENANCE.USER_SUPPLIED),
      missionType: input.missionType || 'capture',
      captureMode: input.captureMode || 'quick',
      state: input.state || 'active',
      startedAt: input.startedAt ?? Date.now(),
      completedAt: input.completedAt ?? null,
      sourceTabId: input.sourceTabId ?? null,
      sourceUrl: input.sourceUrl || ''
    };
    mission.missionId = mission.id;
    graph.missions.push(mission);
    return mission;
  }

  function addTarget(graph, input = {}) {
    assertGraph(graph);
    const target = {
      ...baseRecord(graph, 'targets', 'target', input, PROVENANCE.OBSERVED),
      targetType: input.targetType || 'page',
      cdpTargetId: input.cdpTargetId || null,
      cdpSessionId: input.cdpSessionId || null,
      frameId: input.frameId || null,
      parentTargetId: input.parentTargetId || null,
      originalUrl: input.originalUrl || '',
      normalizedUrl: normalizeUrl(input.originalUrl),
      attachedAt: input.attachedAt ?? Date.now()
    };
    graph.targets.push(target);
    return target;
  }

  function addRequest(graph, input = {}) {
    assertGraph(graph);
    const originalUrl = input.originalUrl || input.url || '';
    const hasRequestBody = Object.prototype.hasOwnProperty.call(input, 'requestBody') || Object.prototype.hasOwnProperty.call(input, 'postData');
    const requestBody = input.requestBody ?? input.postData ?? '';
    const request = {
      ...baseRecord(graph, 'requests', 'request', input, PROVENANCE.OBSERVED),
      targetId: input.targetId || null,
      sourceTargetId: input.sourceTargetId || input.targetId || null,
      frameId: input.frameId || null,
      cdpRequestId: input.cdpRequestId || null,
      sequence: input.sequence ?? graph.requests.length + 1,
      method: String(input.method || 'GET').toUpperCase(),
      originalUrl,
      normalizedUrl: normalizeUrl(originalUrl),
      headers: cloneHeaders(input.headers),
      requestBody: hasRequestBody ? requestBody : null,
      requestBodyHash: hasRequestBody ? `sha256:${sha256Hex(toUtf8Bytes(String(requestBody)))}` : null,
      timestamp: input.timestamp ?? Date.now(),
      wallTime: input.wallTime ?? null,
      initiator: input.initiator ? structuredCloneValue(input.initiator) : null,
      redirectPredecessorRequestId: input.redirectPredecessorRequestId || null,
      redirectSuccessorRequestId: input.redirectSuccessorRequestId || null
    };
    graph.requests.push(request);
    return request;
  }

  function addResponse(graph, input = {}) {
    assertGraph(graph);
    const originalUrl = input.originalUrl || input.url || '';
    const response = {
      ...baseRecord(graph, 'responses', 'response', input, PROVENANCE.OBSERVED),
      requestId: input.requestId || null,
      targetId: input.targetId || null,
      sourceTargetId: input.sourceTargetId || input.targetId || null,
      frameId: input.frameId || null,
      originalUrl,
      normalizedUrl: normalizeUrl(originalUrl),
      status: Number(input.status || 0),
      statusText: input.statusText || '',
      headers: cloneHeaders(input.headers),
      mimeType: input.mimeType || '',
      protocol: input.protocol || '',
      resourceType: input.resourceType || '',
      timestamp: input.timestamp ?? Date.now(),
      responseTime: input.responseTime ?? null,
      fromDiskCache: Boolean(input.fromDiskCache),
      fromServiceWorker: Boolean(input.fromServiceWorker),
      encodedSize: input.encodedSize ?? null,
      bodyState: input.bodyState || 'pending',
      bodyId: input.bodyId || null,
      contentHash: input.contentHash || null,
      size: input.size ?? null,
      failureReason: input.failureReason || null,
      redirectSuccessorRequestId: input.redirectSuccessorRequestId || null
    };
    graph.responses.push(response);
    return response;
  }

  async function bodyToBytes(body, base64Encoded) {
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (typeof body !== 'string') return toUtf8Bytes(String(body ?? ''));
    if (!base64Encoded) return toUtf8Bytes(body);
    if (typeof atob === 'function') {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    return new Uint8Array(Buffer.from(body, 'base64'));
  }

  async function contentHashForBody(body, base64Encoded = false) {
    return `sha256:${sha256Hex(await bodyToBytes(body, base64Encoded))}`;
  }

  async function addBody(graph, input = {}, options = {}) {
    assertGraph(graph);
    const bytes = await bodyToBytes(input.body, Boolean(input.base64Encoded));
    const contentHash = `sha256:${sha256Hex(bytes)}`;
    let body = graph.bodies.find((candidate) => candidate.contentHash === contentHash);
    let storageReference = null;
    if (options.bodyStore) {
      if (body && body.storageKey) {
        storageReference = body;
      } else {
        const writer = await options.bodyStore.beginBody(input.missionId, bytes.byteLength);
        try {
          const chunkSize = options.chunkSize || 1024 * 1024;
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            await writer.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
          }
          storageReference = await writer.commit(contentHash, { size: bytes.byteLength, mimeType: input.mimeType || '' });
        } catch (error) {
          await writer.abort(error.message);
          throw error;
        }
      }
    }
    body = graph.bodies.find((candidate) => candidate.contentHash === contentHash);
    if (!body) {
      body = {
        ...baseRecord(graph, 'bodies', 'body', { ...input, id: `body-${contentHash}` }, input.provenance || PROVENANCE.OBSERVED),
        contentHash,
        size: bytes.byteLength,
        mimeType: input.mimeType || '',
        body: options.bodyStore ? null : input.body,
        base64Encoded: Boolean(input.base64Encoded),
        integrity: 'verified',
        storageKey: storageReference ? storageReference.storageKey : null,
        storageChunkCount: storageReference ? storageReference.chunkCount : null,
        responseIds: [],
        acquisitions: []
      };
      graph.bodies.push(body);
    } else if (storageReference && !body.storageKey) {
      body.storageKey = storageReference.storageKey;
      body.storageChunkCount = storageReference.chunkCount;
      body.body = null;
    }
    const acquisition = {
      provenance: normalizeProvenance(input.provenance, PROVENANCE.OBSERVED),
      missionId: input.missionId || null,
      responseId: input.responseId || null,
      evidenceRefs: [...new Set(input.evidenceRefs || [])]
    };
    if (!body.acquisitions.some((candidate) => candidate.provenance === acquisition.provenance && candidate.responseId === acquisition.responseId && candidate.evidenceRefs.join('\n') === acquisition.evidenceRefs.join('\n'))) {
      body.acquisitions.push(acquisition);
    }
    if (input.responseId && !body.responseIds.includes(input.responseId)) body.responseIds.push(input.responseId);
    for (const evidenceId of input.evidenceRefs || []) {
      if (!body.evidenceRefs.includes(evidenceId)) body.evidenceRefs.push(evidenceId);
    }
    const response = input.responseId && graph.responses.find((candidate) => candidate.id === input.responseId);
    if (response) {
      if (response.bodyStoredSequence == null) {
        graph.nextIds.bodyStores = (graph.nextIds.bodyStores || 0) + 1;
        response.bodyStoredSequence = graph.nextIds.bodyStores;
      }
      response.bodyId = body.id;
      response.contentHash = body.contentHash;
      response.size = body.size;
      response.bodyState = 'stored';
      response.failureReason = null;
      if (!response.evidenceRefs.includes(body.id)) response.evidenceRefs.push(body.id);
    }
    return body;
  }

  function markResponseBodyUnavailable(graph, responseId, reason) {
    assertGraph(graph);
    const response = graph.responses.find((candidate) => candidate.id === responseId);
    if (!response) return null;
    response.bodyState = 'unavailable';
    response.failureReason = reason || 'Body unavailable';
    return response;
  }

  function addDocument(graph, input = {}) {
    assertGraph(graph);
    const originalUrl = input.originalUrl || input.url || '';
    const document = {
      ...baseRecord(graph, 'documents', 'document', input, input.provenance || PROVENANCE.OBSERVED),
      targetId: input.targetId || null,
      responseId: input.responseId || null,
      originalUrl,
      normalizedUrl: normalizeUrl(originalUrl),
      documentKind: input.documentKind || 'page',
      bodyId: input.bodyId || null,
      snapshotVersion: input.snapshotVersion ?? null,
      stateSummary: input.stateSummary ? structuredCloneValue(input.stateSummary) : null,
      routeId: input.routeId || null,
      capturedAt: input.capturedAt ?? Date.now()
    };
    graph.documents.push(document);
    return document;
  }

  function addRoute(graph, input = {}) {
    assertGraph(graph);
    const originalUrl = input.originalUrl || input.routeUrl || '';
    const route = {
      ...baseRecord(graph, 'routes', 'route', input, input.provenance || PROVENANCE.DERIVED),
      originalUrl,
      normalizedUrl: normalizeUrl(originalUrl),
      routeUrl: input.routeUrl || originalUrl,
      normalizedDocumentUrl: input.normalizedDocumentUrl || normalizeUrl(originalUrl),
      transitionKind: input.transitionKind || 'document',
      discoveryKind: input.discoveryKind || 'anchor',
      discoveredFromRouteId: input.discoveredFromRouteId || null,
      sourceLocation: input.sourceLocation ? structuredCloneValue(input.sourceLocation) : null,
      state: input.state || 'discovered',
      decisionReason: input.decisionReason || null,
      finalUrl: input.finalUrl || null,
      canonicalUrl: input.canonicalUrl || null,
      aliasRouteIds: [...new Set(input.aliasRouteIds || [])],
      targetId: input.targetId || null,
      documentId: input.documentId || null,
      idleResult: input.idleResult || null,
      fidelity: input.fidelity || null,
      capturedBytes: input.capturedBytes || 0,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null
    };
    graph.routes.push(route);
    return route;
  }

  function updateRoute(graph, routeId, changes = {}) {
    assertGraph(graph);
    const route = graph.routes.find((candidate) => candidate.id === routeId);
    if (!route) throw new Error(`Unknown route: ${routeId}`);
    Object.assign(route, structuredCloneValue(changes));
    if (changes.aliasRouteIds) route.aliasRouteIds = [...new Set(changes.aliasRouteIds)];
    return route;
  }

  function projectRenderedPages(graph) {
    assertGraph(graph);
    return graph.routes.filter((route) => route.state === 'captured' && route.documentId).map((route) => {
      const document = graph.documents.find((candidate) => candidate.id === route.documentId);
      const body = document && graph.bodies.find((candidate) => candidate.id === document.bodyId);
      if (!document || !body) return null;
      const aliases = [route.originalUrl, route.routeUrl, route.finalUrl, route.canonicalUrl].filter(Boolean);
      for (const aliasRouteId of route.aliasRouteIds || []) {
        const alias = graph.routes.find((candidate) => candidate.id === aliasRouteId);
        if (alias) aliases.push(alias.routeUrl || alias.originalUrl);
      }
      return {
        routeId: route.id,
        url: route.finalUrl || route.routeUrl,
        routeUrl: route.routeUrl,
        aliases: [...new Set(aliases)],
        transitionKind: route.transitionKind,
        fidelity: route.fidelity,
        idleResult: route.idleResult,
        mimeType: body.mimeType || 'text/html',
        body: body.body,
        base64Encoded: body.base64Encoded,
        storageKey: body.storageKey,
        contentHash: body.contentHash,
        evidenceRefs: [route.id, document.id, body.id]
      };
    }).filter(Boolean);
  }

  function addDependencyEdge(graph, input = {}) {
    assertGraph(graph);
    const edge = {
      ...baseRecord(graph, 'dependencyEdges', 'edge', input, input.provenance || PROVENANCE.DERIVED),
      ownerEvidenceId: input.ownerEvidenceId || null,
      targetEvidenceId: input.targetEvidenceId || null,
      originalUrl: input.originalUrl || '',
      normalizedUrl: normalizeUrl(input.originalUrl),
      syntaxKind: input.syntaxKind || 'unknown',
      rawValue: input.rawValue || input.originalUrl || '',
      resolvedUrl: input.resolvedUrl || input.originalUrl || '',
      sourceLocation: input.sourceLocation ? structuredCloneValue(input.sourceLocation) : null,
      role: input.role || 'resource',
      rewritePolicy: input.rewritePolicy || 'block-unresolved-subresource',
      disposition: input.disposition || 'discovered'
    };
    graph.dependencyEdges.push(edge);
    return edge;
  }

  function addApiExchange(graph, input = {}) {
    assertGraph(graph);
    const request = graph.requests.find((candidate) => candidate.id === input.requestId);
    const response = graph.responses.find((candidate) => candidate.id === input.responseId);
    const exchange = {
      ...baseRecord(graph, 'apiExchanges', 'exchange', input, (request && request.provenance) || PROVENANCE.OBSERVED),
      requestId: input.requestId || null,
      responseId: input.responseId || null,
      resourceType: input.resourceType || (response && response.resourceType) || '',
      classification: input.classification || 'api'
    };
    exchange.evidenceRefs = [...new Set([...exchange.evidenceRefs, exchange.requestId, exchange.responseId].filter(Boolean))];
    graph.apiExchanges.push(exchange);
    return exchange;
  }

  async function addDerivedArtifact(graph, input = {}, options = {}) {
    assertGraph(graph);
    const artifact = {
      ...baseRecord(graph, 'derivedArtifacts', 'artifact', { ...input, provenance: PROVENANCE.DERIVED }, PROVENANCE.DERIVED),
      artifactType: input.artifactType || 'derived-artifact',
      transform: input.transform || 'unknown',
      transformVersion: input.transformVersion ?? 1,
      inputEvidenceIds: [...new Set(input.inputEvidenceIds || [])],
      originalUrl: input.originalUrl || '',
      normalizedUrl: normalizeUrl(input.originalUrl),
      bodyId: null,
      createdAt: input.createdAt ?? Date.now()
    };
    const body = await addBody(graph, {
      missionId: artifact.missionId,
      body: input.body,
      base64Encoded: Boolean(input.base64Encoded),
      mimeType: input.mimeType || '',
      provenance: PROVENANCE.DERIVED,
      evidenceRefs: artifact.inputEvidenceIds
    }, options);
    artifact.bodyId = body.id;
    artifact.evidenceRefs = [...new Set([...artifact.evidenceRefs, ...artifact.inputEvidenceIds, body.id])];
    graph.derivedArtifacts.push(artifact);
    return artifact;
  }

  function addDiagnostic(graph, input = {}) {
    assertGraph(graph);
    const diagnostic = {
      ...baseRecord(graph, 'diagnostics', 'diagnostic', input, input.provenance || PROVENANCE.INFERRED),
      code: input.code || 'unspecified',
      severity: input.severity || 'warning',
      phase: input.phase || 'capture',
      message: input.message || '',
      occurrenceCount: input.occurrenceCount ?? 1,
      truncated: Boolean(input.truncated),
      timestamp: input.timestamp ?? Date.now()
    };
    graph.diagnostics.push(diagnostic);
    return diagnostic;
  }

  function materializeBody(graph, response, request) {
    const body = graph.bodies.find((candidate) => candidate.id === response.bodyId);
    if (!body) return null;
    return {
      url: response.normalizedUrl,
      mimeType: response.mimeType || body.mimeType || '',
      body: body.body,
      base64Encoded: body.base64Encoded,
      storageKey: body.storageKey,
      contentHash: body.contentHash,
      preserveUrl: response.resourceType === 'Fetch' || response.resourceType === 'XHR',
      evidenceRefs: [request && request.id, response.id, body.id].filter(Boolean),
      provenance: response.provenance
    };
  }

  function projectV1Bodies(graph) {
    assertGraph(graph);
    const byUrl = new Map();
    const responses = graph.responses.filter((response) => response.bodyId).sort((left, right) => left.bodyStoredSequence - right.bodyStoredSequence);
    for (const response of responses) {
      if (!response.bodyId || !response.normalizedUrl) continue;
      const request = graph.requests.find((candidate) => candidate.id === response.requestId);
      const projected = materializeBody(graph, response, request);
      if (!projected) continue;
      if (!byUrl.has(projected.url)) byUrl.set(projected.url, projected);
      else if (projected.preserveUrl) byUrl.get(projected.url).preserveUrl = true;
    }
    return [...byUrl.values()].map((resource) => ({ ...resource, evidenceRefs: [...resource.evidenceRefs] }));
  }

  function projectV1ApiSnapshots(graph) {
    assertGraph(graph);
    const snapshots = new Map();
    const exchanges = [...graph.apiExchanges].sort((left, right) => {
      const leftResponse = graph.responses.find((response) => response.id === left.responseId);
      const rightResponse = graph.responses.find((response) => response.id === right.responseId);
      return (leftResponse && leftResponse.bodyStoredSequence || Number.MAX_SAFE_INTEGER) - (rightResponse && rightResponse.bodyStoredSequence || Number.MAX_SAFE_INTEGER);
    });
    for (const exchange of exchanges) {
      const request = graph.requests.find((candidate) => candidate.id === exchange.requestId);
      const response = graph.responses.find((candidate) => candidate.id === exchange.responseId);
      if (!request || !response || !response.bodyId || response.status < 200 || response.status >= 300) continue;
      const body = graph.bodies.find((candidate) => candidate.id === response.bodyId);
      if (!body) continue;
      const postData = request.requestBody == null ? '' : String(request.requestBody);
      const key = `${request.method}\n${response.normalizedUrl}\n${postData}`;
      if (snapshots.has(key)) continue;
      snapshots.set(key, {
        url: response.normalizedUrl,
        method: request.method,
        postData,
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType || body.mimeType || '',
        body: body.body,
        base64Encoded: body.base64Encoded,
        storageKey: body.storageKey,
        contentHash: body.contentHash,
        evidenceRefs: [request.id, response.id, body.id, exchange.id],
        provenance: response.provenance
      });
    }
    return [...snapshots.values()].map((snapshot) => ({ ...snapshot, evidenceRefs: [...snapshot.evidenceRefs] }));
  }

  function projectReplayExchanges(graph) {
    assertGraph(graph);
    return [...graph.apiExchanges]
      .map((exchange, index) => {
        const request = graph.requests.find((candidate) => candidate.id === exchange.requestId);
        const response = graph.responses.find((candidate) => candidate.id === exchange.responseId);
        const body = response && response.bodyId && graph.bodies.find((candidate) => candidate.id === response.bodyId);
        if (!request || !response) return null;
        const contentType = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type');
        const responseHeaders = { ...(response.headers || {}) };
        const location = Object.entries(responseHeaders).find(([name]) => name.toLowerCase() === 'location');
        return {
          exchangeId: exchange.id,
          sequence: request.sequence || index + 1,
          method: request.method,
          url: response.normalizedUrl || request.normalizedUrl,
          contentType: contentType ? contentType[1] : '',
          requestBodyHash: request.requestBodyHash || 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          postData: request.requestBody == null ? '' : String(request.requestBody),
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          location: location ? location[1] : '',
          mimeType: response.mimeType || body && body.mimeType || '',
          body: body ? body.body : null,
          base64Encoded: Boolean(body && body.base64Encoded),
          storageKey: body && body.storageKey || null,
          contentHash: body && body.contentHash || null,
          bodyAvailable: Boolean(body),
          evidenceRefs: [request.id, response.id, body && body.id, exchange.id].filter(Boolean),
          provenance: response.provenance
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.sequence - right.sequence || left.exchangeId.localeCompare(right.exchangeId));
  }

  function projectReplayMisses(graph) {
    assertGraph(graph);
    const misses = [];
    for (const exchange of graph.apiExchanges) {
      const request = graph.requests.find((candidate) => candidate.id === exchange.requestId);
      const response = graph.responses.find((candidate) => candidate.id === exchange.responseId);
      if (!request || !response) continue;
      const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
      const replayUrl = response.normalizedUrl || request.normalizedUrl;
      let reasonCode = '';
      try {
        const parsed = new URL(replayUrl);
        if (!/^https?:$/.test(parsed.protocol)) reasonCode = 'unsupported-url-scheme';
      } catch (error) {
        reasonCode = 'invalid-request-url';
      }
      if (!reasonCode) {
        if (exchange.resourceType === 'WebSocket' || headers.upgrade === 'websocket') reasonCode = 'websocket';
        else if (headers.accept && headers.accept.toLowerCase().includes('text/event-stream')) reasonCode = 'sse';
        else if (headers.range) reasonCode = 'range-request';
        else if (!['GET', 'HEAD', 'POST'].includes(request.method)) reasonCode = 'unknown-mutation';
        else if (request.method === 'POST' && headers['content-type'] && !/^(?:application\/json|application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(headers['content-type'])) reasonCode = 'unsupported-post-content-type';
        else if (response.bodyState !== 'stored' && ![204, 205, 301, 302, 303, 307, 308].includes(response.status)) reasonCode = 'response-body-unavailable';
      }
      if (!reasonCode) continue;
      misses.push({
        reasonCode,
        evidenceRefs: [request.id, response.id, exchange.id],
        evidence: {
          exchangeId: exchange.id,
          requestId: request.id,
          responseId: response.id,
          method: request.method,
          url: replayUrl,
          status: response.status,
          resourceType: exchange.resourceType
        }
      });
    }
    return misses;
  }

  function countByProvenance(records) {
    const counts = Object.fromEntries(Object.values(PROVENANCE).map((value) => [value, 0]));
    for (const record of records) counts[record.provenance] = (counts[record.provenance] || 0) + 1;
    return counts;
  }

  function projectReport(graph, legacyReport = {}) {
    assertGraph(graph);
    const report = structuredCloneValue(legacyReport || {});
    const requestCounts = countByProvenance(graph.requests);
    const responseCounts = countByProvenance(graph.responses);
    const bodyCounts = Object.fromEntries(Object.values(PROVENANCE).map((value) => [value, 0]));
    for (const body of graph.bodies) {
      const provenances = new Set((body.acquisitions || [{ provenance: body.provenance }]).map((acquisition) => acquisition.provenance));
      for (const provenance of provenances) bodyCounts[provenance] = (bodyCounts[provenance] || 0) + 1;
    }
    const artifactCounts = countByProvenance(graph.derivedArtifacts);
    const requestsByUrl = new Map();
    for (const request of graph.requests) {
      if (!requestsByUrl.has(request.normalizedUrl)) requestsByUrl.set(request.normalizedUrl, []);
      requestsByUrl.get(request.normalizedUrl).push(request);
    }
    report.captureGraph = {
      schemaName: graph.schemaName,
      schemaVersion: graph.schemaVersion,
      missionId: graph.missions[0] ? graph.missions[0].id : null,
      records: Object.fromEntries(RECORD_FAMILIES.map((family) => [family, graph[family].length])),
      provenance: Object.fromEntries(Object.values(PROVENANCE).map((provenance) => [provenance, {
        requests: requestCounts[provenance] || 0,
        responses: responseCounts[provenance] || 0,
        bodies: bodyCounts[provenance] || 0,
        artifacts: artifactCounts[provenance] || 0
      }])),
      refetchedResources: graph.responses.filter((response) => response.provenance === PROVENANCE.REFETCHED).map((response) => ({
        responseId: response.id,
        requestId: response.requestId,
        url: response.normalizedUrl,
        status: response.status,
        mimeType: response.mimeType,
        bodyId: response.bodyId
      })),
      requestVariants: [...requestsByUrl.entries()].filter(([, requests]) => requests.length > 1).map(([url, requests]) => ({
        url,
        variants: requests.map((request) => ({
          requestId: request.id,
          method: request.method,
          requestBodyHash: request.requestBodyHash,
          provenance: request.provenance
        }))
      })),
      redirects: graph.requests.filter((request) => request.redirectPredecessorRequestId).map((request) => {
        const predecessor = graph.requests.find((candidate) => candidate.id === request.redirectPredecessorRequestId);
        return {
          requestId: request.id,
          predecessorRequestId: request.redirectPredecessorRequestId,
          predecessorUrl: predecessor && predecessor.originalUrl || '',
          originalUrl: request.originalUrl,
          normalizedUrl: request.normalizedUrl
        };
      }),
      bodyAliases: graph.bodies.filter((body) => body.responseIds.length > 1).map((body) => ({
        bodyId: body.id,
        contentHash: body.contentHash,
        size: body.size,
        responses: body.responseIds.map((responseId) => {
          const response = graph.responses.find((candidate) => candidate.id === responseId);
          return { responseId, url: response && response.normalizedUrl || '' };
        })
      })),
      apiExchanges: graph.apiExchanges.map((exchange) => {
        const request = graph.requests.find((candidate) => candidate.id === exchange.requestId);
        const response = graph.responses.find((candidate) => candidate.id === exchange.responseId);
        return {
          exchangeId: exchange.id,
          requestId: exchange.requestId,
          responseId: exchange.responseId,
          method: request && request.method || '',
          url: response && response.normalizedUrl || request && request.normalizedUrl || '',
          requestBodyHash: request && request.requestBodyHash || null,
          status: response && response.status || 0,
          mimeType: response && response.mimeType || '',
          bodyId: response && response.bodyId || null,
          provenance: exchange.provenance
        };
      }),
      diagnostics: graph.diagnostics.map((diagnostic) => ({
        id: diagnostic.id,
        code: diagnostic.code,
        severity: diagnostic.severity,
        phase: diagnostic.phase,
        provenance: diagnostic.provenance,
        evidenceRefs: [...diagnostic.evidenceRefs],
        occurrenceCount: diagnostic.occurrenceCount,
        truncated: diagnostic.truncated
      })),
      routes: graph.routes.map((route) => ({
        routeId: route.id,
        url: route.routeUrl,
        finalUrl: route.finalUrl,
        canonicalUrl: route.canonicalUrl,
        transitionKind: route.transitionKind,
        discoveryKind: route.discoveryKind,
        state: route.state,
        decisionReason: route.decisionReason,
        fidelity: route.fidelity,
        idleResult: route.idleResult,
        documentId: route.documentId
      }))
    };
    return report;
  }

  function validateGraph(graph) {
    const errors = [];
    if (!graph || graph.schemaName !== SCHEMA_NAME) return [`schemaName must be ${SCHEMA_NAME}`];
    if (graph.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    if (!Number.isInteger(graph.minimumReaderVersion) || graph.minimumReaderVersion > SCHEMA_VERSION) errors.push(`minimumReaderVersion must be an integer no greater than ${SCHEMA_VERSION}`);
    const ids = new Set();
    for (const family of RECORD_FAMILIES) {
      if (!Array.isArray(graph[family])) {
        errors.push(`${family} must be an array`);
        continue;
      }
      graph[family].forEach((record, index) => {
        if (!record || !record.id) errors.push(`${family}[${index}] must have an id`);
        else if (ids.has(record.id)) errors.push(`${family}[${index}] has duplicate id ${record.id}`);
        else ids.add(record.id);
        if (!record || !PROVENANCE_VALUES.has(record.provenance)) errors.push(`${family}[${index}] has invalid provenance`);
      });
    }
    const has = (family, id) => !id || (graph[family] || []).some((record) => record.id === id);
    const requireReference = (record, field, family) => {
      if (record[field] && !has(family, record[field])) errors.push(`${record.id} references missing ${family} record ${record[field]}`);
    };
    for (const family of RECORD_FAMILIES) {
      for (const record of graph[family] || []) {
        if (family !== 'missions' && !has('missions', record.missionId)) errors.push(`${record.id} references missing mission ${record.missionId}`);
        for (const evidenceId of record.evidenceRefs || []) {
          if (!ids.has(evidenceId)) errors.push(`${record.id} references missing evidence ${evidenceId}`);
        }
      }
    }
    for (const target of graph.targets || []) requireReference(target, 'parentTargetId', 'targets');
    for (const request of graph.requests || []) {
      requireReference(request, 'targetId', 'targets');
      requireReference(request, 'sourceTargetId', 'targets');
      requireReference(request, 'redirectPredecessorRequestId', 'requests');
      requireReference(request, 'redirectSuccessorRequestId', 'requests');
      if (request.requestBodyHash && !/^sha256:[a-f0-9]{64}$/.test(request.requestBodyHash)) errors.push(`${request.id} has invalid requestBodyHash`);
    }
    for (const response of graph.responses || []) {
      requireReference(response, 'requestId', 'requests');
      requireReference(response, 'targetId', 'targets');
      requireReference(response, 'sourceTargetId', 'targets');
      requireReference(response, 'bodyId', 'bodies');
      requireReference(response, 'redirectSuccessorRequestId', 'requests');
      if (response.contentHash && !/^sha256:[a-f0-9]{64}$/.test(response.contentHash)) errors.push(`${response.id} has invalid contentHash`);
      if (!['pending', 'stored', 'unavailable', 'not-captured', 'not-applicable'].includes(response.bodyState)) errors.push(`${response.id} has invalid bodyState`);
    }
    for (const body of graph.bodies || []) {
      if (!/^sha256:[a-f0-9]{64}$/.test(body.contentHash || '')) errors.push(`${body.id} has invalid contentHash`);
      if (!Number.isInteger(body.size) || body.size < 0) errors.push(`${body.id} has invalid size`);
      if (body.body == null && !body.storageKey) errors.push(`${body.id} has neither inline body nor storageKey`);
      for (const responseId of body.responseIds || []) {
        if (!has('responses', responseId)) errors.push(`${body.id} references missing response ${responseId}`);
      }
      for (const acquisition of body.acquisitions || []) {
        if (!PROVENANCE_VALUES.has(acquisition.provenance)) errors.push(`${body.id} has acquisition with invalid provenance`);
        if (!has('missions', acquisition.missionId)) errors.push(`${body.id} has acquisition with missing mission ${acquisition.missionId}`);
        if (!has('responses', acquisition.responseId)) errors.push(`${body.id} has acquisition with missing response ${acquisition.responseId}`);
        for (const evidenceId of acquisition.evidenceRefs || []) {
          if (!ids.has(evidenceId)) errors.push(`${body.id} acquisition references missing evidence ${evidenceId}`);
        }
      }
    }
    for (const exchange of graph.apiExchanges || []) {
      requireReference(exchange, 'requestId', 'requests');
      requireReference(exchange, 'responseId', 'responses');
    }
    for (const document of graph.documents || []) {
      requireReference(document, 'targetId', 'targets');
      requireReference(document, 'responseId', 'responses');
      requireReference(document, 'bodyId', 'bodies');
      requireReference(document, 'routeId', 'routes');
      if (document.snapshotVersion != null && document.snapshotVersion !== 1) errors.push(`${document.id} has unsupported snapshotVersion`);
    }
    for (const route of graph.routes || []) {
      requireReference(route, 'discoveredFromRouteId', 'routes');
      requireReference(route, 'targetId', 'targets');
      requireReference(route, 'documentId', 'documents');
      for (const aliasRouteId of route.aliasRouteIds || []) requireReference({ ...route, aliasRouteId }, 'aliasRouteId', 'routes');
      if (!['document', 'history'].includes(route.transitionKind)) errors.push(`${route.id} has invalid transitionKind`);
      if (!['discovered', 'accepted', 'visiting', 'captured', 'skipped', 'failed'].includes(route.state)) errors.push(`${route.id} has invalid state`);
      if (route.state === 'skipped' && !route.decisionReason) errors.push(`${route.id} is skipped without decisionReason`);
    }
    for (const edge of graph.dependencyEdges || []) {
      if (edge.ownerEvidenceId && !ids.has(edge.ownerEvidenceId)) errors.push(`${edge.id} references missing owner evidence ${edge.ownerEvidenceId}`);
      if (edge.targetEvidenceId && !ids.has(edge.targetEvidenceId)) errors.push(`${edge.id} references missing target evidence ${edge.targetEvidenceId}`);
    }
    for (const artifact of graph.derivedArtifacts || []) {
      requireReference(artifact, 'bodyId', 'bodies');
      for (const evidenceId of artifact.inputEvidenceIds || []) {
        if (!ids.has(evidenceId)) errors.push(`${artifact.id} references missing input evidence ${evidenceId}`);
      }
    }
    return errors;
  }

  function structuredCloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function toUtf8Bytes(value) {
    return new TextEncoder().encode(value);
  }

  function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  function sha256Hex(input) {
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
      for (let index = 16; index < 64; index += 1) {
        const word15 = words[index - 15];
        const word2 = words[index - 2];
        const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
        const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
  }

  const api = {
    SCHEMA_NAME,
    SCHEMA_VERSION,
    PROVENANCE,
    RECORD_FAMILIES,
    createCaptureGraph,
    addMission,
    addTarget,
    addRequest,
    addResponse,
    addBody,
    markResponseBodyUnavailable,
    addDocument,
    addRoute,
    updateRoute,
    addDependencyEdge,
    addApiExchange,
    addDerivedArtifact,
    addDiagnostic,
    projectV1Bodies,
    projectV1ApiSnapshots,
    projectReplayExchanges,
    projectReplayMisses,
    projectRenderedPages,
    projectReport,
    validateGraph,
    normalizeUrl,
    contentHashForBody,
    sha256Hex
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveCaptureGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
