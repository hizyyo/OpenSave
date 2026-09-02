import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import PrivacyGuardrails from '../privacy-guardrails.js';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const sidepanel = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');

assert.match(background, /chrome\.tabs\.create\(\{ url: 'about:blank', active: false \}\)/, 'Deep capture must use an inactive isolated tab');
assert.match(background, /chrome\.tabs\.remove\(captureTabId\)/, 'The isolated tab must close in finally');
assert.match(background, /new MutationObserver/, 'Rendered routes must wait for DOM mutation idle');
assert.match(background, /inFlightRequestKeys\.size === 0/, 'Rendered routes must wait for bounded network idle');
assert.match(background, /document\.querySelectorAll\('a\[href\]'\)/, 'Route discovery must use ordinary anchors');
assert.doesNotMatch(background.slice(background.indexOf('async function discoverRenderedRoutes'), background.indexOf('async function navigateRenderedRoute')), /button|form|submit/i, 'Route discovery must not click controls or submit forms');
assert.match(background, /operation\.cancelRequested/, 'Crawler waits must observe cooperative cancellation');
assert.match(sidepanel, /rendered-navigation-failed-fetch-fallback/, 'Fetch fallback must be explicitly lower fidelity');
assert.match(sidepanel, /collectMissingFiles\(html, pageUrl, catalog, captureReport, false, graph, fallbackPageUrls\)/, 'Rendered Deep capture must not run the old fetch-only page crawler');
assert.match(sidepanel, /projectRenderedPages/, 'Archive pages must come from rendered checkpoints');
assert.match(panel, /id="btnCancelCapture"/, 'Deep capture must expose cancellation');

const elements = new Map();
const element = () => ({
  style: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
  appendChild() {}, addEventListener() {}, querySelectorAll() { return []; },
  querySelector() { return { value: 'quick' }; }
});
const context = vm.createContext({
  console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, crypto,
  document: {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element
  },
  window: { addEventListener() {}, confirm: () => false },
  chrome: {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
    downloads: { onChanged: { addListener() {}, removeListener() {} } }
  },
  OpenSaveCaptureGraph: {},
  OpenSaveCaptureStorage: { createCaptureStorage: () => ({ initialize: async () => {} }) },
  OpenSaveResourceParser: {},
  OpenSaveArchiveValidator: {},
  OpenSavePrivacyGuardrails: PrivacyGuardrails,
  JSZip: function JSZip() {}
});
vm.runInContext(sidepanel, context);
const serviceWorker = context.createOfflineServiceWorker([
  { url: 'https://fixture.test/page', mimeType: 'text/html', localPath: 'assets/fixture.test/page.html', aliases: ['https://fixture.test/alias'] }
], []);
const offlineRuntime = context.createOfflineReplayScript([], [
  { url: 'https://fixture.test/app#settings', routeUrl: 'https://fixture.test/app#settings', transitionKind: 'history', localPath: 'assets/fixture.test/app.html' }
]);
assert.doesNotThrow(() => new Function(serviceWorker), 'Generated service worker must parse');
assert.doesNotThrow(() => new Function(offlineRuntime), 'Generated offline runtime must parse');

console.log('PASS: isolated rendered crawler, bounded idle, safe anchors, fallback labeling, and cancellation wiring');
