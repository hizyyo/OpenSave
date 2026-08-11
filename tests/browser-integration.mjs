import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createHash } from 'node:crypto';

const archiveDirectory = process.argv[2];
const chromePath = process.argv[3] || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!archiveDirectory || !existsSync(archiveDirectory)) {
  console.error('Usage: node tests/browser-integration.mjs <unpacked-sitesaver-archive> [chrome.exe]');
  process.exit(2);
}
if (!existsSync(chromePath)) {
  console.error(`Chrome was not found: ${chromePath}`);
  process.exit(2);
}

const mimeTypes = {
  '.avif': 'image/avif', '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2'
};

const getFreePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  server.once('listening', () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
  server.once('error', reject);
});

const createStaticServer = (root) => createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const requested = normalize(join(root, (pathname === '/' ? 'index.html' : pathname).replace(/^[/\\]+/, '')));
  if (!requested.startsWith(resolve(root)) || !existsSync(requested) || !statSync(requested).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': mimeTypes[extname(requested)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(requested));
});

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.handle(JSON.parse(event.data)));
  }

  handle(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
      return;
    }
    (this.listeners.get(message.method) || []).forEach((listener) => listener(message.params || {}));
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }
}

const staticPort = await getFreePort();
const debugPort = await getFreePort();
const server = createStaticServer(resolve(archiveDirectory));
server.listen(staticPort, '127.0.0.1');
await once(server, 'listening');

const profileDirectory = join(process.env.TEMP || process.cwd(), `sitesaver-chrome-${Date.now()}`);
let chromeStartError = '';
let chromeStderr = '';
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--remote-allow-origins=*',
  `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDirectory}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.once('error', (error) => { chromeStartError = error.message; });
chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString(); });

const cleanup = async () => {
  server.close();
  if (!chrome.killed) chrome.kill();
};

try {
  let version;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
      break;
    } catch (error) {
      await delay(100);
    }
  }
  if (!version) {
    const detail = [chromeStartError, chromeStderr.trim()].filter(Boolean).join('\n');
    throw new Error(`Chrome remote debugging did not start${detail ? `:\n${detail}` : ''}`);
  }

  let pageTarget;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (pageTarget) break;
    await delay(100);
  }
  if (!pageTarget) throw new Error('Chrome did not create a debuggable page target');

  const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await once(socket, 'open');
  const cdp = new CdpClient(socket);
  const requestedUrls = [];
  const consoleErrors = [];
  const exceptions = [];
  cdp.on('Network.requestWillBeSent', ({ request }) => requestedUrls.push(request.url));
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => exceptions.push({
    text: exceptionDetails.exception?.description || exceptionDetails.text || 'Runtime exception',
    url: exceptionDetails.url,
    line: exceptionDetails.lineNumber,
    column: exceptionDetails.columnNumber
  }));
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') consoleErrors.push({ text: entry.text, url: entry.url, line: entry.lineNumber });
  });

  await Promise.all([
    cdp.command('Page.enable'), cdp.command('Network.enable'), cdp.command('Runtime.enable'), cdp.command('Log.enable')
  ]);
  await cdp.command('Page.navigate', { url: `http://127.0.0.1:${staticPort}/` });
  await delay(2500);
  await cdp.command('Runtime.evaluate', { expression: 'navigator.serviceWorker.ready', awaitPromise: true });
  const rootPage = await cdp.command('Runtime.evaluate', { expression: '({ text: document.body.innerText.slice(0, 200), controlled: Boolean(navigator.serviceWorker.controller) })', returnByValue: true });
  const rootErrorCount = consoleErrors.length + exceptions.length;
  await cdp.command('Page.navigate', { url: `http://127.0.0.1:${staticPort}/sitesaver-test-route` });
  await delay(1500);

  const page = await cdp.command('Runtime.evaluate', { expression: '({ title: document.title, text: document.body.innerText.slice(0, 200), controlled: Boolean(navigator.serviceWorker.controller) })', returnByValue: true });
  const screenshot = await cdp.command('Page.captureScreenshot', { format: 'png' });
  const artifactsDirectory = join(process.cwd(), 'tests', 'artifacts');
  mkdirSync(artifactsDirectory, { recursive: true });
  const screenshotPath = join(artifactsDirectory, `${basename(resolve(archiveDirectory))}.png`);
  const screenshotBytes = Buffer.from(screenshot.data, 'base64');
  writeFileSync(screenshotPath, screenshotBytes);
  const screenshotHash = createHash('sha256').update(screenshotBytes).digest('hex');
  const baselineDirectory = process.env.SITESAVER_BASELINE_DIR;
  const baselinePath = baselineDirectory && join(resolve(baselineDirectory), `${basename(resolve(archiveDirectory))}.png`);
  const archiveBase = `http://127.0.0.1:${staticPort}/`;
  const externalRequests = requestedUrls.filter((url) => /^https?:/i.test(url) && !url.startsWith(archiveBase));
  const failures = [];
  if (!page.result.value.controlled) failures.push('Service worker did not control the offline archive after navigation');
  if (!rootPage.result.value.text) failures.push('Root route rendered an empty document');
  if (rootErrorCount) failures.push('Root route produced console or runtime errors before SPA navigation');
  if (!page.result.value.text) failures.push('SPA route rendered an empty document');
  if (externalRequests.length) failures.push(`External network requests: ${[...new Set(externalRequests)].join(', ')}`);
  if (exceptions.length) failures.push(`Runtime exceptions: ${exceptions.map((entry) => entry.text).join('; ')}`);
  if (consoleErrors.length) failures.push(`Console errors: ${consoleErrors.map((entry) => entry.text).join('; ')}`);
  if (baselinePath && existsSync(baselinePath)) {
    const baselineHash = createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
    if (baselineHash !== screenshotHash) failures.push(`Screenshot differs from baseline: ${baselinePath}`);
  }

  const result = {
    archive: basename(resolve(archiveDirectory)),
    requested: requestedUrls.length,
    externalRequests: [...new Set(externalRequests)],
    consoleErrors,
    exceptions,
    serviceWorkerControlled: page.result.value.controlled,
    rootText: rootPage.result.value.text,
    routeText: page.result.value.text,
    screenshot: screenshotPath,
    screenshotHash
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('PASS: offline archive passed headless Chrome integration checks');
} finally {
  await cleanup();
}
