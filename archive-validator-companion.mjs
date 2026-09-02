import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const Validator = require('./archive-validator.js');
const root = resolve(process.argv[2] || '.');
const plan = JSON.parse(readFileSync(join(root, 'validation-plan.json'), 'utf8'));
const startedAt = Date.now();
const diagnostics = [];
const routeResults = [];
const requestedUrls = [];
const serverRequests = [];
const blockedExternalRequests = new Set();
let serviceWorkerControlled = false;

const addDiagnostic = (input) => {
  const item = Validator.diagnostic(input);
  const signature = JSON.stringify(item);
  if (!diagnostics.some((existing) => JSON.stringify(existing) === signature)) diagnostics.push(item);
};

const diskFiles = new Map();
const collectFiles = (directory, prefix = '') => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = Validator.normalizePath(join(prefix, entry.name));
    if (entry.isDirectory()) collectFiles(path, relative);
    else if (entry.isFile()) {
      const data = readFileSync(path);
      diskFiles.set(relative, { path: relative, text: /\.html?$/i.test(relative) ? data.toString('utf8') : null });
    }
  }
};
collectFiles(root);
for (const item of [...(plan.baselineDiagnostics || []), ...Validator.inspectArchive({ files: diskFiles, requiredFiles: plan.requiredFiles || [] })]) addDiagnostic(item);

const mimeType = (path) => ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json'
}[extname(path).toLowerCase()] || 'application/octet-stream');

const routePaths = new Map((plan.routes || []).filter((route) => route.localPath).map((route) => {
  const url = new URL(route.url, 'http://localhost/');
  return [`${url.pathname}${url.search}`, Validator.normalizePath(route.localPath)];
}));

