import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import PrivacyGuardrails from '../privacy-guardrails.js';
import ArchiveOptimizer from '../archive-optimizer.js';

const html = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

assert.match(html, /id="stage"/, 'Must contain progress stage element');
assert.match(html, /id="summaryCard"/, 'Must contain human summary card');
assert.match(html, /id="detailsToggle"/, 'Must contain collapsible details toggle');

assert.match(source, /setStage\('Подготовка страницы'\)/, 'Must report preparation stage');
assert.match(source, /setStage\('Сбор страниц и ресурсов'\)/, 'Must report discovery stage');
assert.match(source, /setStage\('Сохранение медиа и данных'\)/, 'Must report asset saving stage');
assert.match(source, /setStage\('Сборка копии'\)/, 'Must report building copy stage');
assert.match(source, /setStage\('Проверка результата'\)/, 'Must report validation stage');
assert.match(source, /function isAnalyticsOrTracker/, 'Must distinguish analytics and trackers');
assert.match(source, /renderSummary/, 'Must render structured human summary');
assert.match(source, /recommendedAction/, 'Must provide actionable advice for failures');

const elements = new Map();
const createElementMock = () => ({
  style: {}, className: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
  appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return { value: 'quick' }; }
});
const documentMock = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, createElementMock());
    return elements.get(id);
  },
  createElement: createElementMock
};

const context = vm.createContext({
  console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, crypto, Math,
  document: documentMock,
  window: { addEventListener() {}, confirm: () => false },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  OpenSaveCaptureGraph: {},
  OpenSaveCaptureStorage: { createCaptureStorage: () => ({ initialize: async () => {} }) },
  OpenSaveResourceParser: {},
  OpenSaveArchiveValidator: {},
  OpenSavePrivacyGuardrails: PrivacyGuardrails,
  OpenSaveArchiveOptimizer: ArchiveOptimizer,
  JSZip: function JSZip() {}
});

vm.runInContext(source, context);

context.renderSummary({
  status: 'ready',
  savedPages: 8,
  totalDiscoveredPages: 8,
  savedFiles: 142,
  totalRequiredFiles: 145,
  ignoredAnalyticsCount: 3,
  testedRoutes: 8,
  failedRoutes: 0,
  recommendedAction: ''
});

const card = elements.get('summaryCard');
assert(card.innerHTML.includes('Сохранено страниц: <strong>8</strong> из <strong>8</strong>'));
assert(card.innerHTML.includes('Сохранено файлов контента: <strong>142</strong> из <strong>145</strong>'));
assert(card.innerHTML.includes('Игнорировано аналитики и трекеров: <strong>3</strong>'));
assert(card.innerHTML.includes('Все проверенные страницы (<strong>8</strong>) открываются успешно'));

console.log('PASS: user status stages, human summary card, analytics distinction, and toggle diagnostics');
