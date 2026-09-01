import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PROVENANCE,
  createCaptureGraph,
  addMission,
  addTarget,
  addRequest,
  addResponse,
  addBody,
  addDocument,
  addRoute,
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
  validateGraph
} = require('../capture-graph.js');

const graph = createCaptureGraph();
const mission = addMission(graph, { captureMode: 'quick', startedAt: 100 });
const target = addTarget(graph, {
  missionId: mission.id,
  targetType: 'page',
  originalUrl: 'https://example.test/'
});
const route = addRoute(graph, {
  missionId: mission.id,
  originalUrl: 'https://example.test/',
  routeUrl: 'https://example.test/',
  normalizedDocumentUrl: 'https://example.test/',
  transitionKind: 'document',
  discoveryKind: 'seed',
  state: 'accepted',
  decisionReason: 'seed-route'
});

const firstGet = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'https://example.test/api',
  timestamp: 101
});
const post = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'POST',
  originalUrl: 'https://example.test/api',
  headers: { 'content-type': 'application/json' },
  requestBody: '{"variant":2}',
  timestamp: 102
});
assert.notEqual(firstGet.id, post.id, 'GET and POST to one URL must remain distinct');
assert.notEqual(firstGet.requestBodyHash, post.requestBodyHash);

const redirectRequest = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'https://example.test/redirect',
  timestamp: 103
});
const redirectResponse = addResponse(graph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: redirectRequest.id,
  originalUrl: redirectRequest.originalUrl,
  status: 302,
  mimeType: 'text/html',
  timestamp: 104
});
const finalRequest = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'https://example.test/final',
  redirectPredecessorRequestId: redirectRequest.id,
  timestamp: 105
});
redirectRequest.redirectSuccessorRequestId = finalRequest.id;
redirectResponse.redirectSuccessorRequestId = finalRequest.id;
assert.equal(finalRequest.redirectPredecessorRequestId, redirectRequest.id);
assert.equal(redirectResponse.originalUrl, 'https://example.test/redirect');

const responseA = addResponse(graph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: firstGet.id,
  originalUrl: firstGet.originalUrl,
  status: 200,
  mimeType: 'application/json',
  resourceType: 'Fetch',
  timestamp: 106
});
const postResponse = addResponse(graph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: post.id,
  originalUrl: post.originalUrl,
  status: 201,
  mimeType: 'application/json',
  resourceType: 'Fetch',
  timestamp: 106.5
});
const aliasRequest = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'https://cdn.example.test/api-copy',
  timestamp: 107
});
const responseB = addResponse(graph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: aliasRequest.id,
  originalUrl: aliasRequest.originalUrl,
  status: 200,
  mimeType: 'application/json',
  resourceType: 'Fetch',
  timestamp: 108
});
const bodyA = await addBody(graph, {
  missionId: mission.id,
  responseId: responseA.id,
  body: '{"same":true}',
  mimeType: 'application/json',
  provenance: PROVENANCE.OBSERVED
});
const bodyB = await addBody(graph, {
  missionId: mission.id,
  responseId: responseB.id,
  body: '{"same":true}',
  mimeType: 'application/json',
  provenance: PROVENANCE.OBSERVED
});
await addBody(graph, {
  missionId: mission.id,
  responseId: postResponse.id,
  body: '{"posted":true}',
  mimeType: 'application/json',
  provenance: PROVENANCE.OBSERVED
});
assert.equal(bodyA.id, bodyB.id, 'identical bytes must share one blob');
assert.equal(graph.bodies.length, 2);
assert.equal(graph.responses.length, 4, 'sharing a blob must not collapse responses');

addApiExchange(graph, {
  missionId: mission.id,
  requestId: firstGet.id,
  responseId: responseA.id,
  resourceType: 'Fetch'
});
addApiExchange(graph, {
  missionId: mission.id,
  requestId: post.id,
  responseId: postResponse.id,
  resourceType: 'Fetch'
});
addApiExchange(graph, {
  missionId: mission.id,
  requestId: aliasRequest.id,
  responseId: responseB.id,
  resourceType: 'Fetch'
});