const safePath = (pathname) => {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (error) { return null; }
  const relative = Validator.normalizePath(decoded) || 'index.html';
  const full = normalize(join(root, relative));
  return full === root || full.startsWith(`${root}${sep}`) ? { full, relative } : null;
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}/`);
  const routePath = routePaths.get(`${url.pathname}${url.search}`);
  const candidate = safePath(routePath || url.pathname);
  const entry = { method: request.method, url: url.href, path: candidate && candidate.relative || null, status: 0 };
  serverRequests.push(entry);
  if (!candidate || !existsSync(candidate.full) || !statSync(candidate.full).isFile()) {
    entry.status = 404;
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Not found');
    return;
  }
  entry.status = 200;
  response.writeHead(200, { 'content-type': mimeType(candidate.full), 'cache-control': 'no-store' });
  if (request.method === 'HEAD') response.end();
  else response.end(readFileSync(candidate.full));
});

const freePort = () => new Promise((resolvePort, reject) => {
  const socket = createTcpServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const chromePath = () => {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform === 'linux' && '/usr/bin/google-chrome',
    process.platform === 'linux' && '/usr/bin/chromium',
    process.platform === 'linux' && '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(existsSync) || (process.platform === 'linux' ? 'google-chrome' : null);
};

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  command(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) { this.listeners.add(listener); }
  close() { this.socket.close(); }
}

const connect = async (port) => {
  let version;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch (error) {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start.');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await once(socket, 'open');
  return new CdpClient(socket);
};

const waitFor = async (callback, timeoutMs) => {
  const waitStartedAt = Date.now();
  while (Date.now() - waitStartedAt < timeoutMs) {
    try { if (await callback()) return true; } catch (error) {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
};

let chrome;
let client;
let profile;
try {
  const path = chromePath();
  if (!path) throw new Error('Google Chrome or Chromium was not found. Set CHROME_PATH and retry.');
  const serverPort = await freePort();
  const debugPort = await freePort();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(serverPort, '127.0.0.1', resolveListen);
  });
  const origin = `http://127.0.0.1:${serverPort}`;
  profile = mkdtempSync(join(tmpdir(), 'opensave-validator-'));
  chrome = spawn(path, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });
  client = await connect(debugPort);
  const { targetId } = await client.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.command('Target.attachToTarget', { targetId, flatten: true });
  const validationSessions = new Set([sessionId]);
  const configureSession = async (targetSessionId, resume = false) => {
    validationSessions.add(targetSessionId);
    await Promise.all([
      client.command('Network.enable', {}, targetSessionId).catch(() => {}),
      client.command('Runtime.enable', {}, targetSessionId).catch(() => {}),
      client.command('Log.enable', {}, targetSessionId).catch(() => {}),
      client.command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, targetSessionId).catch(() => {})
    ]);
    if (resume) await client.command('Runtime.runIfWaitingForDebugger', {}, targetSessionId).catch(() => {});
  };
  client.on((message) => {
    if (message.method === 'Target.attachedToTarget' && validationSessions.has(message.sessionId)) {
      configureSession(message.params.sessionId, true).catch(() => {});
      return;
    }
    if (!validationSessions.has(message.sessionId)) return;
    if (message.method === 'Fetch.requestPaused') {
      let requestOrigin = '';
      try { requestOrigin = new URL(message.params.request.url).origin; } catch (error) {}
      if (requestOrigin && requestOrigin !== origin) {
        blockedExternalRequests.add(message.params.request.url);
        client.command('Fetch.fulfillRequest', {
          requestId: message.params.requestId,
          responseCode: 503,
          responseHeaders: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }, { name: 'x-opensave-validator-blocked', value: 'external-request' }],
          body: Buffer.from('Blocked by openSave validator').toString('base64')
        }, message.sessionId).catch(() => {});
      } else {
        client.command('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId).catch(() => {});
      }
      return;
    }
    if (message.method === 'Network.requestWillBeSent') requestedUrls.push(message.params.request.url);
    if (message.method === 'Runtime.exceptionThrown') addDiagnostic({ category: 'replay-runtime-failure', code: 'runtime-exception', severity: 'error', message: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text || 'Runtime exception', url: message.params.exceptionDetails.url || null });
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/Failed to load resource/i.test(message.params.entry.text)) addDiagnostic({ category: 'replay-runtime-failure', code: 'console-error', severity: 'warning', message: message.params.entry.text, url: message.params.entry.url || null });
  });
  await Promise.all([
    client.command('Page.enable', {}, sessionId),
    configureSession(sessionId),
    client.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [
        { type: 'iframe', exclude: false },
        { type: 'worker', exclude: false },
        { type: 'shared_worker', exclude: false },
        { type: 'service_worker', exclude: false }
      ]
    }, sessionId)
  ]);
  const evaluate = async (expression) => {
    const result = await client.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Validation expression failed.');
    return result.result && result.result.value;
  };
  const validateRoute = async (route, rootRoute = false) => {
    const routeStartedAt = Date.now();
    const sourceUrl = new URL(route.url, origin);
    const validationUrl = `${origin}${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`;
    await client.command('Page.navigate', { url: validationUrl }, sessionId);
    const markerReady = await waitFor(() => evaluate(`document.documentElement?.dataset.opensaveValidationMarker === ${JSON.stringify(route.expectedMarker)}`), plan.budget.maxRouteDurationMs);
    if (!markerReady) {
      addDiagnostic({ category: 'replay-runtime-failure', code: 'route-content-mismatch', severity: 'error', routeId: route.routeId, url: route.url, message: 'Saved route did not render its captured checkpoint.', evidence: { expectedMarker: route.expectedMarker } });
      routeResults.push({ routeId: route.routeId, url: route.url, expectedMarker: route.expectedMarker, actualMarker: null, status: 'failed', durationMs: Date.now() - routeStartedAt });
      return;
    }
    if (rootRoute) {
      serviceWorkerControlled = await waitFor(() => evaluate(`(async () => Boolean((await navigator.serviceWorker?.getRegistration('/'))?.active))()`), plan.budget.maxServiceWorkerDurationMs || plan.budget.maxRouteDurationMs);
      if (serviceWorkerControlled) {
        await client.command('Page.navigate', { url: validationUrl }, sessionId);
        serviceWorkerControlled = await waitFor(() => evaluate(`Boolean(navigator.serviceWorker.controller) && document.documentElement?.dataset.opensaveValidationMarker === ${JSON.stringify(route.expectedMarker)}`), plan.budget.maxRouteDurationMs);
      }
      if (!serviceWorkerControlled) {
        const registration = await evaluate(`(async () => ({
          secureContext: isSecureContext,
          controller: navigator.serviceWorker?.controller?.scriptURL || null,
          registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map((item) => ({ scope: item.scope, installing: item.installing?.state || null, waiting: item.waiting?.state || null, active: item.active?.state || null, scriptURL: item.active?.scriptURL || item.installing?.scriptURL || item.waiting?.scriptURL || null })) : [],
          registrationError: 'serviceWorker' in navigator ? await Promise.race([
            navigator.serviceWorker.register('/sitesaver-sw.js').then(() => '', (error) => error.message),
            new Promise((resolve) => setTimeout(() => resolve('registration-timeout'), 1000))
          ]) : 'Service worker API unavailable'
        }))()`).catch((error) => ({ evaluationError: error.message }));
        addDiagnostic({ category: 'replay-runtime-failure', code: 'service-worker-uncontrolled', severity: 'error', message: 'Generated service worker did not control the archive.', evidence: { registration, serverRequests: serverRequests.slice(-50) } });
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const actualMarker = await evaluate('document.documentElement.dataset.opensaveValidationMarker || null').catch(() => null);
    const status = actualMarker === route.expectedMarker ? 'ready' : 'failed';
    if (status === 'failed') addDiagnostic({ category: 'replay-runtime-failure', code: 'route-content-mismatch', severity: 'error', routeId: route.routeId, url: route.url, message: 'Saved route rendered the wrong captured checkpoint.', evidence: { expectedMarker: route.expectedMarker, actualMarker } });
    routeResults.push({ routeId: route.routeId, url: route.url, expectedMarker: route.expectedMarker, actualMarker, status, durationMs: Date.now() - routeStartedAt });
  };

  await validateRoute({ routeId: 'root', url: plan.root.url, expectedMarker: plan.root.expectedMarker }, true);
  for (const route of plan.routes || []) {
    if (Date.now() - startedAt >= plan.budget.maxDurationMs) break;
    await validateRoute(route);
  }
  for (const url of blockedExternalRequests) addDiagnostic({ category: 'replay-runtime-failure', code: 'external-request-attempt', severity: 'warning', url, message: 'Archive attempted external network egress; the validator blocked it before network access.' });
  const required = new Set((plan.requiredFiles || []).map((file) => Validator.normalizePath(file.path)));
  for (const request of serverRequests.filter((item) => item.status >= 400)) addDiagnostic({ category: 'rewrite-failure', code: required.has(request.path) ? 'failed-required-request' : 'unsaved-local-request', severity: required.has(request.path) ? 'error' : 'info', path: request.path, url: request.url, message: `Local request failed with HTTP ${request.status}.` });
  const replayLedger = await evaluate(`fetch('/replay-misses.json', { cache: 'no-store' }).then((response) => response.json())`).catch(() => null);
  for (const miss of replayLedger && replayLedger.runtimeMisses || []) addDiagnostic({ category: 'replay-runtime-failure', code: `runtime-replay-${miss.reasonCode || 'miss'}`, severity: 'warning', message: `Replay runtime miss: ${miss.reasonCode || 'unknown'}.`, evidence: miss.evidence || null });
  const result = Validator.finalize({
    plan,
    diagnostics,
    startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    zeroEgressVerified: true,
    serviceWorkerControlled,
    checkedRoutes: routeResults.length,
    totalRoutes: (plan.routes || []).length + 1,
    requiredFilesChecked: (plan.requiredFiles || []).length,
    routeResults,
    overhead: { durationMs: Date.now() - startedAt, routeCount: routeResults.length, requestCount: requestedUrls.length, blockedExternalRequestCount: blockedExternalRequests.size }
  });
  writeFileSync(join(root, 'validation-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  const reportPath = join(root, 'sitesaver-report.json');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.validation = result;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const manifestPath = join(root, 'sitesaver-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.validationStatus = result.status;
    manifest.validationDurationMs = result.durationMs;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`openSave validation: ${result.status} (${result.checkedRoutes}/${result.totalRoutes} routes, ${result.diagnostics.length} diagnostics)`);
  if (result.status === 'failed') process.exitCode = 1;
} catch (error) {
  const result = Validator.finalize({ diagnostics: [{ category: 'validator-infrastructure', code: 'local-validator-failed', severity: 'error', message: error.message }], startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt });
  writeFileSync(join(root, 'validation-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    await client.command('Browser.close').catch(() => {});
    client.close();
  }
  if (chrome && chrome.exitCode == null) {
    await Promise.race([once(chrome, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
    if (chrome.exitCode == null) chrome.kill();
  }
  if (server.listening) await new Promise((resolveClose) => server.close(() => resolveClose()));
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
