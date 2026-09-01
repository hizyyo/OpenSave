(function initializeReplayMatcher(globalScope) {
  'use strict';

  const EMPTY_BODY_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function normalizeUrl(value, baseUrl) {
    const url = new URL(value, baseUrl || undefined);
    url.hash = '';
    return url.href;
  }

  function pathKey(value, baseUrl) {
    const url = new URL(value, baseUrl || undefined);
    url.hash = '';
    return `${url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname}${url.search}`;
  }

  function normalizeContentType(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
  }

  function headerValue(headers, name) {
    if (!headers) return '';
    const expected = name.toLowerCase();
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected);
    return entry ? entry[1] : '';
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value || ''));
  }

  function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  function sha256Hex(value) {
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
    const bytes = value instanceof Uint8Array ? value : utf8Bytes(value);
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
    return hash.map((item) => item.toString(16).padStart(8, '0')).join('');
  }

  async function bodyText(request, suppliedBody) {
    if (suppliedBody != null) {
      if (typeof suppliedBody === 'string') return suppliedBody;
      if (suppliedBody instanceof URLSearchParams) return suppliedBody.toString();
    }
    if (!request || request.method === 'GET' || request.method === 'HEAD') return '';
    try { return await request.clone().text(); } catch (error) { return null; }
  }

  function unsupportedReason(request, baseUrl) {
    const method = String(request.method || 'GET').toUpperCase();
    const headers = request.headers;
    if (request.url) {
      try {
        const url = new URL(request.url, baseUrl || undefined);
        if (!/^https?:$/.test(url.protocol)) return 'unsupported-url-scheme';
      } catch (error) {
        return 'invalid-request-url';
      }
    }
    const upgrade = headerValue(headers, 'upgrade').toLowerCase();
    const accept = headerValue(headers, 'accept').toLowerCase();
    if (upgrade === 'websocket' || request.destination === 'websocket') return 'websocket';
    if (accept.includes('text/event-stream')) return 'sse';
    if (headerValue(headers, 'range')) return 'range-request';
    if (request.destination === 'beacon' || request.initiatorType === 'beacon') return 'beacon';
    if (request.body && typeof request.body.getReader === 'function' && method !== 'GET' && method !== 'HEAD' && request.__siteSaverStreamingBody) return 'streaming-request';
    if (!['GET', 'HEAD', 'POST'].includes(method)) return 'unknown-mutation';
    if (method === 'POST') {
      const contentType = normalizeContentType(request.contentType || headerValue(headers, 'content-type'));
      if (contentType && contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded' && contentType !== 'multipart/form-data') return 'unsupported-post-content-type';
    }
    return '';
  }

  async function identityFor(request, suppliedBody, baseUrl) {
    const method = String(request.method || 'GET').toUpperCase();
    const url = normalizeUrl(request.url, baseUrl);
    const body = await bodyText(request, suppliedBody);
    return {
      method,
      url,
      pathKey: pathKey(url),
      contentType: normalizeContentType(headerValue(request.headers, 'content-type')),
      bodyHash: body == null ? null : `sha256:${sha256Hex(body)}`,
      body
    };
  }

  function createMatcher(records, options = {}) {
    const entries = records.map((record, index) => ({
      ...record,
      index,
      sequence: Number.isFinite(record.sequence) ? record.sequence : index + 1,
      normalizedUrl: normalizeUrl(record.url),
      pathKey: record.pathKey || pathKey(record.url),
      contentType: normalizeContentType(record.contentType || record.requestContentType),
      bodyHash: record.bodyHash || record.requestBodyHash || EMPTY_BODY_HASH
    }));
    const consumed = new Set();

    return {
      matchIdentity(identity) {
        const reason = unsupportedReason(identity, options.baseUrl);
        if (reason) return { snapshot: null, identity, miss: { reasonCode: reason, evidence: { method: identity.method, url: identity.url } } };
        const normalized = {
          ...identity,
          method: String(identity.method || 'GET').toUpperCase(),
          url: normalizeUrl(identity.url, options.baseUrl),
          pathKey: identity.pathKey || pathKey(identity.url, options.baseUrl),
          contentType: normalizeContentType(identity.contentType || headerValue(identity.headers, 'content-type')),
          bodyHash: identity.bodyHash || `sha256:${sha256Hex(identity.body || '')}`
        };
        return select(normalized);
      },
      async match(request, suppliedBody, baseUrl) {
        const reason = unsupportedReason(request, baseUrl);
        let identity;
        try {
          identity = await identityFor(request, suppliedBody, baseUrl);
        } catch (error) {
          return { snapshot: null, identity: null, miss: { reasonCode: 'request-body-unreadable', evidence: { error: error.message } } };
        }
        if (reason) return { snapshot: null, identity, miss: { reasonCode: reason, evidence: { method: identity.method, url: identity.url } } };
        if (identity.bodyHash == null) return { snapshot: null, identity, miss: { reasonCode: 'request-body-unreadable', evidence: { method: identity.method, url: identity.url } } };

        return select(identity);
      },
      reset() { consumed.clear(); },
      pending() { return entries.filter((entry) => !consumed.has(entry.index)); },
      records: entries,
      options
    };

    function select(identity) {
      const exact = entries.filter((entry) => entry.normalizedUrl === identity.url && entry.method === identity.method && entry.contentType === identity.contentType && entry.bodyHash === identity.bodyHash);
      const requestOrigin = new URL(identity.url).origin;
      const pathMatches = requestOrigin === options.runtimeOrigin
        ? entries.filter((entry) => entry.pathKey === identity.pathKey && entry.method === identity.method && entry.contentType === identity.contentType && entry.bodyHash === identity.bodyHash)
        : [];
      const candidates = exact.length ? exact : pathMatches;
      const origins = new Set(candidates.map((entry) => new URL(entry.normalizedUrl).origin));
      if (!exact.length && origins.size > 1) {
        return { snapshot: null, identity, miss: { reasonCode: 'ambiguous', evidence: { candidateCount: candidates.length, origins: [...origins], pathKey: identity.pathKey } } };
      }
      if (!candidates.length) return { snapshot: null, identity, miss: { reasonCode: 'not-found', evidence: { method: identity.method, url: identity.url, pathKey: identity.pathKey, contentType: identity.contentType, bodyHash: identity.bodyHash } } };

      const available = candidates.filter((entry) => !consumed.has(entry.index)).sort((left, right) => left.sequence - right.sequence || left.index - right.index);
      if (!available.length) return { snapshot: null, identity, miss: { reasonCode: 'repeat-exhausted', evidence: { candidateCount: candidates.length, pathKey: identity.pathKey } } };
      const firstSequence = available[0].sequence;
      const sameSequence = available.filter((entry) => entry.sequence === firstSequence);
      if (sameSequence.length > 1) return { snapshot: null, identity, miss: { reasonCode: 'ambiguous', evidence: { candidateCount: sameSequence.length, sequence: firstSequence, pathKey: identity.pathKey } } };
      const snapshot = available[0];
      consumed.add(snapshot.index);
      return { snapshot, identity, miss: null };
    }
  }

  const api = { EMPTY_BODY_HASH, normalizeUrl, pathKey, normalizeContentType, headerValue, sha256Hex, identityFor, createMatcher, unsupportedReason };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveReplayMatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
