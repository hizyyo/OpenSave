(function initializePrivacyGuardrails(globalScope) {
  'use strict';

  const REDACTED = '[REDACTED]';
  const SENSITIVE_HEADERS = new Set([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
    'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'apikey', 'api-key', 'token'
  ]);
  const SENSITIVE_NAMES = /(?:^|[_\-.])(access[_-]?token|auth|authorization|api[_-]?key|client[_-]?secret|credential|csrf|cvv|cvc|password|passwd|passcode|pin|refresh[_-]?token|secret|session|sessionid|token|xsrf)(?:$|[_\-.])/i;
  const SENSITIVE_QUERY_PARAMS = new Set([
    'token', 'access_token', 'id_token', 'refresh_token', 'auth', 'authorization',
    'key', 'api_key', 'apikey', 'secret', 'password', 'passwd', 'pwd', 'session',
    'sessionid', 'code', 'client_secret', 'csrf', 'xsrf'
  ]);
  const DETECTORS = [
    { category: 'private-key', confidence: 'high', expression: /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi },
    { category: 'jwt-token', confidence: 'high', expression: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.+/=-]{8,}\b/g },
    { category: 'authorization-token', confidence: 'high', expression: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
    { category: 'api-key', confidence: 'high', expression: /\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g },
    { category: 'generic-secret', confidence: 'medium', expression: /(?:api[_-]?key|client[_-]?secret|credential|password|refresh[_-]?token|secret|session(?:id)?|token)['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-.~+/=]{12,}/gi }
  ];

  function lengthBucket(value) {
    const length = String(value == null ? '' : value).length;
    if (length < 8) return '<8';
    if (length < 16) return '8-15';
    if (length < 32) return '16-31';
    if (length < 64) return '32-63';
    return '64+';
  }

  function maskValue(value) {
    return `<redacted:${lengthBucket(value)} chars>`;
  }

  function finding(category, location, confidence, value) {
    return { category, location, confidence, maskedPreview: maskValue(value) };
  }

  function isSensitiveName(name) {
    const normalized = String(name || '').trim().toLowerCase();
    return SENSITIVE_NAMES.test(normalized);
  }

  function isSensitiveQueryValue(name, value) {
    const normalized = String(name || '').trim().toLowerCase();
    if ((normalized === 'code' || normalized === 'key') && String(value || '').length < 12) return false;
    return SENSITIVE_QUERY_PARAMS.has(normalized) || isSensitiveName(normalized);
  }

  function replaceDetectedSecrets(text, location, findings) {
    let sanitized = String(text == null ? '' : text);
    for (const detector of DETECTORS) {
      detector.expression.lastIndex = 0;
      sanitized = sanitized.replace(detector.expression, (match) => {
        findings.push(finding(detector.category, location, detector.confidence, match));
        return REDACTED;
      });
    }
    return sanitized;
  }

  function scanText(text, location = 'text') {
    if (!text || typeof text !== 'string') return [];
    const findings = [];
    replaceDetectedSecrets(text, location, findings);
    return findings;
  }

  function sanitizeText(text, location = 'text') {
    const findings = [];
    const withSafeUrls = String(text == null ? '' : text).replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
      const result = sanitizeUrl(match, `${location}.url`);
      findings.push(...result.findings);
      return result.url;
    });
    const value = replaceDetectedSecrets(withSafeUrls, location, findings);
    return { value, findings, redactions: findings };
  }

  function sanitizeHeaders(headers = {}, location = 'headers') {
    const entries = Array.isArray(headers)
      ? headers.map((header) => [String(header.name || ''), String(header.value || '')])
      : Object.entries(headers || {}).map(([name, value]) => [name, String(value)]);
    const findings = [];
    const sanitizedEntries = entries.map(([name, value]) => {
      if (SENSITIVE_HEADERS.has(name.toLowerCase()) || isSensitiveName(name)) {
        findings.push(finding('header-secret', `${location}.${name}`, 'high', value));
        return [name, REDACTED];
      }
      const result = sanitizeText(value, `${location}.${name}`);
      findings.push(...result.findings);
      return [name, result.value];
    });
    const sanitized = Array.isArray(headers)
      ? sanitizedEntries.map(([name, value]) => ({ name, value }))
      : Object.fromEntries(sanitizedEntries);
    return { headers: sanitized, findings, redactions: findings };
  }

  function sanitizeUrl(rawUrl, location = 'url') {
    try {
      const url = new URL(rawUrl);
      const findings = [];
      if (url.username) {
        findings.push(finding('url-credential', `${location}.username`, 'high', url.username));
        url.username = REDACTED;
      }
      if (url.password) {
        findings.push(finding('url-credential', `${location}.password`, 'high', url.password));
        url.password = REDACTED;
      }
      for (const [param, value] of [...url.searchParams.entries()]) {
        if (!isSensitiveQueryValue(param, value)) continue;
        findings.push(finding('url-parameter', `${location}.query.${param}`, 'high', value));
        url.searchParams.set(param, REDACTED);
      }
      if (url.hash && /(?:access_token|id_token|token|code|secret|session)=/i.test(url.hash)) {
        findings.push(finding('url-fragment', `${location}.fragment`, 'high', url.hash));
        url.hash = '';
      }
      return { url: url.href, findings, redactions: findings };
    } catch (error) {
      const result = sanitizeText(String(rawUrl || ''), location);
      return { url: result.value, findings: result.findings, redactions: result.findings };
    }
  }

  function sanitizeJsonValue(value, location, findings) {
    if (Array.isArray(value)) return value.map((item, index) => sanitizeJsonValue(item, `${location}[${index}]`, findings));
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string') return value;
      const result = sanitizeText(value, location);
      findings.push(...result.findings);
      return result.value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      const childLocation = `${location}.${key}`;
      if (isSensitiveName(key)) {
        findings.push(finding('body-field', childLocation, 'high', child));
        return [key, REDACTED];
      }
      return [key, sanitizeJsonValue(child, childLocation, findings)];
    }));
  }

  function sanitizeRequestBody(body, contentType = '', location = 'request.body') {
    if (body == null || body === '') return { body: body == null ? body : '', findings: [], safe: true };
    const source = String(body);
    const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
    const findings = [];
    if (type === 'application/json' || /^[\[{]/.test(source.trim())) {
      try {
        const parsed = JSON.parse(source);
        const sanitized = sanitizeJsonValue(parsed, location, findings);
        return { body: JSON.stringify(sanitized), findings, redactions: findings, safe: true };
      } catch (error) {
        // Fall through to non-destructive scanning for malformed JSON.
      }
    }
    if (type === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(source);
      for (const [name, value] of [...params.entries()]) {
        if (!isSensitiveName(name)) continue;
        findings.push(finding('body-field', `${location}.${name}`, 'high', value));
        params.set(name, REDACTED);
      }
      return { body: params.toString(), findings, redactions: findings, safe: true };
    }
    const detected = scanText(source, location);
    return {
      body: detected.length ? REDACTED : source,
      findings: detected,
      redactions: detected,
      safe: detected.length === 0,
      reason: detected.length ? 'Request body could not be structurally sanitized.' : ''
    };
  }

  function sanitizeMetadata(value, location = 'metadata', findings = [], seen = new WeakSet()) {
    if (typeof value === 'string') {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        const result = sanitizeUrl(value, location);
        findings.push(...result.findings);
        return result.url;
      }
      const result = sanitizeText(value, location);
      findings.push(...result.findings);
      return result.value;
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item, index) => sanitizeMetadata(item, `${location}[${index}]`, findings, seen));
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (isSensitiveName(key) && child != null && child !== '') {
        findings.push(finding('metadata-field', childLocation, 'high', child));
        output[key] = REDACTED;
      } else {
        output[key] = sanitizeMetadata(child, childLocation, findings, seen);
      }
    }
    return output;
  }

  function sanitizeCaptureGraph(graph) {
    const copy = structuredClone(graph || {});
    const findings = [];
    const sanitizeRecordUrls = (record, location) => {
      for (const key of ['sourceUrl', 'originalUrl', 'normalizedUrl', 'routeUrl']) {
        if (!record[key]) continue;
        const result = sanitizeUrl(record[key], `${location}.${key}`);
        record[key] = result.url;
        findings.push(...result.findings);
      }
    };
    for (const family of ['missions', 'targets', 'responses', 'documents', 'routes', 'dependencyEdges', 'apiExchanges', 'derivedArtifacts', 'diagnostics']) {
      for (const [index, record] of (copy[family] || []).entries()) {
        const location = `captureGraph.${family}[${index}]`;
        sanitizeRecordUrls(record, location);
        copy[family][index] = sanitizeMetadata(record, location, findings);
      }
    }
    for (const [index, request] of (copy.requests || []).entries()) {
      const location = `captureGraph.requests[${index}]`;
      sanitizeRecordUrls(request, location);
      const headerResult = sanitizeHeaders(request.headers, `${location}.headers`);
      request.headers = headerResult.headers;
      findings.push(...headerResult.findings);
      if (request.requestBody != null) {
        const contentType = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type');
        const bodyResult = sanitizeRequestBody(request.requestBody, contentType ? contentType[1] : '', `${location}.requestBody`);
        request.requestBody = bodyResult.body;
        findings.push(...bodyResult.findings);
        if (bodyResult.findings.length) request.requestBodyHash = null;
      }
      copy.requests[index] = sanitizeMetadata(request, location, findings);
    }
    for (const [index, response] of (copy.responses || []).entries()) {
      const result = sanitizeHeaders(response.headers, `captureGraph.responses[${index}].headers`);
      response.headers = result.headers;
      findings.push(...result.findings);
    }
    copy.privacy = {
      privateByDefault: true,
      safeToShare: false,
      redactionCount: findings.length,
      findings
    };
    return { graph: copy, findings, redactions: findings };
  }

  function inspectRunnableBody(body, mimeType = '', location = 'artifact') {
    const type = String(mimeType || '').toLowerCase();
    const textLike = !type || type.startsWith('text/') || /json|javascript|xml|svg|x-www-form-urlencoded/.test(type);
    if (body == null || !textLike || typeof body !== 'string') {
      return { risky: false, findings: [] };
    }
    const findings = sanitizeText(String(body), location).findings;
    return { risky: findings.length > 0, findings };
  }

  function sanitizeFormSnapshot(summary = {}) {
    const findings = [];
    const sanitized = sanitizeMetadata(summary || {}, 'formSnapshot', findings);
    if (sanitized.redactedFields) {
      findings.push({
        category: 'form-field',
        location: 'formSnapshot.liveDom',
        confidence: 'high',
        maskedPreview: `<redacted:${sanitized.redactedFields} fields>`
      });
    }
    return { summary: sanitized, findings, redactions: findings };
  }

  const api = {
    REDACTED,
    SENSITIVE_HEADERS,
    SENSITIVE_QUERY_PARAMS,
    isSensitiveName,
    isSensitiveQueryValue,
    maskValue,
    scanText,
    sanitizeText,
    sanitizeHeaders,
    sanitizeUrl,
    sanitizeRequestBody,
    sanitizeMetadata,
    sanitizeCaptureGraph,
    inspectRunnableBody,
    sanitizeFormSnapshot
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSavePrivacyGuardrails = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
