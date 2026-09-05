import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CaptureQuotaError,
  createMemoryCaptureStorage
} = require('../capture-storage.js');
const CaptureGraph = require('../capture-graph.js');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

async function readStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

const storage = createMemoryCaptureStorage();
await storage.initialize();
const graph = CaptureGraph.createCaptureGraph();
const graphMission = CaptureGraph.addMission(graph, { id: 'capture-graph-storage' });
const graphRequest = CaptureGraph.addRequest(graph, { missionId: graphMission.id, originalUrl: 'https://storage.test/body' });
const graphResponse = CaptureGraph.addResponse(graph, { missionId: graphMission.id, requestId: graphRequest.id, originalUrl: graphRequest.originalUrl, status: 200 });
await storage.createMission({ id: graphMission.id, graph });
const durableGraphBody = await CaptureGraph.addBody(graph, {
  missionId: graphMission.id,
  responseId: graphResponse.id,
  body: Buffer.from('durable graph body').toString('base64'),
  base64Encoded: true,
  mimeType: 'text/plain'
}, { bodyStore: storage, chunkSize: 4 });
assert.equal(durableGraphBody.body, null, 'durable graph metadata must not retain inline bytes');
assert.ok(durableGraphBody.storageKey);
assert.equal(await (await storage.readBody(durableGraphBody.storageKey)).text(), 'durable graph body');
assert.equal(CaptureGraph.projectV1Bodies(graph)[0].storageKey, durableGraphBody.storageKey);
assert.deepEqual(CaptureGraph.validateGraph(graph), []);

const concurrentRequestA = CaptureGraph.addRequest(graph, { missionId: graphMission.id, originalUrl: 'https://storage.test/alias-a' });
const concurrentRequestB = CaptureGraph.addRequest(graph, { missionId: graphMission.id, originalUrl: 'https://storage.test/alias-b' });
const concurrentResponseA = CaptureGraph.addResponse(graph, { missionId: graphMission.id, requestId: concurrentRequestA.id, originalUrl: concurrentRequestA.originalUrl, status: 200 });
const concurrentResponseB = CaptureGraph.addResponse(graph, { missionId: graphMission.id, requestId: concurrentRequestB.id, originalUrl: concurrentRequestB.originalUrl, status: 200 });
const concurrentBodies = await Promise.all([concurrentResponseA, concurrentResponseB].map((response) => CaptureGraph.addBody(graph, {
  missionId: graphMission.id,
  responseId: response.id,
  body: 'concurrent duplicate',
  mimeType: 'text/plain'
}, { bodyStore: storage, chunkSize: 4 })));
assert.equal(concurrentBodies[0].id, concurrentBodies[1].id, 'parallel duplicate commits must converge on one graph body');
assert.equal(graph.bodies.filter((body) => body.contentHash === concurrentBodies[0].contentHash).length, 1);
assert.deepEqual(CaptureGraph.validateGraph(graph), []);
await storage.cleanupMission(graphMission.id);

await storage.createMission({ id: 'capture-lifecycle', graph: { marker: 'before-restart' } });
const writer = await storage.beginBody('capture-lifecycle', 6);
await writer.write(new Uint8Array([1, 2]));
await writer.write(new Uint8Array([3, 4, 5, 6]));
const first = await writer.commit(HASH_A, { size: 6, mimeType: 'application/octet-stream' });
assert.equal(first.size, 6);
assert.deepEqual(await readStream(await storage.openBody(first)), new Uint8Array([1, 2, 3, 4, 5, 6]));

await storage.createMission({ id: 'capture-alias' });
const duplicateWriter = await storage.beginBody('capture-alias', 6);
await duplicateWriter.write(new Uint8Array([1, 2, 3, 4, 5, 6]));
const duplicate = await duplicateWriter.commit(HASH_A, { size: 6 });
assert.equal(duplicate.duplicate, true, 'identical content hashes must share one stored body');
assert.equal(duplicate.storageKey, first.storageKey);
assert.equal(storage.database.bodies.size, 1);
assert.equal(storage.database.temporaryBodies.size, 0, 'duplicate commit must remove its temporary cleanup record');
await storage.cleanupMission('capture-lifecycle');
assert.equal(await storage.hasBody(HASH_A), true, 'shared bodies must survive cleanup of one owner');
await storage.cleanupMission('capture-alias');
assert.equal(await storage.hasBody(HASH_A), false, 'last owner cleanup must remove body chunks');

