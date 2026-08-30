(function initializeRenderedPageCrawler(globalScope) {
  'use strict';

  const DEFAULT_POLICY = Object.freeze({
    maxPages: 40,
    maxCandidates: 200,
    maxDurationMs: 2 * 60 * 1000,
    maxRouteDurationMs: 15 * 1000,
    maxBytes: 300 * 1024 * 1024,
    maxHistoryStates: 40,
    networkIdleMs: 500,
    domIdleMs: 500
  });

  function routeUrl(value, baseUrl) {
    return new URL(value, baseUrl).href;
  }

  function documentUrl(value, baseUrl) {
    const url = new URL(value, baseUrl);
    url.hash = '';
    return url.href;
  }

  function routeKey(value, transitionKind = 'document', baseUrl) {
    return `${transitionKind}:${transitionKind === 'history' ? routeUrl(value, baseUrl) : documentUrl(value, baseUrl)}`;
  }

  function createRoutePlanner(seedUrl, options = {}) {
    const seed = new URL(seedUrl);
    const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
    const now = options.now || Date.now;
    const isCancelled = options.isCancelled || (() => false);
    const startedAt = options.startedAt ?? now();
    const routes = [];
    const queue = [];
    const acceptedByKey = new Map();
    const aliases = new Map();
    let candidateBudgetRecord = null;
    let nextId = 1;
    let acceptedPages = 0;
    let historyStates = 0;
    let capturedBytes = 0;

    const makeRecord = (input, state, reason) => {
      const record = {
        id: input.id || `route-${nextId++}`,
        originalUrl: input.originalUrl || input.url || '',
        routeUrl: input.routeUrl || '',
        normalizedDocumentUrl: input.normalizedDocumentUrl || '',
        transitionKind: input.transitionKind || 'document',
        discoveryKind: input.discoveryKind || 'anchor',
        discoveredFromRouteId: input.discoveredFromRouteId || null,
        discoveredFromUrl: input.discoveredFromUrl || null,
        sourceLocation: input.sourceLocation || null,
        state,
        decisionReason: reason,
        finalUrl: null,
        canonicalUrl: null,
        aliasRouteIds: [],
        targetId: null,
        documentId: null,
        idleResult: null,
        fidelity: null,
        capturedBytes: 0,
        startedAt: null,
        completedAt: state === 'skipped' ? now() : null
      };
      routes.push(record);
      return record;
    };

    const terminalBudgetReason = () => {
      if (isCancelled()) return 'cancelled';
      if (now() - startedAt >= policy.maxDurationMs) return 'time-budget';
      if (capturedBytes >= policy.maxBytes) return 'byte-budget';
      return null;
    };

    const discover = (input = {}) => {
      const originalUrl = input.url || input.originalUrl || '';
      if (routes.length >= policy.maxCandidates) {
        if (!candidateBudgetRecord) candidateBudgetRecord = makeRecord({ ...input, originalUrl }, 'skipped', 'candidate-budget');
        return candidateBudgetRecord;
      }
      if (input.elementKind && input.elementKind !== 'anchor') return makeRecord({ ...input, originalUrl }, 'skipped', 'not-ordinary-anchor');
      if (input.download) return makeRecord({ ...input, originalUrl }, 'skipped', 'download-link');
      if (input.formAction) return makeRecord({ ...input, originalUrl }, 'skipped', 'form-navigation');
      if (input.target && !['_self', ''].includes(String(input.target).toLowerCase())) return makeRecord({ ...input, originalUrl }, 'skipped', 'non-self-target');
      if (!String(originalUrl).trim()) return makeRecord({ ...input, originalUrl }, 'skipped', 'empty-url');
      let url;
      try {
        url = new URL(originalUrl, input.baseUrl || seed.href);
      } catch (error) {
        return makeRecord({ ...input, originalUrl }, 'skipped', 'invalid-url');
      }
      if (!['http:', 'https:'].includes(url.protocol)) return makeRecord({ ...input, originalUrl, routeUrl: url.href }, 'skipped', 'non-http');
      if (url.origin !== seed.origin) return makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl: documentUrl(url.href) }, 'skipped', 'cross-origin');
      const transitionKind = input.transitionKind || (url.hash && documentUrl(url.href) === documentUrl(input.baseUrl || seed.href) ? 'history' : 'document');
      const normalizedDocumentUrl = documentUrl(url.href);
      const key = routeKey(url.href, transitionKind);
      const duplicate = acceptedByKey.get(key);
      if (duplicate) {
        const record = makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl, transitionKind }, 'skipped', 'duplicate-route');
        record.aliasRouteIds.push(duplicate.id);
        duplicate.aliasRouteIds.push(record.id);
        return record;
      }
      const budgetReason = terminalBudgetReason();
      if (budgetReason) return makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl, transitionKind }, 'skipped', budgetReason);
      if (acceptedPages >= policy.maxPages) return makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl, transitionKind }, 'skipped', 'page-budget');
      if (transitionKind === 'history' && historyStates >= policy.maxHistoryStates) return makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl, transitionKind }, 'skipped', 'state-budget');

      const record = makeRecord({ ...input, originalUrl, routeUrl: url.href, normalizedDocumentUrl, transitionKind }, 'accepted', 'same-origin-anchor');
      record.countedHistoryState = transitionKind === 'history';
      acceptedByKey.set(key, record);
      acceptedPages += 1;
      if (transitionKind === 'history') historyStates += 1;
      queue.push(record);
      return record;
    };

    const takeNext = () => {
      const budgetReason = terminalBudgetReason();
      if (budgetReason) {
        for (const route of queue.splice(0)) {
          route.state = 'skipped';
          route.decisionReason = budgetReason;
          route.completedAt = now();
        }
        return null;
      }
      const route = queue.shift() || null;
      if (route) {
        route.state = 'visiting';
        route.decisionReason = 'rendered-navigation';
        route.startedAt = now();
      }
      return route;
    };

    const complete = (route, result = {}) => {
      if (!route) return null;
      const finalUrl = routeUrl(result.finalUrl || route.routeUrl);
      const canonicalUrl = result.canonicalUrl ? routeUrl(result.canonicalUrl, finalUrl) : null;
      const bytes = Math.max(0, Number(result.capturedBytes || 0));
      capturedBytes += bytes;
      Object.assign(route, {
        state: 'captured',
        decisionReason: result.reason || 'rendered-captured',
        finalUrl,
        canonicalUrl,
        targetId: result.targetId || null,
        documentId: result.documentId || null,
        idleResult: result.idleResult || 'settled',
        fidelity: result.fidelity || 'rendered',
        capturedBytes: bytes,
        completedAt: now()
      });
      for (const alias of [route.routeUrl, result.finalUrl, result.canonicalUrl].filter(Boolean)) {
        const absoluteAlias = routeUrl(alias, finalUrl);
        aliases.set(absoluteAlias, route.id);
        const key = routeKey(absoluteAlias, route.transitionKind);
        const duplicate = acceptedByKey.get(key);
        if (duplicate && duplicate !== route) {
          duplicate.state = 'skipped';
          duplicate.decisionReason = alias === result.canonicalUrl ? 'canonical-alias' : 'redirect-alias';
          duplicate.completedAt = now();
          if (!route.aliasRouteIds.includes(duplicate.id)) route.aliasRouteIds.push(duplicate.id);
          const queueIndex = queue.indexOf(duplicate);
          if (queueIndex >= 0) queue.splice(queueIndex, 1);
        }
        acceptedByKey.set(key, route);
      }
      return route;
    };

    const fail = (route, reason, result = {}) => {
      if (!route) return null;
      Object.assign(route, {
        state: reason === 'cancelled' || /budget$/.test(reason) ? 'skipped' : 'failed',
        decisionReason: reason || 'navigation-failed',
        finalUrl: result.finalUrl || route.finalUrl,
        idleResult: result.idleResult || null,
        fidelity: result.fidelity || null,
        completedAt: now()
      });
      return route;
    };

    const setTransition = (route, transitionKind) => {
      if (!route || route.transitionKind === transitionKind) return true;
      if (transitionKind === 'history' && !route.countedHistoryState) {
        if (historyStates >= policy.maxHistoryStates) {
          fail(route, 'state-budget');
          return false;
        }
        historyStates += 1;
        route.countedHistoryState = true;
      }
      route.transitionKind = transitionKind;
      acceptedByKey.set(routeKey(route.routeUrl, transitionKind), route);
      return true;
    };

    discover({
      url: seed.href,
      baseUrl: seed.href,
      transitionKind: 'document',
      discoveryKind: 'seed',
      elementKind: 'anchor'
    }).decisionReason = 'seed-route';

    return {
      policy,
      startedAt,
      routes,
      aliases,
      discover,
      takeNext,
      complete,
      fail,
      setTransition,
      addBytes(bytes) { capturedBytes += Math.max(0, Number(bytes || 0)); },
      budgetSnapshot() {
        return { acceptedPages, historyStates, candidates: routes.length, capturedBytes, elapsedMs: now() - startedAt };
      },
      stopReason: terminalBudgetReason
    };
  }

  const api = { DEFAULT_POLICY, routeUrl, documentUrl, routeKey, createRoutePlanner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveRenderedPageCrawler = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
