import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ArchiveValidator from '../archive-validator.js';
import ArchiveOptimizer from '../archive-optimizer.js';
import PrivacyGuardrails from '../privacy-guardrails.js';

const panel = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

assert.match(panel, /archive-validator\.js/, 'Side panel must load the validator core');
assert.match(source, /async function validateArchive/, 'Generated artifacts must run post-export validation');
assert.match(source, /Fetch\.enable/, 'In-extension validation must intercept requests instead of allowing network access');
assert.match(source, /external-request-attempt/, 'External request attempts must be typed diagnostics');
assert.match(source, /opensaveValidationMarker/, 'Routes must be checked against their own captured content marker');
assert.match(source, /activeValidation\.cancelled = true/, 'Validation must support cooperative cancellation');
assert.match(source, /validation-report\.json/, 'Machine-readable validation results must be included in archives');
assert.match(source, /archive-validator-companion\.mjs/, 'Browser service-worker restrictions must produce a real local companion, not fake success');
assert.match(source, /validation\.status === 'ready'/, 'Side-panel results must distinguish ready from partial and failed');
assert.match(source, /code: 'child-fetch-unavailable', severity: 'warning'/, 'Unsupported child-target interception must require the companion without failing the archive');

const elements = new Map();
const element = () => ({
  style: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
  appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return { value: 'quick' }; }
});
const context = vm.createContext({
  console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, crypto,
  document: {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element
  },
  window: { addEventListener() {}, confirm: () => false },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  OpenSaveCaptureGraph: {},
  OpenSaveCaptureStorage: { createCaptureStorage: () => ({ initialize: async () => {} }) },
  OpenSaveResourceParser: {}, OpenSaveArchiveValidator: ArchiveValidator,
  OpenSavePrivacyGuardrails: PrivacyGuardrails, OpenSaveArchiveOptimizer: ArchiveOptimizer,
  JSZip: function JSZip() {}
});
vm.runInContext(source, context);
const resources = [
  { url: 'https://fixture.test/app/', mimeType: 'text/html', localPath: 'assets/fixture.test/app.html', body: '<html><head></head><body>root</body></html>' },
  { url: 'https://fixture.test/app/frame', mimeType: 'text/html', localPath: 'assets/fixture.test/app/frame.html', body: '<html><head></head><body>frame</body></html>' },
  { url: 'https://fixture.test/app#settings', routeUrl: 'https://fixture.test/app#settings', routeId: 'settings', routePage: true, mimeType: 'text/html', localPath: 'assets/fixture.test/app/settings.html', body: '<html><head></head><body>settings</body></html>' }
];
const routes = context.createValidationRoutes(resources, 'https://fixture.test/app/');
assert.deepEqual(Array.from(routes, (route) => new URL(route.url).pathname + new URL(route.url).hash), ['/app/frame', '/app#settings']);
assert.match(resources[1].body, /opensaveValidationMarker/, 'Saved iframe HTML must receive its own validation marker');
assert.match(resources[2].body, /opensaveValidationMarker/, 'History routes at the root path must still be validated');

console.log('PASS: post-export validator mount, markers, cancellation, result schema, and companion wiring');