const sharedDatabase = createMemoryCaptureStorage().database;
const beforeRestart = createMemoryCaptureStorage({ database: sharedDatabase });
await beforeRestart.createMission({ id: 'capture-restart', graph: { marker: 'durable-metadata' }, pendingWork: [{ responseId: 'response-1' }] });
const interruptedWriter = await beforeRestart.beginBody('capture-restart');
await interruptedWriter.write(new Uint8Array([9, 9, 9]));
const afterRestart = createMemoryCaptureStorage({ database: sharedDatabase });
const recovered = await afterRestart.recoverInterruptedMissions('test-restart');
assert.equal(recovered.length, 1);
assert.equal(recovered[0].state, 'interrupted');
assert.equal(recovered[0].graph.marker, 'durable-metadata');
assert.equal(recovered[0].recovery.reason, 'test-restart');
assert.equal(sharedDatabase.temporaryBodies.size, 0, 'restart must remove uncommitted body chunks');

await afterRestart.createMission({ id: 'capture-cancel' });
const cancelledWriter = await afterRestart.beginBody('capture-cancel');
await cancelledWriter.write(new Uint8Array([7, 8]));
await cancelledWriter.commit(HASH_B, { size: 2 });
assert.equal((await afterRestart.cancelMission('capture-cancel', 'test-cancel')).cancelled, true);
assert.equal(await afterRestart.getMission('capture-cancel'), null);
assert.equal(await afterRestart.hasBody(HASH_B), false, 'cancellation must remove committed private bodies');

const quotaStorage = createMemoryCaptureStorage({ quota: 4 });
await quotaStorage.createMission({ id: 'capture-quota', graph: { partial: true } });
await assert.rejects(
  () => quotaStorage.beginBody('capture-quota', 16 * 1024 * 1024),
  (error) => error instanceof CaptureQuotaError && error.code === 'quota-exhausted' && /Освободите место/.test(error.message)
);
const quotaWriter = await quotaStorage.beginBody('capture-quota');
await quotaWriter.write(new Uint8Array([1, 2, 3, 4]));
await assert.rejects(() => quotaWriter.write(new Uint8Array([5])), { code: 'quota-exhausted' });
await quotaWriter.abort('quota-exhausted');
await quotaStorage.saveMission('capture-quota', { state: 'partial', recovery: { recoverable: true, reason: 'quota-exhausted' } });
assert.equal((await quotaStorage.getMission('capture-quota')).state, 'partial');
assert.equal(quotaStorage.database.temporaryBodies.size, 0);

await assert.rejects(() => storage.openBody('capture/missing/body'), { code: 'body-not-found' });
await storage.createMission({ id: 'capture-size-mismatch' });
const invalidWriter = await storage.beginBody('capture-size-mismatch');
await invalidWriter.write(new Uint8Array([1, 2]));
await assert.rejects(() => invalidWriter.commit(HASH_C, { size: 3 }), { code: 'body-size-mismatch' });
await invalidWriter.abort('invalid-size');
await storage.cleanupMission('capture-size-mismatch');

const largeStorage = createMemoryCaptureStorage();
await largeStorage.createMission({ id: 'capture-large' });
const mebibyte = new Uint8Array(1024 * 1024);
const largeSize = 201 * 1024 * 1024;
const largeWriter = await largeStorage.beginBody('capture-large', largeSize);
for (let index = 0; index < 201; index += 1) {
  mebibyte[0] = index;
  await largeWriter.write(mebibyte);
}
const largeBody = await largeWriter.commit(`sha256:${'d'.repeat(64)}`, { size: largeSize });
assert.equal(largeBody.size, largeSize, 'fixture must exceed the old 200 MiB per-resource ceiling');
assert.equal(largeBody.chunkCount, 201, 'large writes must remain chunked');
await largeStorage.cleanupMission('capture-large');
assert.equal(largeStorage.database.chunks.size, 0);

console.log('PASS: durable storage lifecycle, interruption, quota, cancellation, cleanup, deduplication, negatives, and >200 MiB fixture');
