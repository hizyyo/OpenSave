import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ArchiveOptimizer from '../archive-optimizer.js';
import PrivacyGuardrails from '../privacy-guardrails.js';
import ResourceParser from '../resource-parser.js';

const require = createRequire(import.meta.url);
const JSZip = require('../lib/jszip.min.js');
const source = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

const elements = new Map();
const element = () => ({
  style: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
  appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return { value: 'quick' }; }
});
let confirmResult = true;
const context = vm.createContext({
  console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, CompressionStream, Response, crypto, Math, setTimeout,
  document: {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      if (id === 'archiveLimitMb') elements.get(id).value = '1';
      return elements.get(id);
    },
    createElement: element,
    documentElement: { dataset: {} }
  },
  window: { addEventListener() {}, confirm: () => confirmResult },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  OpenSaveCaptureGraph: { contentHashForBody: async () => '' },
  OpenSaveCaptureStorage: { createCaptureStorage: () => ({ initialize: async () => {} }) },
  OpenSaveResourceParser: ResourceParser, OpenSaveArchiveValidator: { normalizePath: (value) => value },
  OpenSavePrivacyGuardrails: PrivacyGuardrails, OpenSaveArchiveOptimizer: ArchiveOptimizer,
  JSZip
});
vm.runInContext(source, context);

const capturedDom = '<html><body><div class="clone">rendered clone</div></body></html>';
const networkHtml = '<!doctype html><html><body><script src="/app.js"></script></body></html>';
assert.equal(context.selectArchiveEntryHtml(capturedDom, [{ url: 'https://a.test/', mimeType: 'text/html', body: networkHtml }], 'https://a.test/', 'quick').html, networkHtml);
assert.equal(context.selectArchiveEntryHtml(capturedDom, [{ url: 'https://a.test/', mimeType: 'text/html', body: networkHtml }], 'https://a.test/', 'deep').html, capturedDom);
assert.equal(context.selectArchiveEntryHtml(capturedDom, [{ url: 'https://a.test/', mimeType: 'text/html', body: networkHtml }], 'https://a.test/', 'quick', { shadowRoots: 1 }).html, capturedDom);
assert.equal(context.selectArchiveEntryHtml(capturedDom, [{ url: 'https://a.test/', mimeType: 'text/html', body: networkHtml }], 'https://a.test/', 'quick', { canvases: 1 }).html, capturedDom);
let fetchAttempts = 0;
const retriedResponse = await context.fetchResourceWithRetry('https://a.test/retry.png', {}, async () => {
  fetchAttempts += 1;
  if (fetchAttempts < 2) throw new Error('transient network failure');
  return new Response('ok', { status: 200 });
});
assert.equal(retriedResponse.status, 200);
assert.equal(fetchAttempts, 2, 'Fallback resources must retry transient network failures');
assert.equal(context.resourceFetchCredentials('https://cdn.a.test/video.mp4', 'https://a.test/'), 'omit');
assert.equal(context.resourceFetchCredentials('https://a.test/private.png', 'https://a.test/page'), 'include');

const largeAppendTarget = [];
context.appendItems(largeAppendTarget, Array.from({ length: 150000 }, (_, index) => index));
assert.equal(largeAppendTarget.length, 150000, 'Large result sets must not be appended through the call stack');

const duplicateBody = new Uint8Array([1, 2, 3, 4]);
const catalog = context.createCatalog([
  { url: 'https://a.test/media/logo.png', mimeType: 'image/png', body: duplicateBody, contentHash: 'sha256:same' },
  { url: 'https://b.test/assets/logo-copy.png', mimeType: 'image/png', body: duplicateBody, contentHash: 'sha256:same' }
], 'https://a.test/');
assert.equal(catalog.resources.length, 1, 'Identical binary bodies must be stored once');
assert.equal(catalog.resources[0].aliases[0], 'https://b.test/assets/logo-copy.png');
assert.equal(catalog.byUrl.get('https://b.test/assets/logo-copy.png'), catalog.resources[0]);
assert.equal(catalog.stats.logicalBytes, 8);
assert.equal(catalog.stats.physicalBytes, 4);
assert.equal(catalog.stats.deduplicatedBytes, 4);

