import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import JSZip from '../lib/jszip.min.js';
import { CdpClient, connectBrowser, delay, evaluate, targetList, waitFor } from './benchmark/cdp-client.mjs';
import { createCorpusServer, FIXTURES } from './benchmark/corpus-server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACT_ROOT = join(ROOT, 'tests', 'artifacts', 'benchmark');
const DEFAULT_CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome';

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [name, value = 'true'] = argument.replace(/^--/, '').split('=', 2);
  return [name, value];
}));
const repetitions = Number.parseInt(options.repeat || '2', 10);
const chromePath = options.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
const fixtureFilter = new Set((options.fixtures || '').split(',').filter(Boolean));
const fixtures = fixtureFilter.size ? FIXTURES.filter((fixture) => fixtureFilter.has(fixture.id)) : FIXTURES;

if (!Number.isInteger(repetitions) || repetitions < 2) throw new Error('--repeat must be an integer of at least 2');
if (!fixtures.length) throw new Error('No benchmark fixtures selected');
if (process.platform === 'win32' && !existsSync(chromePath)) throw new Error(`Chrome was not found: ${chromePath}`);

mkdirSync(ARTIFACT_ROOT, { recursive: true });

const getFreePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  server.once('listening', () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
  server.once('error', reject);
});

const mimeType = (filename) => ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}[extname(filename).toLowerCase()] || 'application/octet-stream');

async function unzipArchive(filename) {
  const zip = await JSZip.loadAsync(readFileSync(filename));
  const files = new Map();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    files.set(path, { data: await entry.async('nodebuffer'), type: mimeType(path) });
  }
  return files;
}

const parseJsonFile = (files, path) => JSON.parse(files.get(path).data.toString('utf8'));

function pageRoutes(files) {
  const worker = files.get('sitesaver-sw.js').data.toString('utf8');
  const match = worker.match(/const PAGE_ROUTES = (\{[^\n]*\});/);
  return match ? Object.keys(JSON.parse(match[1])).sort() : [];
}

