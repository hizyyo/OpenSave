import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import PrivacyGuardrails from '../privacy-guardrails.js';
import ArchiveValidator from '../archive-validator.js';
import CaptureGraph from '../capture-graph.js';
import ArchiveOptimizer from '../archive-optimizer.js';

const secrets = {
  bearer: 'Bearer bearer_secret_value_1234567890',
  cookie: 'sessionid=session_secret_1234567890',
  apiKey: 'api_secret_value_1234567890',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_secret_1234',
  password: 'password_secret_1234567890'
};

const assertNoSecrets = (value, label) => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(secrets)) {
    assert(!serialized.includes(secret), `${label} leaked ${secret}`);
  }
};

const headerResult = PrivacyGuardrails.sanitizeHeaders({
  Authorization: secrets.bearer,
  Cookie: secrets.cookie,
  'X-Api-Key': secrets.apiKey,
  'Content-Type': 'application/json',
  Accept: 'text/html'
}, 'request.headers');
assert.equal(headerResult.headers['Content-Type'], 'application/json');
assert.equal(headerResult.headers.Accept, 'text/html');
assert.equal(headerResult.headers.Authorization, PrivacyGuardrails.REDACTED);
assert.equal(headerResult.findings.length, 3);
assert.deepEqual(Object.keys(headerResult.findings[0]).sort(), ['category', 'confidence', 'location', 'maskedPreview']);
assertNoSecrets(headerResult, 'headers');

const arrayHeaders = PrivacyGuardrails.sanitizeHeaders([
  { name: 'Set-Cookie', value: secrets.cookie },
  { name: 'Content-Type', value: 'text/plain' }
]);
assert.equal(arrayHeaders.headers[0].value, PrivacyGuardrails.REDACTED);
assert.equal(arrayHeaders.headers[1].value, 'text/plain');

const urlResult = PrivacyGuardrails.sanitizeUrl(`https://user:${secrets.password}@example.test/path?access_token=${secrets.apiKey}&user_id=42&session=${secrets.cookie}#access_token=${secrets.jwt}`, 'request.url');
assert(urlResult.url.includes('user_id=42'));
assert.equal(urlResult.findings.length, 5);
assertNoSecrets(urlResult, 'url');

const jsonBody = PrivacyGuardrails.sanitizeRequestBody(JSON.stringify({
  username: 'harmless-user',
  password: secrets.password,
  nested: { access_token: secrets.apiKey }
}), 'application/json');
assert.equal(JSON.parse(jsonBody.body).username, 'harmless-user');
assert.equal(JSON.parse(jsonBody.body).password, PrivacyGuardrails.REDACTED);
assert.equal(JSON.parse(jsonBody.body).nested.access_token, PrivacyGuardrails.REDACTED);
assert.equal(jsonBody.safe, true);
assertNoSecrets(jsonBody, 'JSON body');

const formBody = PrivacyGuardrails.sanitizeRequestBody(`email=a%40example.test&password=${secrets.password}&remember=true`, 'application/x-www-form-urlencoded');
assert.equal(new URLSearchParams(formBody.body).get('email'), 'a@example.test');
assert.equal(new URLSearchParams(formBody.body).get('password'), PrivacyGuardrails.REDACTED);
assertNoSecrets(formBody, 'form body');

const unsafeBody = PrivacyGuardrails.sanitizeRequestBody(`--boundary\r\npassword=${secrets.password}`, 'multipart/form-data; boundary=boundary');
assert.equal(unsafeBody.safe, false);
assert.equal(unsafeBody.body, PrivacyGuardrails.REDACTED);

const harmless = [
  'token budget is 4096',
  'session timeout is 30 minutes',
  'password reset instructions',
  'https://example.test/?code=docs',
  'SessionId=i.session_id',
  'secret=this._globalSecret'
];
for (const sample of harmless) assert.equal(PrivacyGuardrails.scanText(sample).length, 0, `False positive: ${sample}`);
assert.equal(PrivacyGuardrails.sanitizeUrl('https://example.test/?code=docs&key=id').findings.length, 0);
const malformedUrl = PrivacyGuardrails.sanitizeUrl(`https://%zz.invalid/path?access_token=${secrets.apiKey}`, 'malformed.url');
assert.equal(malformedUrl.findings.length, 1);
assertNoSecrets(malformedUrl, 'malformed URL');

const sanitizedLog = PrivacyGuardrails.sanitizeText(`Failed ${secrets.bearer} at https://example.test/?access_token=${secrets.apiKey}`, 'log');
assert(sanitizedLog.findings.length >= 2);
assertNoSecrets(sanitizedLog, 'log');