const worker = context.createOfflineServiceWorker(catalog.resources, []);
assert(worker.includes('https://b.test/assets/logo-copy.png'), 'Service worker must preserve duplicate URL aliases');

const apiResource = { url: 'https://a.test/api/data', localPath: 'assets/a.test/api/data.json', mimeType: 'application/json', body: '{"ok":true}', contentHash: 'sha256:api', preserveUrl: true };
const apiSnapshots = [
  { exchangeId: 'exchange-1', sequence: 1, localPath: '/api-snapshots/one.json', mimeType: 'application/json', body: '{"ok":true}', contentHash: 'sha256:api' },
  { exchangeId: 'exchange-2', sequence: 2, localPath: '/api-snapshots/two.json', mimeType: 'application/json', body: '{"ok":true}', contentHash: 'sha256:api' }
];
const snapshotStorage = context.deduplicateSnapshotBodies([apiResource], apiSnapshots);
assert.equal(snapshotStorage.files.length, 0, 'API snapshot bodies must reuse an identical canonical resource file');
assert.equal(apiSnapshots[0].localPath, '/assets/a.test/api/data.json');
assert.equal(apiSnapshots[1].localPath, '/assets/a.test/api/data.json');
assert.equal(snapshotStorage.stats.duplicateBodies, 2);

const textCatalog = context.createCatalog([
  { url: 'https://a.test/one/app.css', mimeType: 'text/css', body: 'a{background:url(./x.png)}', contentHash: 'sha256:text-same' },
  { url: 'https://a.test/two/app.css', mimeType: 'text/css', body: 'a{background:url(./x.png)}', contentHash: 'sha256:text-same' }
], 'https://a.test/');
assert.equal(textCatalog.resources.length, 2, 'Text with different base directories must not be deduplicated');

const sourceMapCatalog = context.createCatalog([
  { url: 'https://a.test/app.js.map', mimeType: 'application/json', body: '{"version":3}', contentHash: 'sha256:map' }
], 'https://a.test/');
assert.equal(sourceMapCatalog.resources.length, 0);
assert.equal(sourceMapCatalog.exclusions[0].kind, 'source-map');
assert.match(source, /SOURCE_MAP_COMMENT_EXPRESSION/);

const mediaCatalog = context.createCatalog([
  { url: 'https://a.test/movie.mp4', mimeType: 'video/mp4', body: new Uint8Array(ArchiveOptimizer.DEFAULT_LARGE_MEDIA_BYTES), contentHash: 'sha256:video' }
], 'https://a.test/');
confirmResult = false;
const mediaReport = {};
const removed = context.applyLargeMediaChoice(mediaCatalog, mediaReport);
assert.equal(removed.length, 1);
assert.equal(mediaCatalog.resources.length, 0);
assert.equal(mediaCatalog.mediaDecision.decision, 'excluded');
assert.equal(mediaReport.optimizationExclusions[0].kind, 'large-media');

const zip = new JSZip();
zip.file('index.html', '<!doctype html><h1>' + 'compressible '.repeat(10000) + '</h1>');
zip.file('assets/data.bin', new Uint8Array(4096).fill(7));
const files = await context.archiveFiles(zip);
const estimate = await ArchiveOptimizer.estimateArchive([...files.values()].map((file) => ({ ...file, size: file.bytes.byteLength })));
const actual = await zip.generateAsync({ type: 'uint8array', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
const errorRatio = Math.abs(estimate.estimatedArchiveBytes - actual.byteLength) / actual.byteLength;
assert(errorRatio <= 0.15, `Archive estimate error ${(errorRatio * 100).toFixed(1)}% exceeds 15%`);
assert(actual.byteLength < estimate.physicalBytes / 4, 'DEFLATE must materially reduce duplicate-heavy text');

confirmResult = false;
assert.equal(context.confirmArchiveEstimate({ estimatedArchiveBytes: 2 * 1024 * 1024 }), false, 'Threshold warning must be user-cancellable');
assert.match(source, /compression: 'DEFLATE'/);

console.log(`PASS: archive dedup aliases, safe text scope, source maps, media choice, threshold, DEFLATE, and ${(errorRatio * 100).toFixed(1)}% estimate error`);