function unresolvedByReason(report) {
  const reasons = {};
  for (const item of report.unresolvedResources || []) {
    const reason = item.reason || 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return reasons;
}

function stableSignature(result) {
  return JSON.stringify({
    discoveredResources: result.discoveredResources,
    captureGraphParity: result.captureGraphParity,
    durableStorageBackend: result.durableStorage?.backend || null,
    durableMissionCountAfterExport: result.durableMissionCountAfterExport,
    unresolvedByReason: result.unresolvedByReason,
    replayReport: result.replayReport,
    serviceWorkerReady: result.serviceWorkerReady,
    serviceWorkerRegistrationError: result.serviceWorkerRegistrationError,
    externalRequests: result.externalRequests,
    consoleErrors: result.consoleErrors,
    runtimeErrors: result.runtimeErrors,
    savedPageRoutes: result.savedPageRoutes,
    replayMarkers: result.replayMarkers,
    liveStateAssertions: result.liveStateAssertions,
    detectorAssertions: result.detectorAssertions,
    replayAssertions: result.replayAssertions,
    validation: result.validation && {
      status: result.validation.status,
      zeroEgressVerified: result.validation.zeroEgressVerified,
      serviceWorkerControlled: result.validation.serviceWorkerControlled,
      checkedRoutes: result.validation.checkedRoutes,
      totalRoutes: result.validation.totalRoutes,
      issueCodes: result.validation.diagnostics.filter((item) => item.severity !== 'info').map((item) => `${item.category}:${item.code}`).sort(),
      routeResults: result.validation.routes.map((route) => ({ routeId: route.routeId, expectedMarker: route.expectedMarker, actualMarker: route.actualMarker, status: route.status }))
    }
  });
}

const normalizeDiagnostic = (value) => String(value || '')
  .replace(/https?:\/\/[^/\s)'"\]]+/g, '<origin>')
  .replace(/:\d+:\d+/g, ':<line>:<column>');

async function launchChrome(corpusPort, runDirectory) {
  const debugPort = await getFreePort();
  const profileDirectory = join(tmpdir(), `opensave-benchmark-${process.pid}-${Date.now()}`);
  const downloadDirectory = join(runDirectory, 'downloads');
  mkdirSync(downloadDirectory, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-proxy-server',
    '--remote-allow-origins=*', '--enable-unsafe-extension-debugging',
    `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    `--host-resolver-rules=MAP *.opensave.localhost 127.0.0.1, MAP *.opensave.test 127.0.0.1`,
    'about:blank'
  ];
  const chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const { client, version } = await connectBrowser(debugPort);
  const extension = await client.command('Extensions.loadUnpacked', { path: ROOT });
  await delay(1000);
  await client.command('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: downloadDirectory,
    eventsEnabled: true
  });
  await client.command('Target.setDiscoverTargets', { discover: true });
  return { chrome, client, extensionId: extension.id, version, profileDirectory, downloadDirectory, stderr, corpusPort };
}

async function closeChrome(browser) {
  try {
    await browser.client.command('Browser.close');
  } catch (error) {
    if (!browser.chrome.killed) browser.chrome.kill();
  }
  browser.client.close();
  if (browser.chrome.exitCode == null) {
    await Promise.race([once(browser.chrome, 'exit'), delay(3000)]);
  }
  if (browser.chrome.exitCode == null) browser.chrome.kill();
  try {
    rmSync(browser.profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // Windows may keep profile files locked briefly after Chrome exits.
  }
}

async function createCaptureTab(browser, url) {
  await browser.client.command('Target.setDiscoverTargets', {
    discover: true,
    filter: [{ type: 'tab', exclude: false }, { type: 'page', exclude: false }, { exclude: true }]
  });
  const { targetId: tabTargetId } = await browser.client.command('Target.createTarget', { url, forTab: true });
  await waitFor(async () => (await targetList(browser.client, [
    { type: 'page', exclude: false }, { exclude: true }
  ])).find((target) => target.url === url), { description: `fixture page ${url}` });
  await browser.client.command('Target.activateTarget', { targetId: tabTargetId });
  return tabTargetId;
}

async function sidePanelSession(browser, tabTargetId) {
  await browser.client.command('Extensions.triggerAction', { id: browser.extensionId, targetId: tabTargetId });
  await browser.client.command('Target.setDiscoverTargets', { discover: true });
  let target;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    target = (await targetList(browser.client)).find((candidate) => candidate.url === `chrome-extension://${browser.extensionId}/sidepanel.html`);
    if (target) break;
    if (attempt > 0 && attempt % 10 === 0) await browser.client.command('Extensions.triggerAction', { id: browser.extensionId, targetId: tabTargetId });
    await delay(250);
  }
  if (!target) throw new Error('Timed out waiting for openSave side panel');
  const sessionId = await browser.client.attach(target.targetId);
  await browser.client.command('Runtime.enable', {}, sessionId);
  await waitFor(() => evaluate(browser.client, sessionId, 'document.documentElement.dataset.opensaveReady === "true"'), { description: 'openSave side panel runtime' });
  return { targetId: target.targetId, sessionId };
}

async function captureFixture(browser, sidePanel, tabTargetId, fixture) {
  await browser.client.command('Target.activateTarget', { targetId: tabTargetId });
  const existingFiles = new Set(readdirSync(browser.downloadDirectory));
  const startedAt = Date.now();
  const result = await evaluate(browser.client, sidePanel.sessionId, `(() => {
    const mode = document.querySelector('input[value="${fixture.mode}"]');
    mode.checked = true;
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btnCapture').click();
    return true;
  })()`);
  if (!result) throw new Error(`Could not start ${fixture.id} capture`);

  const completed = await waitFor(async () => {
    const failed = await evaluate(browser.client, sidePanel.sessionId, 'document.getElementById("status").textContent.startsWith("Ошибка:") && document.getElementById("status").textContent');
    if (failed) throw new Error(failed);
    for (const name of readdirSync(browser.downloadDirectory)) {
      if (existingFiles.has(name)) continue;
      const path = join(browser.downloadDirectory, name);
      try {
        if (name.endsWith('.crdownload') || !statSync(path).isFile() || !statSync(path).size) continue;
        const zip = await JSZip.loadAsync(readFileSync(path));
        if (zip.file('sitesaver-manifest.json') && zip.file('sitesaver-report.json')) return { filename: path };
      } catch (error) {
        // Ignore renamed partial downloads and unrelated Chrome model archives.
      }
    }
    if (Date.now() - startedAt > 170000) {
      const diagnostics = await evaluate(browser.client, sidePanel.sessionId, `(async () => ({
        status: document.getElementById('status')?.textContent || '',
        progress: document.getElementById('fill')?.style.width || '',
        log: document.getElementById('log')?.innerText || '',
        missions: await captureStorage.listMissions()
      }))()`);
      throw new Error(JSON.stringify({ diagnostics, files: readdirSync(browser.downloadDirectory) }));
    }
    return null;
  }, { timeout: fixture.mode === 'deep' ? 180000 : 60000, interval: 200, description: `${fixture.id} archive download` });
  const filename = completed.filename;
  await waitFor(
    () => evaluate(browser.client, sidePanel.sessionId, 'captureStorage.listMissions()').then((missions) => {
      if (!missions.length) return true;
      throw new Error(JSON.stringify(missions.map((mission) => ({ id: mission.id, state: mission.state, recovery: mission.recovery }))));
    }),
    { timeout: 5000, interval: 50, description: `${fixture.id} durable mission cleanup` }
  );
  const durableMissionCountAfterExport = 0;
  return { filename, captureDurationMs: Date.now() - startedAt, archiveSizeBytes: statSync(filename).size, durableMissionCountAfterExport };
}

async function replayFixture(browser, corpus, fixture, runIndex, files) {
  const hostname = `replay-${runIndex}-${fixture.id}.opensave.localhost`;
  const rootUrl = corpus.registerReplay(hostname, files);
  const { targetId } = await browser.client.command('Target.createTarget', { url: 'about:blank' });
  const sessionId = await browser.client.attach(targetId);
  const requestedUrls = [];
  const consoleErrors = [];
  const runtimeErrors = [];
  browser.client.on('Network.requestWillBeSent', ({ request }, eventSessionId) => {
    if (eventSessionId === sessionId) requestedUrls.push(request.url);
  });
  browser.client.on('Log.entryAdded', ({ entry }, eventSessionId) => {
    if (eventSessionId === sessionId && entry.level === 'error') consoleErrors.push(entry.text);
  });
  browser.client.on('Runtime.exceptionThrown', ({ exceptionDetails }, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text || 'Runtime exception');
  });
  await Promise.all([
    browser.client.command('Page.enable', {}, sessionId),
    browser.client.command('Network.enable', {}, sessionId),
    browser.client.command('Runtime.enable', {}, sessionId),
    browser.client.command('Log.enable', {}, sessionId)
  ]);
  await browser.client.command('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
  await browser.client.command('Page.navigate', { url: rootUrl }, sessionId);
  await delay(2500);
  const workerReady = await evaluate(browser.client, sessionId, `Promise.race([
    navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => true) : Promise.resolve(false),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000))
  ])`);
  let workerDiagnostics = { isSecureContext: true, hasServiceWorker: true, registrations: [], registrationError: '' };
  if (!workerReady) {
    workerDiagnostics = await evaluate(browser.client, sessionId, `(async () => ({
      isSecureContext,
      hasServiceWorker: 'serviceWorker' in navigator,
      registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((item) => ({ scope: item.scope, active: item.active && item.active.scriptURL })) : [],
      registrationError: 'serviceWorker' in navigator ? await navigator.serviceWorker.register('/sitesaver-sw.js').then(() => '', (error) => error.message) : 'API unavailable'
    }))()`);
  }
  if (workerReady) {
    await browser.client.command('Page.reload', { ignoreCache: true }, sessionId);
    await waitFor(() => evaluate(browser.client, sessionId, 'document.readyState === "complete" && Boolean(document.body)'), { timeout: 10000, description: `${fixture.id} controlled root document` });
    await delay(500);
    if (!fixture.expectedFailure) {
      requestedUrls.length = 0;
      consoleErrors.length = 0;
      runtimeErrors.length = 0;
    }
  }
  const replayMarkers = {};
  replayMarkers['/'] = await evaluate(browser.client, sessionId, 'document.body?.getAttribute("data-benchmark-marker") || document.body?.innerText.slice(0, 80) || ""');
  for (const route of fixture.routes) {
    await browser.client.command('Page.navigate', { url: new URL(route, rootUrl).href }, sessionId);
    await delay(1000);
    replayMarkers[route] = await evaluate(browser.client, sessionId, 'document.body?.getAttribute("data-benchmark-marker") || document.body?.innerText.slice(0, 80) || ""');
  }
  const liveStateAssertions = fixture.id === 'shadow'
    ? await evaluate(browser.client, sessionId, `(() => {
      const root = document.getElementById('host')?.shadowRoot;
      const inside = root?.querySelector('.inside');
      return {
        shadowContent: inside?.textContent === 'SHADOW_CONTENT',
        adoptedStyle: inside ? getComputedStyle(inside).color === 'rgb(20, 80, 120)' : false
      };
    })()`)
    : fixture.id === 'canvas'
      ? await evaluate(browser.client, sessionId, `(() => ({
        canvasFallback: document.getElementById('canvas')?.hasAttribute('data-opensave-canvas-fallback') || false
      }))()`)
      : null;
  const replayAssertions = fixture.id === 'api'
    ? await evaluate(browser.client, sessionId, `(async () => {
      const status = document.getElementById('api-status');
      const request = async (url, init) => {
        const response = await fetch(url, init);
        return { status: response.status, reason: response.headers.get('x-opensave-replay-miss') };
      };
      const unknownMutation = await request('/fixtures/api/post', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      const range = await request('/fixtures/api/data?variant=one', { headers: { range: 'bytes=0-10' } });
      const sse = await request('/fixtures/api/data?variant=one', { headers: { accept: 'text/event-stream' } });
      let streaming = { status: 0, reason: '' };
      if (typeof ReadableStream !== 'undefined') {
        const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } });
        streaming = await request('/fixtures/api/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
      }
      const beaconBlocked = navigator.sendBeacon('/fixtures/api/post', 'beacon') === false;
      let websocketBlocked = false;
      let sseConstructorBlocked = false;
      try { new WebSocket('ws://external.opensave.test/socket'); } catch (error) { websocketBlocked = true; }
      try { new EventSource('/fixtures/api/events'); } catch (error) { sseConstructorBlocked = true; }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ledger = await window.__openSaveReplayLedger();
      return {
        status: status?.textContent || '',
        polls: status?.dataset.polls || '',
        posts: status?.dataset.posts || '',
        redirect: status?.dataset.redirect || '',
        head: status?.dataset.head || '',
        unknownMutation,
        range,
        sse,
        streaming,
        beaconBlocked,
        websocketBlocked,
        sseConstructorBlocked,
        reasonCodes: [...new Set((ledger.runtimeMisses || []).map((miss) => miss.reasonCode))].sort()
      };
    })()`)
    : null;
  const screenshot = await browser.client.command('Page.captureScreenshot', { format: 'png' }, sessionId);
  const screenshotBytes = Buffer.from(screenshot.data, 'base64');
  const screenshotHash = createHash('sha256').update(screenshotBytes).digest('hex');
  writeFileSync(join(ARTIFACT_ROOT, `run-${runIndex}-${fixture.id}.png`), screenshotBytes);
  const externalRequests = [...new Set(requestedUrls.filter((url) => {
    try {
      return /^https?:$/.test(new URL(url).protocol) && new URL(url).hostname !== hostname;
    } catch (error) {
      return false;
    }
  }).map((url) => {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  }))].sort();
  await browser.client.command('Target.closeTarget', { targetId });
  return {
    replayMarkers,
    screenshotHash,
    serviceWorkerReady: workerReady,
    serviceWorkerRegistrationError: normalizeDiagnostic(workerDiagnostics.registrationError),
    externalRequests,
    consoleErrors: [...new Set(consoleErrors.map(normalizeDiagnostic))].sort(),
    runtimeErrors: [...new Set(runtimeErrors.map(normalizeDiagnostic))].sort(),
    liveStateAssertions,
    replayAssertions
  };
}

async function runFixture(browser, corpus, sidePanel, fixture, runIndex) {
  corpus.resetFixture(fixture.id);
  const tabTargetId = await createCaptureTab(browser, corpus.fixtureUrl(fixture.id));
  await delay(fixture.id === 'api' || fixture.id === 'platform' ? 1200 : 500);
  const capture = await captureFixture(browser, sidePanel, tabTargetId, fixture);
  const files = await unzipArchive(capture.filename);
  const report = parseJsonFile(files, 'sitesaver-report.json');
  const manifest = parseJsonFile(files, 'sitesaver-manifest.json');
  const validation = parseJsonFile(files, 'validation-report.json');
  const replay = await replayFixture(browser, corpus, fixture, runIndex, files);
  const routes = pageRoutes(files);
  const detectorAssertions = fixture.expectedFailure ? {
    missingResourceDetected: Object.keys(unresolvedByReason(report)).length > 0 || (report.httpErrors || []).some((item) => item.status >= 400),
    externalRequestDetected: replay.externalRequests.some((url) => url.includes('external.opensave.test')),
    runtimeErrorDetected: replay.runtimeErrors.some((error) => error.includes('SEEDED_RUNTIME_ERROR'))
  } : null;
  await browser.client.command('Target.closeTarget', { targetId: tabTargetId });
  return {
    fixture: fixture.id,
    run: runIndex,
    captureMode: fixture.mode,
    discoveredResources: (report.discoveredResources || []).length,
    eligibleResponseBodies: report.eligibleResponses ?? null,
    capturedResponseBodies: report.capturedResponseBodies ?? null,
    retainedBodies: report.retainedBodies ?? null,
    unresolvedByReason: unresolvedByReason(report),
    serviceWorkerReady: replay.serviceWorkerReady,
    serviceWorkerRegistrationError: replay.serviceWorkerRegistrationError,
    externalRequests: replay.externalRequests,
    consoleErrors: replay.consoleErrors,
    runtimeErrors: replay.runtimeErrors,
    savedPageRoutes: routes,
    replayMarkers: replay.replayMarkers,
    screenshotHash: replay.screenshotHash,
    captureDurationMs: capture.captureDurationMs,
    archiveSizeBytes: capture.archiveSizeBytes,
    peakBodyBytesHeld: report.peakBodyBytesHeld ?? null,
    peakBodyBytesMeasurement: report.peakBodyBytesMeasurement ?? 'unavailable',
    captureGraphRecords: report.captureGraph?.records || null,
    captureGraphProvenance: report.captureGraph?.provenance || null,
    captureGraphParity: report.captureGraphParity || null,
    durableStorage: report.durableStorage || null,
    durableMissionCountAfterExport: capture.durableMissionCountAfterExport,
    captureGraph: report.captureGraph || null,
    replayReport: report.replay || null,
    archiveFormatVersion: manifest.version,
    validation,
    detectorAssertions,
    liveStateAssertions: replay.liveStateAssertions,
    replayAssertions: replay.replayAssertions
  };
}

function buildSummary(results, browserVersions) {
  const fixtureSummaries = fixtures.map((fixture) => {
    const runs = results.filter((result) => result.fixture === fixture.id);
    const signatures = runs.map(stableSignature);
    const baseline = signatures[0];
    const divergentRuns = signatures.reduce((count, signature) => count + (signature === baseline ? 0 : 1), 0);
    const detectorPassed = !fixture.expectedFailure || runs.every((run) => Object.values(run.detectorAssertions).every(Boolean));
    return {
      fixture: fixture.id,
      runs: runs.length,
      stable: divergentRuns === 0,
      divergentRuns,
      detectorPassed,
      expectedFailure: Boolean(fixture.expectedFailure),
      captureDurationMs: { min: Math.min(...runs.map((run) => run.captureDurationMs)), max: Math.max(...runs.map((run) => run.captureDurationMs)) },
      archiveSizeBytes: { min: Math.min(...runs.map((run) => run.archiveSizeBytes)), max: Math.max(...runs.map((run) => run.archiveSizeBytes)) },
      representative: runs[0]
    };
  });
  const flakyRuns = fixtureSummaries.reduce((total, fixture) => total + fixture.divergentRuns, 0);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repetitions,
    chromeVersions: [...new Set(browserVersions)],
    fixtures: fixtureSummaries,
    totals: {
      fixtureClasses: fixtureSummaries.length,
      executions: results.length,
      flakyRuns,
      detectorFailures: fixtureSummaries.filter((fixture) => !fixture.detectorPassed).map((fixture) => fixture.fixture)
    }
  };
}

function scorecard(summary) {
  const lines = [
    '# openSave Benchmark Scorecard',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    `Chrome: ${summary.chromeVersions.join(', ')}`,
    '',
    `Repetitions: ${summary.repetitions}; executions: ${summary.totals.executions}; divergent runs: ${summary.totals.flakyRuns}`,
    '',
    '| Fixture | Runs | Stable | Detector | Discovered | Eligible | Captured | Unresolved | External | Errors | Routes | Capture ms | Archive bytes | Peak body bytes |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const fixture of summary.fixtures) {
    const result = fixture.representative;
    const errors = result.consoleErrors.length + result.runtimeErrors.length;
    const unresolved = Object.values(result.unresolvedByReason).reduce((sum, value) => sum + value, 0);
    lines.push(`| ${fixture.fixture} | ${fixture.runs} | ${fixture.stable ? 'yes' : 'no'} | ${fixture.detectorPassed ? 'pass' : 'fail'} | ${result.discoveredResources} | ${result.eligibleResponseBodies ?? 'n/a'} | ${result.capturedResponseBodies ?? 'n/a'} | ${unresolved} | ${result.externalRequests.length} | ${errors} | ${result.savedPageRoutes.length} | ${fixture.captureDurationMs.min}-${fixture.captureDurationMs.max} | ${fixture.archiveSizeBytes.min}-${fixture.archiveSizeBytes.max} | ${result.peakBodyBytesHeld ?? 'n/a'} |`);
  }
  lines.push('', 'The detector fixture is intentionally broken. Its detector column passes only when the missing resource, external request attempt, and runtime exception are all observed.', '');
  return lines.join('\n');
}

const corpus = createCorpusServer();
const corpusPort = await corpus.listen();
const results = [];
const browserVersions = [];

try {
  for (let runIndex = 1; runIndex <= repetitions; runIndex += 1) {
    const runDirectory = join(ARTIFACT_ROOT, `run-${runIndex}`);
    rmSync(runDirectory, { recursive: true, force: true });
    mkdirSync(runDirectory, { recursive: true });
    const browser = await launchChrome(corpusPort, runDirectory);
    browserVersions.push(browser.version.Browser);
    try {
      const initialTab = await createCaptureTab(browser, corpus.fixtureUrl(fixtures[0].id));
      const sidePanel = await sidePanelSession(browser, initialTab);
      await browser.client.command('Target.closeTarget', { targetId: initialTab });
      for (const fixture of fixtures) {
        console.log(`run ${runIndex}/${repetitions} ${fixture.id}: starting ${fixture.mode} capture`);
        const result = await runFixture(browser, corpus, sidePanel, fixture, runIndex);
        results.push(result);
        console.log(`run ${runIndex}/${repetitions} ${fixture.id}: captured=${result.capturedResponseBodies} unresolved=${Object.values(result.unresolvedByReason).reduce((sum, value) => sum + value, 0)} external=${result.externalRequests.length}`);
      }
    } finally {
      await closeChrome(browser);
    }
  }
} finally {
  await corpus.close();
}

const summary = buildSummary(results, browserVersions);
writeFileSync(join(ARTIFACT_ROOT, 'results.json'), `${JSON.stringify({ ...summary, results }, null, 2)}\n`);
writeFileSync(join(ARTIFACT_ROOT, 'scorecard.md'), `${scorecard(summary)}\n`);
console.log(scorecard(summary));

const failures = [];
for (const fixture of summary.fixtures) {
  if (!fixture.stable) failures.push(`${fixture.fixture} had ${fixture.divergentRuns} divergent deterministic run(s)`);
  if (!fixture.detectorPassed) failures.push(`${fixture.fixture} did not detect all seeded failures`);
  if (!fixture.representative.screenshotHash) failures.push(`${fixture.fixture} did not produce a screenshot hash`);
  if (!fixture.expectedFailure && fixture.representative.externalRequests.length) failures.push(`${fixture.fixture} made external replay requests: ${fixture.representative.externalRequests.join(', ')}`);
  if (!fixture.expectedFailure && (fixture.representative.consoleErrors.length || fixture.representative.runtimeErrors.length)) failures.push(`${fixture.fixture} produced replay errors: ${[...fixture.representative.consoleErrors, ...fixture.representative.runtimeErrors].join('; ')}`);
  if (!fixture.representative.captureGraphParity?.bodiesMatch || !fixture.representative.captureGraphParity?.snapshotsMatch) failures.push(`${fixture.fixture} failed V1 capture graph projection parity`);
  if (!fixture.representative.captureGraphParity?.finalArchiveInputsMatch?.bodiesMatch || !fixture.representative.captureGraphParity?.finalArchiveInputsMatch?.snapshotsMatch) failures.push(`${fixture.fixture} failed final archive-input projection parity`);
  if (fixture.representative.archiveFormatVersion !== 3) failures.push(`${fixture.fixture} generated archive format v${fixture.representative.archiveFormatVersion ?? 'missing'} instead of v3`);
  const validation = fixture.representative.validation;
  if (!validation) failures.push(`${fixture.fixture} omitted validation-report.json`);
  else {
    if (!validation.zeroEgressVerified) failures.push(`${fixture.fixture} validation did not verify zero egress`);
    if (validation.checkedRoutes !== validation.totalRoutes) failures.push(`${fixture.fixture} validated ${validation.checkedRoutes}/${validation.totalRoutes} routes`);
    const expectedValidationRoutes = Math.max(1, fixture.representative.savedPageRoutes.length);
    if (validation.totalRoutes !== expectedValidationRoutes) failures.push(`${fixture.fixture} validation route count ${validation.totalRoutes} did not match distinct saved routes ${expectedValidationRoutes}`);
    if (validation.durationMs > (fixture.representative.captureMode === 'deep' ? 65000 : 35000)) failures.push(`${fixture.fixture} validation exceeded its bounded overhead: ${validation.durationMs} ms`);
    if (!fixture.expectedFailure && validation.status !== 'partial') failures.push(`${fixture.fixture} automatic validation returned ${validation.status}; expected honest partial pending local companion`);
    if (!fixture.expectedFailure && !validation.diagnostics.some((item) => item.code === 'local-companion-required')) failures.push(`${fixture.fixture} validation omitted the service-worker companion reason`);
    if (validation.routes.some((route) => route.status !== 'ready' || route.actualMarker !== route.expectedMarker)) failures.push(`${fixture.fixture} validation accepted a wrong route checkpoint`);
  }
  if (fixture.representative.durableStorage?.backend !== 'indexeddb' || !(fixture.representative.durableStorage?.persistedBodies > 0)) failures.push(`${fixture.fixture} did not persist captured bodies in IndexedDB`);
  if (fixture.representative.durableMissionCountAfterExport !== 0) failures.push(`${fixture.fixture} left ${fixture.representative.durableMissionCountAfterExport} durable mission(s) after successful export`);
  if (fixture.representative.liveStateAssertions && !Object.values(fixture.representative.liveStateAssertions).every(Boolean)) failures.push(`${fixture.fixture} did not preserve semantic live DOM state`);
}
const apiResult = results.find((result) => result.fixture === 'api');
if (apiResult) {
  const graph = apiResult.captureGraph;
  const sameUrlVariants = graph?.requestVariants.find((item) => new URL(item.url).pathname === '/fixtures/api/post');
  const methods = new Set((sameUrlVariants?.variants || []).map((variant) => variant.method));
  if (!methods.has('GET') || !methods.has('POST')) failures.push('api did not retain GET and POST exchanges for the same URL');
  const redirect = graph?.redirects.find((item) => new URL(item.predecessorUrl).pathname === '/fixtures/api/redirect');
  if (!redirect || new URL(redirect.originalUrl).pathname !== '/fixtures/api/data') failures.push('api did not retain redirect source and final URL identities');
  const pollExchanges = (graph?.apiExchanges || []).filter((exchange) => new URL(exchange.url).pathname === '/fixtures/api/poll');
  if (pollExchanges.length < 3) failures.push(`api retained ${pollExchanges.length}/3 polling exchanges`);
  if (!(graph?.apiExchanges || []).some((exchange) => exchange.status === 418)) failures.push('api did not retain the non-2xx exchange');
  const assertions = apiResult.replayAssertions;
  if (!assertions || !assertions.status.startsWith('API_OK_')) failures.push(`api replay did not finish: ${assertions?.status || 'missing assertions'}`);
  const pollSequence = (assertions?.polls || '').split(',').map(Number);
  if (pollSequence.length !== 3 || pollSequence.some((value, index) => index > 0 && value !== pollSequence[index - 1] + 1)) failures.push(`api polling order was ${assertions?.polls || 'missing'}`);
  if (!assertions?.posts.includes('{"variant":"one"}') || !assertions?.posts.includes('{"variant":"two"}') || !assertions?.posts.includes('variant=form')) failures.push(`api POST variants collided: ${assertions?.posts || 'missing'}`);
  if (assertions?.redirect !== 'redirected') failures.push(`api redirect replay returned ${assertions?.redirect || 'missing'}`);
  if (assertions?.head !== '204') failures.push(`api HEAD replay returned ${assertions?.head || 'missing'}`);
  for (const [name, reason] of [['unknownMutation', 'unknown-mutation'], ['range', 'range-request'], ['sse', 'sse']]) {
    if (assertions?.[name]?.status !== 503 || assertions?.[name]?.reason !== reason) failures.push(`api ${name} did not fail closed with ${reason}`);
  }
  if (assertions?.streaming?.status !== 503 || assertions?.streaming?.reason !== 'streaming-request') failures.push('api streaming request did not fail closed');
  if (!assertions?.beaconBlocked || !assertions?.websocketBlocked || !assertions?.sseConstructorBlocked) failures.push('api beacon/WebSocket/EventSource did not fail closed');
  for (const reason of ['beacon', 'range-request', 'sse', 'streaming-request', 'unknown-mutation', 'websocket']) {
    if (!assertions?.reasonCodes.includes(reason)) failures.push(`api replay ledger omitted ${reason}`);
  }
  if ((apiResult.replayReport?.supportedCoverage || 0) < 98) failures.push(`api supported replay coverage was ${apiResult.replayReport?.supportedCoverage ?? 'missing'}%`);
}
const aliasResult = results.find((result) => (result.captureGraph?.bodyAliases || []).some((alias) => alias.responses.length > 1));
if (fixtures.some((fixture) => fixture.id === 'static') && !aliasResult) failures.push('benchmark did not retain identical-byte URL aliases');
const refetchResult = results.find((result) => (result.captureGraph?.provenance.refetched.responses || 0) > 0 && (result.captureGraph?.provenance.observed.responses || 0) > 0);
if (fixtures.some((fixture) => fixture.id === 'multipage') && !refetchResult) failures.push('benchmark did not distinguish refetched resources from observed responses');
if (summary.totals.flakyRuns > Math.floor(summary.totals.executions / 10)) failures.push(`Flake rate exceeded one in ten: ${summary.totals.flakyRuns}/${summary.totals.executions}`);
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}
console.log(`PASS: benchmark corpus is stable; JSON and Markdown written to ${basename(ARTIFACT_ROOT)}`);