const refetchRequest = addRequest(graph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'https://example.test/missing.css',
  provenance: PROVENANCE.REFETCHED,
  timestamp: 109
});
const refetchResponse = addResponse(graph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: refetchRequest.id,
  originalUrl: refetchRequest.originalUrl,
  status: 200,
  mimeType: 'text/css',
  provenance: PROVENANCE.REFETCHED,
  timestamp: 110
});
const refetchedBody = await addBody(graph, {
  missionId: mission.id,
  responseId: refetchResponse.id,
  body: 'body { color: red; }',
  mimeType: 'text/css',
  provenance: PROVENANCE.REFETCHED
});
const derived = await addDerivedArtifact(graph, {
  missionId: mission.id,
  artifactType: 'rewritten-resource',
  body: 'body { color: blue; }',
  mimeType: 'text/css',
  inputEvidenceIds: [refetchResponse.id, refetchedBody.id],
  transform: 'test-rewriter',
  transformVersion: 1
});
const sharedDerived = await addDerivedArtifact(graph, {
  missionId: mission.id,
  artifactType: 'byte-identical-derived-view',
  body: '{"same":true}',
  mimeType: 'application/json',
  inputEvidenceIds: [responseA.id, bodyA.id],
  transform: 'identity-transform',
  transformVersion: 1
});
assert.notEqual(derived.bodyId, refetchedBody.id, 'rewrites must create a derived blob');
assert.equal(sharedDerived.bodyId, bodyA.id, 'byte-identical derived output must share the content blob');
assert.deepEqual(new Set(bodyA.acquisitions.map((item) => item.provenance)), new Set([PROVENANCE.OBSERVED, PROVENANCE.DERIVED]));
assert.equal(graph.bodies.find((body) => body.id === refetchedBody.id).body, 'body { color: red; }');
const document = addDocument(graph, {
  missionId: mission.id,
  targetId: target.id,
  originalUrl: 'https://example.test/',
  bodyId: derived.bodyId,
  provenance: PROVENANCE.DERIVED,
  snapshotVersion: 1,
  stateSummary: { shadowRoots: 1 },
  evidenceRefs: [derived.id]
});
route.state = 'captured';
route.finalUrl = route.routeUrl;
route.documentId = document.id;
route.targetId = target.id;
route.fidelity = 'rendered';
route.idleResult = 'settled';
document.routeId = route.id;
const dependency = addDependencyEdge(graph, {
  missionId: mission.id,
  ownerEvidenceId: document.id,
  targetEvidenceId: refetchResponse.id,
  originalUrl: refetchRequest.originalUrl,
  syntaxKind: 'html-url-attribute',
  rawValue: './missing.css#theme',
  resolvedUrl: `${refetchRequest.originalUrl}#theme`,
  sourceLocation: { domLocation: { tagName: 'link', attribute: 'href' }, byteRange: { start: 10, end: 29 } },
  role: 'stylesheet',
  rewritePolicy: 'block-unresolved-executable'
});
assert.match(document.id, /^document-/);
assert.match(dependency.id, /^edge-/);
assert.equal(dependency.rawValue, './missing.css#theme');
assert.equal(dependency.resolvedUrl, `${refetchRequest.originalUrl}#theme`);
assert.deepEqual(dependency.sourceLocation.byteRange, { start: 10, end: 29 });
assert.equal(dependency.rewritePolicy, 'block-unresolved-executable');
assert.equal(document.snapshotVersion, 1);
assert.equal(document.stateSummary.shadowRoots, 1);

addDiagnostic(graph, {
  missionId: mission.id,
  code: 'observed-body-unavailable',
  severity: 'warning',
  phase: 'capture',
  message: 'Observed response was unavailable before refetch',
  evidenceRefs: [firstGet.id],
  provenance: PROVENANCE.OBSERVED
});

