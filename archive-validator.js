(function initializeArchiveValidator(globalScope) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DEFAULT_BUDGET = Object.freeze({
    maxRoutes: 40,
    maxDurationMs: 45000,
    maxRouteDurationMs: 7000,
    maxServiceWorkerDurationMs: 2000
  });

  function normalizePath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    try { return decodeURIComponent(path); } catch (error) { return path; }
  }

  function diagnostic(input) {
    return {
      category: input.category || 'validator-infrastructure',
      code: input.code || 'unknown-validation-failure',
      severity: input.severity || 'warning',
      message: input.message || '',
      routeId: input.routeId || null,
      path: input.path || null,
      url: input.url || null,
      evidenceRefs: [...new Set(input.evidenceRefs || [])],
      evidence: input.evidence || null
    };
  }

  function scanHtml(path, html) {
    const diagnostics = [];
    if (/\bintegrity\s*=\s*["'][^"']+["']/i.test(html)) {
      diagnostics.push(diagnostic({
        category: 'rewrite-failure',
        code: 'stale-subresource-integrity',
        severity: 'warning',
        path,
        message: 'Localized HTML still contains a stale integrity attribute.'
      }));
    }

    const scripts = [];
    const expression = /<script\b([^>]*)>/gi;
    let match;
    while ((match = expression.exec(html)) !== null) {
      const source = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!source) continue;
      const value = source[1].trim();
      scripts.push(value);
      if (/^(?:https?:)?\/\//i.test(value)) {
        diagnostics.push(diagnostic({
          category: 'rewrite-failure',
          code: 'external-executable-reference',
          severity: 'warning',
          path,
          url: value,
          message: 'Localized HTML still references an external executable script.'
        }));
      }
    }

    const seen = new Set();
    for (const source of scripts) {
      const key = source.replace(/#.*$/, '');
      if (seen.has(key)) {
        diagnostics.push(diagnostic({
          category: 'rewrite-failure',
          code: 'duplicate-executable-reference',
          severity: 'warning',
          path,
          url: source,
          message: 'Localized HTML loads the same executable script more than once.'
        }));
      }
      seen.add(key);
    }
    return diagnostics;
  }

  function inspectArchive(input = {}) {
    const files = input.files instanceof Map
      ? input.files
      : new Map((input.files || []).map((file) => [normalizePath(file.path || file.name), file]));
    const diagnostics = [];
    for (const required of input.requiredFiles || []) {
      const path = normalizePath(required.path || required);
      if (files.has(path)) continue;
      diagnostics.push(diagnostic({
        category: 'rewrite-failure',
        code: 'required-file-missing',
        severity: required.critical ? 'error' : 'warning',
        path,
        evidenceRefs: required.evidenceRefs || [],
        message: `Required archive file is missing: ${path}`
      }));
    }
    for (const [path, file] of files) {
      if (!/\.html?$/i.test(path) || typeof file.text !== 'string') continue;
      diagnostics.push(...scanHtml(path, file.text));
    }
    return diagnostics;
  }

  function inputDiagnostics(input = {}) {
    const diagnostics = [];
    const report = input.report || {};
    for (const item of report.unresolvedResources || []) {
      diagnostics.push(diagnostic({ category: 'capture-miss', code: 'capture-resource-miss', severity: 'warning', url: item.url, message: item.reason || 'Required resource was not captured.', evidenceRefs: item.evidenceRefs || [] }));
    }
    for (const item of report.unavailablePages || []) {
      diagnostics.push(diagnostic({ category: 'capture-miss', code: 'capture-route-miss', severity: 'warning', url: item.url, message: item.reason || 'Route was not captured.', evidenceRefs: item.evidenceRefs || [] }));
    }
    for (const item of input.replayMisses || []) {
      diagnostics.push(diagnostic({ category: 'capture-miss', code: `replay-${item.reasonCode || 'unsupported'}`, severity: 'warning', url: item.evidence && item.evidence.url, message: `Captured request cannot be replayed: ${item.reasonCode || 'unsupported'}.`, evidenceRefs: item.evidenceRefs || [], evidence: item.evidence || null }));
    }
    for (const item of report.privacy && report.privacy.exclusions || []) {
      diagnostics.push(diagnostic({ category: 'privacy-risk', code: 'private-artifact-excluded', severity: 'warning', path: item.location || null, message: 'An artifact was excluded because it may contain private data.', evidence: { kind: item.kind || 'artifact', reason: item.reason || 'private-data-risk' } }));
    }
    for (const route of input.routes || []) {
      if (route.state !== 'failed') continue;
      diagnostics.push(diagnostic({ category: 'capture-miss', code: 'captured-route-failed', severity: 'warning', routeId: route.id || route.routeId, url: route.routeUrl || route.url, message: route.decisionReason || 'Route capture failed.', evidenceRefs: [route.id || route.routeId].filter(Boolean) }));
    }
    return diagnostics;
  }

  function createPlan(input = {}) {
    const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}) };
    const routes = (input.routes || []).slice(0, budget.maxRoutes).map((route, index) => ({
      routeId: route.routeId || `route-${index + 1}`,
      url: route.url,
      localPath: normalizePath(route.localPath || ''),
      expectedMarker: route.expectedMarker || route.routeId || `route-${index + 1}`,
      evidenceRefs: [...new Set(route.evidenceRefs || [])]
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      root: { url: input.rootUrl || '/', expectedMarker: input.rootMarker || 'root' },
      routes,
      requiredFiles: (input.requiredFiles || []).map((item) => typeof item === 'string' ? { path: normalizePath(item), critical: false, evidenceRefs: [] } : { ...item, path: normalizePath(item.path) }),
      budget,
      truncatedRouteCount: Math.max(0, (input.routes || []).length - routes.length)
    };
  }

  function finalize(input = {}) {
    const diagnostics = (input.diagnostics || []).map(diagnostic);
    if (input.plan && input.plan.truncatedRouteCount) {
      diagnostics.push(diagnostic({ category: 'validator-infrastructure', code: 'validation-route-budget', severity: 'warning', message: `${input.plan.truncatedRouteCount} route(s) exceeded the validation budget.`, evidence: { truncatedRouteCount: input.plan.truncatedRouteCount } }));
    }
    const consequential = diagnostics.filter((item) => item.severity !== 'info');
    const status = input.cancelled
      ? 'cancelled'
      : consequential.some((item) => item.severity === 'error')
        ? 'failed'
        : consequential.length
          ? 'partial'
          : 'ready';
    const categoryCounts = diagnostics.reduce((counts, item) => ({ ...counts, [item.category]: (counts[item.category] || 0) + 1 }), {});
    return {
      schemaVersion: SCHEMA_VERSION,
      status,
      startedAt: input.startedAt || null,
      completedAt: input.completedAt || null,
      durationMs: input.durationMs || 0,
      zeroEgressVerified: Boolean(input.zeroEgressVerified),
      serviceWorkerControlled: Boolean(input.serviceWorkerControlled),
      checkedRoutes: input.checkedRoutes || 0,
      totalRoutes: input.totalRoutes || 0,
      requiredFilesChecked: input.requiredFilesChecked || 0,
      issueCount: consequential.length,
      infoCount: diagnostics.length - consequential.length,
      categoryCounts,
      diagnostics,
      routes: input.routeResults || [],
      overhead: input.overhead || { durationMs: input.durationMs || 0, routeCount: input.checkedRoutes || 0 }
    };
  }

  const api = { SCHEMA_VERSION, DEFAULT_BUDGET, normalizePath, diagnostic, scanHtml, inspectArchive, inputDiagnostics, createPlan, finalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveArchiveValidator = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