const graph = CaptureGraph.createCaptureGraph();
const mission = CaptureGraph.addMission(graph, { sourceUrl: `https://example.test/?session=${secrets.cookie}` });
const graphRequest = CaptureGraph.addRequest(graph, {
  missionId: mission.id,
  originalUrl: `https://example.test/api?access_token=${secrets.apiKey}`,
  headers: { Authorization: secrets.bearer, 'Content-Type': 'application/json' },
  requestBody: JSON.stringify({ password: secrets.password })
});
CaptureGraph.addResponse(graph, {
  missionId: mission.id,
  requestId: graphRequest.id,
  originalUrl: 'https://example.test/api',
  headers: { 'Set-Cookie': secrets.cookie },
  bodyState: 'not-captured'
});
const graphResult = PrivacyGuardrails.sanitizeCaptureGraph(graph);
assert.equal(graphResult.graph.requests[0].requestBodyHash, null);
assert.deepEqual(CaptureGraph.validateGraph(graphResult.graph), []);
assert.equal(graphResult.graph.privacy.privateByDefault, true);
assert.equal(graphResult.graph.privacy.safeToShare, false);
assertNoSecrets(graphResult.graph, 'capture graph');
assertNoSecrets(graphResult.findings, 'graph audit');

const formSnapshot = PrivacyGuardrails.sanitizeFormSnapshot({ redactedFields: 4, password: secrets.password });
assert.equal(formSnapshot.summary.password, PrivacyGuardrails.REDACTED);
assert(formSnapshot.findings.some((item) => item.category === 'form-field'));
assertNoSecrets(formSnapshot, 'form snapshot');

const runnableBody = `<script>const token = "${secrets.apiKey}";</script>`;
const bodyRisk = PrivacyGuardrails.inspectRunnableBody(runnableBody, 'text/html', 'index.html');
assert.equal(bodyRisk.risky, true);
assert.equal(runnableBody.includes(secrets.apiKey), true, 'Scanner must not rewrite runnable evidence');
assertNoSecrets(bodyRisk.findings, 'body findings');

const sidepanelSource = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
assert.doesNotMatch(sidepanelSource, /snapshot\.postData}\\n\$\{snapshot\.sequence/, 'Snapshot paths must not hash raw POST data');
const elements = new Map();
const element = () => ({ style: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return { value: 'quick' }; } });
let confirmResult = true;
const context = vm.createContext({
  console, URL, URLSearchParams, Blob, TextEncoder, TextDecoder, crypto, Math,
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, documentElement: { dataset: {} } },
  window: { addEventListener() {}, confirm: () => confirmResult },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  OpenSaveCaptureGraph: {}, OpenSaveCaptureStorage: { createCaptureStorage: () => ({ initialize: async () => {} }) },
  OpenSaveResourceParser: {}, OpenSaveArchiveValidator: {}, OpenSavePrivacyGuardrails: PrivacyGuardrails,
  OpenSaveArchiveOptimizer: ArchiveOptimizer,
  JSZip: function JSZip() {}
});
vm.runInContext(sidepanelSource, context);
const riskyResource = { url: 'https://example.test/private.json', localPath: 'assets/private.json', mimeType: 'application/json', body: JSON.stringify({ token: secrets.apiKey }) };
const prepared = context.preparePrivateArtifacts('<!doctype html><p>safe</p>', [riskyResource], []);
assert.equal(prepared.resources.length, 0, 'Confirmed risky artifact must be excluded');
assert.equal(prepared.exclusions.length, 1);
assert.equal(prepared.exclusions[0].location, 'archive.resources[0]');
assertNoSecrets(prepared.findings, 'artifact audit');
confirmResult = false;
assert.throws(() => context.preparePrivateArtifacts('<!doctype html><p>safe</p>', [riskyResource], []), /Экспорт отменён/);
assert.throws(() => context.preparePrivateArtifacts(runnableBody, [], []), /основной странице найдены возможные секреты/);
confirmResult = true;
const riskyRequestSnapshot = { exchangeId: 'exchange-1', sequence: 1, url: 'https://example.test/api', contentType: 'application/json', postData: JSON.stringify({ password: secrets.password }), requestBodyHash: 'sha256:dictionary-target', headers: {}, mimeType: 'application/json', body: '{"ok":true}', localPath: '/api-snapshots/one.json' };
const preparedSnapshot = context.preparePrivateArtifacts('<!doctype html><p>safe</p>', [], [riskyRequestSnapshot]);
assert.equal(preparedSnapshot.snapshots.length, 0);
assertNoSecrets(preparedSnapshot.findings, 'request snapshot audit');

const privacyDiagnostics = ArchiveValidator.inputDiagnostics({ report: { privacy: { exclusions: prepared.exclusions } } });
assert(privacyDiagnostics.some((item) => item.code === 'private-artifact-excluded'));
assert.equal(ArchiveValidator.finalize({ diagnostics: privacyDiagnostics }).status, 'partial');

const largeCapture = Array.from({ length: 10000 }, (_, index) => ({
  url: `https://example.test/items/${index}?access_token=${secrets.apiKey}`,
  headers: { Accept: 'application/json', Authorization: secrets.bearer },
  note: `item ${index}`
}));
const startedAt = performance.now();
const largeFindings = [];
const sanitizedLargeCapture = PrivacyGuardrails.sanitizeMetadata(largeCapture, 'largeCapture', largeFindings);
const durationMs = performance.now() - startedAt;
assertNoSecrets(sanitizedLargeCapture, 'large capture');
assert(durationMs < 3000, `Large capture scan took ${durationMs.toFixed(1)} ms`);

console.log(`PASS: privacy guardrails headers, URLs, bodies, logs, graph, forms, cancellation, exclusions, negatives, and 10k-record scan (${durationMs.toFixed(1)} ms)`);
