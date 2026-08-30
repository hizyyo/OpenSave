import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRoutePlanner, routeKey } = require('../rendered-page-crawler.js');

let now = 1000;
let cancelled = false;
const planner = createRoutePlanner('https://example.test/', {
  now: () => now,
  isCancelled: () => cancelled,
  policy: { maxPages: 5, maxCandidates: 20, maxHistoryStates: 1, maxBytes: 100, maxDurationMs: 1000 }
});

assert.equal(planner.routes[0].decisionReason, 'seed-route');
assert.equal(planner.discover({ url: '/static', baseUrl: 'https://example.test/', elementKind: 'anchor' }).state, 'accepted');
assert.equal(planner.discover({ url: '/app#one', baseUrl: 'https://example.test/app', elementKind: 'anchor' }).transitionKind, 'history');
assert.equal(planner.discover({ url: '/app#two', baseUrl: 'https://example.test/app', elementKind: 'anchor' }).decisionReason, 'state-budget');
assert.equal(planner.discover({ url: 'https://outside.test/', elementKind: 'anchor' }).decisionReason, 'cross-origin');
assert.equal(planner.discover({ url: 'mailto:test@example.test', elementKind: 'anchor' }).decisionReason, 'non-http');
assert.equal(planner.discover({ url: '/download', elementKind: 'anchor', download: true }).decisionReason, 'download-link');
assert.equal(planner.discover({ url: '/submit', elementKind: 'form', formAction: true }).decisionReason, 'not-ordinary-anchor');
assert.equal(planner.discover({ url: '/static', baseUrl: 'https://example.test/', elementKind: 'anchor' }).decisionReason, 'duplicate-route');
assert.notEqual(routeKey('https://example.test/app#one', 'history'), routeKey('https://example.test/app#two', 'history'));
assert.notEqual(routeKey('https://example.test/app#one', 'history'), routeKey('https://example.test/app#one', 'document'));

const seed = planner.takeNext();
planner.complete(seed, { finalUrl: 'https://example.test/home', canonicalUrl: '/canonical', capturedBytes: 60, documentId: 'document-1' });
assert.equal(seed.state, 'captured');
assert.equal(planner.aliases.get('https://example.test/canonical'), seed.id);
const canonicalDuplicate = planner.discover({ url: '/canonical', elementKind: 'anchor' });
assert.equal(canonicalDuplicate.decisionReason, 'duplicate-route');
planner.addBytes(40);
assert.equal(planner.stopReason(), 'byte-budget');

const limited = createRoutePlanner('https://example.test/', { policy: { maxPages: 2, maxCandidates: 4 } });
limited.discover({ url: '/a', elementKind: 'anchor' });
assert.equal(limited.discover({ url: '/b', elementKind: 'anchor' }).decisionReason, 'page-budget');
limited.discover({ url: '/c', elementKind: 'anchor' });
assert.equal(limited.discover({ url: '/d', elementKind: 'anchor' }).decisionReason, 'candidate-budget');

const timed = createRoutePlanner('https://example.test/', { now: () => now, startedAt: now, policy: { maxDurationMs: 10 } });
now += 11;
assert.equal(timed.discover({ url: '/late', elementKind: 'anchor' }).decisionReason, 'time-budget');

const cancellable = createRoutePlanner('https://example.test/', { isCancelled: () => cancelled });
cancelled = true;
assert.equal(cancellable.takeNext(), null);
assert.equal(cancellable.routes[0].decisionReason, 'cancelled');

// Architecture fixtures: static/SSR document routes remain distinct from SPA history states.
const architectures = createRoutePlanner('https://fixture.test/');
const staticPage = architectures.discover({ url: '/static/page-b.html', elementKind: 'anchor', discoveryKind: 'anchor' });
const ssrPage = architectures.discover({ url: '/products/42?view=full', elementKind: 'anchor', discoveryKind: 'anchor' });
const reactState = architectures.discover({ url: '/app#settings', baseUrl: 'https://fixture.test/app', elementKind: 'anchor', discoveryKind: 'anchor' });
assert.equal(staticPage.transitionKind, 'document');
assert.equal(ssrPage.transitionKind, 'document');
assert.equal(reactState.transitionKind, 'history');

// Infinite pagination is represented by one bounded sentinel instead of growing without limit.
const infinite = createRoutePlanner('https://fixture.test/', { policy: { maxPages: 3, maxCandidates: 5 } });
for (let index = 1; index <= 100; index += 1) infinite.discover({ url: `/calendar?page=${index}`, elementKind: 'anchor' });
assert(infinite.routes.some((route) => route.decisionReason === 'page-budget'));
assert(infinite.routes.some((route) => route.decisionReason === 'candidate-budget'));
assert(infinite.routes.length <= 6);

console.log('PASS: rendered route identity, safety decisions, aliases, budgets, and cancellation');
