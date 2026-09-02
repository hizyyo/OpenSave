import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = new URL('..', import.meta.url);
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
if (process.platform === 'win32' && !existsSync(chromePath)) throw new Error(`Chrome was not found: ${chromePath}`);

const runCompanion = async (directory) => {
  const child = spawn(process.execPath, ['archive-validator-companion.mjs', '.'], {
    cwd: directory,
    env: { ...process.env, CHROME_PATH: chromePath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  const report = JSON.parse(readFileSync(join(directory, 'validation-report.json'), 'utf8'));
  return { code, stdout, stderr, report };
};

const createFixture = async (name, broken = false) => {
  const directory = mkdtempSync(join(tmpdir(), `opensave-validator-${name}-`));
  await cp(new URL('../archive-validator.js', import.meta.url), join(directory, 'archive-validator.js'));
  await cp(new URL('../archive-validator-companion.mjs', import.meta.url), join(directory, 'archive-validator-companion.mjs'));
  const runtime = broken
    ? 'setTimeout(() => { throw new Error("SEEDED_VALIDATOR_RUNTIME_ERROR"); }, 50);'
    : 'document.documentElement.dataset.runtimeReady = "true";';
  const scriptTags = broken
    ? '<script src="/runtime.js" integrity="sha384-stale"></script><script src="/runtime.js"></script><script src="https://external.opensave.test/blocked.js"></script>'
    : '<script src="/runtime.js"></script>';
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html data-opensave-validation-marker="root"><head><meta charset="utf-8">${broken ? '<link rel="stylesheet" href="/missing.css">' : ''}<script src="/sitesaver-offline.js"></script>${scriptTags}</head><body>ROOT</body></html>`);
  writeFileSync(join(directory, 'runtime.js'), runtime);
  writeFileSync(join(directory, 'sitesaver-offline.js'), `navigator.serviceWorker.register('/sitesaver-sw.js');`);
  writeFileSync(join(directory, 'sitesaver-sw.js'), `self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));`);
  writeFileSync(join(directory, 'replay-misses.json'), JSON.stringify({ schemaVersion: 1, captureMisses: [], runtimeMisses: [] }));
  writeFileSync(join(directory, 'sitesaver-report.json'), JSON.stringify({}));
  writeFileSync(join(directory, 'sitesaver-manifest.json'), JSON.stringify({ format: 'sitesaver-offline-archive', version: 3 }));
  const routes = broken ? [{ routeId: 'broken-route', url: 'https://source.test/broken', localPath: 'broken.html', expectedMarker: 'expected-route' }] : [];
  if (broken) writeFileSync(join(directory, 'broken.html'), '<!doctype html><html data-opensave-validation-marker="wrong-route"><body>WRONG</body></html>');
  const requiredFiles = ['index.html', 'runtime.js', 'sitesaver-offline.js', 'sitesaver-sw.js', 'replay-misses.json', 'sitesaver-report.json', 'sitesaver-manifest.json', ...(broken ? ['missing.css', 'broken.html'] : [])].map((path) => ({ path, critical: true }));
  writeFileSync(join(directory, 'validation-plan.json'), JSON.stringify({
    schemaVersion: 1,
    root: { url: '/', expectedMarker: 'root' },
    routes,
    requiredFiles,
    budget: { maxRoutes: 4, maxDurationMs: 20000, maxRouteDurationMs: 5000 },
    truncatedRouteCount: 0,
    baselineDiagnostics: []
  }, null, 2));
  writeFileSync(join(directory, 'validation-report.json'), JSON.stringify({ status: 'pending' }));
  return directory;
};

const directories = [];
try {
  const readyDirectory = await createFixture('ready');
  directories.push(readyDirectory);
  const ready = await runCompanion(readyDirectory);
  assert.equal(ready.code, 0, `Companion failed: stdout=${ready.stdout}\nstderr=${ready.stderr}\nreport=${JSON.stringify(ready.report, null, 2)}`);
  assert.equal(ready.report.status, 'ready', JSON.stringify(ready.report, null, 2));
  assert.equal(ready.report.serviceWorkerControlled, true);
  assert.equal(ready.report.zeroEgressVerified, true);
  assert.equal(ready.report.routes[0].actualMarker, 'root');

  const brokenDirectory = await createFixture('broken', true);
  directories.push(brokenDirectory);
  const broken = await runCompanion(brokenDirectory);
  assert.equal(broken.code, 1);
  assert.equal(broken.report.status, 'failed');
  assert.equal(broken.report.zeroEgressVerified, true);
  const codes = new Set(broken.report.diagnostics.map((item) => item.code));
  for (const code of ['required-file-missing', 'stale-subresource-integrity', 'external-executable-reference', 'duplicate-executable-reference', 'external-request-attempt', 'runtime-exception', 'route-content-mismatch']) {
    assert(codes.has(code), `Expected seeded validator diagnostic: ${code}\n${JSON.stringify(broken.report, null, 2)}`);
  }
  assert.equal(JSON.parse(readFileSync(join(brokenDirectory, 'sitesaver-manifest.json'), 'utf8')).validationStatus, 'failed');
  assert.equal(JSON.parse(readFileSync(join(brokenDirectory, 'sitesaver-report.json'), 'utf8')).validation.status, 'failed');
} finally {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('PASS: local validator verifies ready archives and detects all seeded failure categories with zero egress');
