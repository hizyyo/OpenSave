import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connectBrowser, delay, evaluate } from './benchmark/cdp-client.mjs';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const LiveDomState = require('../live-dom-state.js');
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');
if (process.platform === 'win32' && !existsSync(chromePath)) throw new Error(`Chrome was not found: ${chromePath}`);

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  server.once('listening', () => {
    const selectedPort = server.address().port;
    server.close(() => resolve(selectedPort));
  });
  server.once('error', reject);
});
const profile = join(tmpdir(), `opensave-live-dom-${process.pid}-${Date.now()}`);
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore'] });

let client;
try {
  ({ client } = await connectBrowser(port));
  const { targetId } = await client.command('Target.createTarget', { url: 'about:blank' });
  const sessionId = await client.attach(targetId);
  await client.command('Runtime.enable', {}, sessionId);

  await evaluate(client, sessionId, `(() => {
    document.write('<!doctype html><html><head><style id="dynamic">.before { color: red; }</style></head><body><input id="plain"><input id="password" type="password"><input id="private" data-private><input id="token-field" name="access_token"><input id="card-field" name="card_number"><input id="upload" type="file"><textarea id="notes"></textarea><select id="choice"><option>A</option><option>B</option></select><details id="details"><summary>Open</summary></details><div id="host"></div><canvas id="canvas" width="4" height="4"></canvas><canvas id="tainted" width="4" height="4"></canvas><img id="blob-image"></body></html>');
    document.getElementById('plain').value = 'VISIBLE_VALUE'; document.getElementById('password').value = 'SECRET_PASSWORD'; document.getElementById('private').value = 'SECRET_PRIVATE'; document.getElementById('token-field').value = 'SECRET_TOKEN_VALUE'; document.getElementById('card-field').value = '4111111111111111'; document.getElementById('notes').value = 'CURRENT_NOTES'; document.getElementById('choice').selectedIndex = 1; document.getElementById('details').open = true;
    document.getElementById('dynamic').sheet.insertRule('.after { color: blue; }');
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); sheet.replaceSync('.inside { color: rgb(20, 80, 120); }'); root.adoptedStyleSheets = [sheet]; root.innerHTML = '<span class="inside">SHADOW_CURRENT</span>';
    const closed = document.createElement('div'); closed.id = 'closed-host'; closed.attachShadow({ mode: 'closed' }).innerHTML = '<span>SECRET_CLOSED</span>'; document.body.append(closed);
    document.getElementById('canvas').getContext('2d').fillRect(0, 0, 4, 4);
    document.getElementById('tainted').toDataURL = () => { throw new DOMException('Tainted canvas', 'SecurityError'); };
    document.getElementById('blob-image').src = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }));
    return true;
  })()`);
  const snapshot = await evaluate(client, sessionId, LiveDomState.expression({ closedShadowRoots: 1 }));

  assert.equal(snapshot.version, 1);
  assert.match(snapshot.html, /value="VISIBLE_VALUE"/);
  assert.match(snapshot.html, /CURRENT_NOTES/);
  assert.match(snapshot.html, /<option selected="">B<\/option>/);
  assert.match(snapshot.html, /<details[^>]*open=""/);
  assert.match(snapshot.html, /data-opensave-shadowroot="open"/);
  assert.match(snapshot.html, /SHADOW_CURRENT/);
  assert.match(snapshot.html, /data-opensave-style="adopted"/);
  assert.match(snapshot.html, /\.after \{ color: blue; \}/);
  assert.match(snapshot.html, /data-opensave-canvas-fallback=""/);
  assert.match(snapshot.html, /background-image:url\(&quot;data:image\/png;base64,/);
  assert.match(snapshot.html, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(snapshot.html, /SECRET_PASSWORD|SECRET_PRIVATE|SECRET_TOKEN_VALUE|4111111111111111|SECRET_CLOSED/);
  assert.equal(snapshot.summary.redactedFields, 5);
  assert.equal(snapshot.summary.shadowRoots, 1);
  assert.equal(snapshot.summary.adoptedStyleSheets, 1);
  assert.equal(snapshot.summary.canvases, 1);
  assert.equal(snapshot.summary.blobUrls, 1);
  assert(snapshot.diagnostics.some((item) => item.code === 'canvas-unavailable'));
  assert(snapshot.diagnostics.some((item) => item.code === 'closed-shadow-root-unavailable'));
  console.log('PASS: live DOM forms, disclosures, shadow styles, canvas, blob URLs, and redaction');
} finally {
  if (client) {
    try { await client.command('Browser.close'); } catch (error) {}
    client.close();
  }
  if (chrome.exitCode == null) {
    await Promise.race([once(chrome, 'exit'), delay(3000)]);
    if (chrome.exitCode == null) chrome.kill();
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