const report = projectReport(graph, {});
assert.equal(report.captureGraph.schemaVersion, 1);
assert.equal(report.captureGraph.provenance.observed.responses, 4);
assert.equal(report.captureGraph.provenance.refetched.responses, 1);
assert.equal(report.captureGraph.provenance.derived.artifacts, 2);
assert.equal(report.captureGraph.provenance.derived.bodies, 2);
assert.equal(report.captureGraph.refetchedResources.length, 1);
assert.equal(report.captureGraph.requestVariants.find((item) => item.url === 'https://example.test/api').variants.length, 2);
assert.deepEqual(report.captureGraph.bodyAliases[0].responses.map((item) => item.url), [
  'https://example.test/api',
  'https://cdn.example.test/api-copy'
]);
assert.equal(report.captureGraph.redirects[0].predecessorUrl, 'https://example.test/redirect');
assert.equal(report.captureGraph.routes[0].fidelity, 'rendered');

const legacyBodies = projectV1Bodies(graph);
assert.deepEqual(legacyBodies.map((body) => body.url), [
  'https://example.test/api',
  'https://cdn.example.test/api-copy',
  'https://example.test/missing.css'
]);
assert.notStrictEqual(legacyBodies[0], graph.bodies[0], 'V1 projection must not expose mutable graph records');

const legacySnapshots = projectV1ApiSnapshots(graph);
assert.deepEqual(legacySnapshots.map(({ method, url }) => ({ method, url })), [
  { method: 'GET', url: 'https://example.test/api' },
  { method: 'GET', url: 'https://cdn.example.test/api-copy' },
  { method: 'POST', url: 'https://example.test/api' }
]);
const replayExchanges = projectReplayExchanges(graph);
assert.deepEqual(replayExchanges.map(({ method, url, status }) => ({ method, url, status })), [
  { method: 'GET', url: 'https://example.test/api', status: 200 },
  { method: 'POST', url: 'https://example.test/api', status: 201 },
  { method: 'GET', url: 'https://cdn.example.test/api-copy', status: 200 }
]);
assert.match(replayExchanges[1].requestBodyHash, /^sha256:/);
assert.equal(replayExchanges[1].contentType, 'application/json');
assert.deepEqual(projectReplayMisses(graph), []);
const invalidReplayGraph = structuredClone(graph);
const invalidRequest = addRequest(invalidReplayGraph, {
  missionId: mission.id,
  targetId: target.id,
  method: 'GET',
  originalUrl: 'not a valid URL'
});
const invalidResponse = addResponse(invalidReplayGraph, {
  missionId: mission.id,
  targetId: target.id,
  requestId: invalidRequest.id,
  originalUrl: 'not a valid URL',
  status: 200,
  bodyState: 'not-captured'
});
addApiExchange(invalidReplayGraph, { missionId: mission.id, requestId: invalidRequest.id, responseId: invalidResponse.id, resourceType: 'Fetch' });
assert.equal(projectReplayMisses(invalidReplayGraph).at(-1).reasonCode, 'invalid-request-url');
const renderedPages = projectRenderedPages(graph);
assert.equal(renderedPages.length, 1);
assert.equal(renderedPages[0].routeId, route.id);
assert.equal(renderedPages[0].body, 'body { color: blue; }');

assert.deepEqual(validateGraph(graph), []);
const invalid = structuredClone(graph);
invalid.requests[0].provenance = 'guessed';
assert.match(validateGraph(invalid)[0], /provenance/);
const unsupportedReader = structuredClone(graph);
unsupportedReader.minimumReaderVersion = 2;
assert.match(validateGraph(unsupportedReader)[0], /minimumReaderVersion/);
const brokenReference = structuredClone(graph);
brokenReference.documents[0].bodyId = 'body-missing';
assert(validateGraph(brokenReference).some((error) => error.includes('body-missing')));
const brokenSnapshot = structuredClone(graph);
brokenSnapshot.documents[0].snapshotVersion = 2;
assert(validateGraph(brokenSnapshot).some((error) => error.includes('snapshotVersion')));

console.log('PASS: capture graph schema, provenance, aliases, redirects, variants, and V1 parity');
