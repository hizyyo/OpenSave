import assert from 'node:assert/strict';
import ArchiveValidator from '../archive-validator.js';

const files = new Map([
  ['index.html', { text: '<!doctype html><script src="/app.js" integrity="sha384-old"></script><script src="https://external.test/app.js"></script><script src="/app.js"></script>' }],
  ['app.js', { text: 'console.log("ok")' }]
]);
const plan = ArchiveValidator.createPlan({
  rootUrl: '/',
  rootMarker: 'root',
  routes: [
    { routeId: 'route-a', url: 'https://source.test/a', localPath: '/assets/source.test/a.html', expectedMarker: 'route-a' },
    { routeId: 'route-b', url: 'https://source.test/b', localPath: '/assets/source.test/b.html', expectedMarker: 'route-b' }
  ],
  requiredFiles: [{ path: '/index.html', critical: true }, { path: '/missing.css', critical: true }],
  budget: { maxRoutes: 1 }
});
assert.equal(plan.routes.length, 1);
assert.equal(plan.truncatedRouteCount, 1);
assert.equal(plan.routes[0].localPath, 'assets/source.test/a.html');

const staticDiagnostics = ArchiveValidator.inspectArchive({ files, requiredFiles: plan.requiredFiles });
assert(staticDiagnostics.some((item) => item.code === 'required-file-missing' && item.path === 'missing.css'));
assert(staticDiagnostics.some((item) => item.code === 'stale-subresource-integrity'));
assert(staticDiagnostics.some((item) => item.code === 'external-executable-reference'));
assert(staticDiagnostics.some((item) => item.code === 'duplicate-executable-reference'));

const captureDiagnostics = ArchiveValidator.inputDiagnostics({
  report: { unresolvedResources: [{ url: 'https://source.test/missing.png', reason: 'HTTP 404' }] },
  routes: [{ id: 'route-b', routeUrl: 'https://source.test/b', state: 'failed', decisionReason: 'rendered-navigation-failed' }],
  replayMisses: [{ reasonCode: 'response-body-unavailable', evidenceRefs: ['response-1'], evidence: { url: 'https://source.test/api' } }]
});
assert.deepEqual(new Set(captureDiagnostics.map((item) => item.category)), new Set(['capture-miss']));
assert(captureDiagnostics.some((item) => item.code === 'capture-resource-miss'));
assert(captureDiagnostics.some((item) => item.code === 'captured-route-failed'));

const ready = ArchiveValidator.finalize({ zeroEgressVerified: true, serviceWorkerControlled: true, checkedRoutes: 2, totalRoutes: 2, diagnostics: [] });
assert.equal(ready.status, 'ready');
const partial = ArchiveValidator.finalize({ diagnostics: [{ category: 'capture-miss', code: 'capture-resource-miss', severity: 'warning' }] });
assert.equal(partial.status, 'partial');
const failed = ArchiveValidator.finalize({ diagnostics: [{ category: 'replay-runtime-failure', code: 'runtime-exception', severity: 'error' }] });
assert.equal(failed.status, 'failed');
const cancelled = ArchiveValidator.finalize({ cancelled: true, diagnostics: [] });
assert.equal(cancelled.status, 'cancelled');

console.log('PASS: validation plans, seeded defects, typed diagnostics, and result classification');
