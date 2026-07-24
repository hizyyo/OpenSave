let activeTabId = null;
let activeOrigin = '';
const capturedBodies = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'attach') {
    attach(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'fullCapture') {
    fullCapture(msg.tabId, sendResponse);
    return true;
  }
  if (msg.action === 'startBuilder') {
    startBuilder(msg.tabId).then(sendResponse);
    return true;
  }
});

const KEEP_TYPES = ['text/html', 'text/css', 'application/javascript', 'text/javascript', 'application/x-javascript', 'application/json', 'image/', 'font/', 'application/font', 'application/x-font', 'audio/', 'video/', 'application/octet-stream', 'text/plain', 'application/manifest+json', 'application/wasm'];

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
  if (debuggeeId.tabId !== activeTabId) return;
  if (method === 'Network.responseReceived') {
    const url = params.response.url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const mt = (params.response.mimeType || '').toLowerCase();
    if (!KEEP_TYPES.some(t => mt.startsWith(t))) return;
    chrome.debugger.sendCommand({ tabId: activeTabId }, 'Network.getResponseBody', {
      requestId: params.requestId
    }, (body) => {
      if (chrome.runtime.lastError || !body || !activeTabId) return;
      try {
        const parsed = new URL(url);
        let localPath = parsed.pathname;
        const isMainOrigin = parsed.origin === activeOrigin;
        if (localPath === '/' || localPath === '') {
          localPath = isMainOrigin ? '/index.html' : '/' + parsed.hostname + '.html';
        }
        if (localPath.endsWith('/')) localPath += 'index.html';
        const key = url + '|' + localPath;
        if (!capturedBodies.has(key)) {
          capturedBodies.set(key, {
            url, localPath,
            mimeType: params.response.mimeType,
            body: body.body,
            base64Encoded: body.base64Encoded
          });
        }
      } catch(e) {}
    });
  }
});

async function attach(tid) {
  if (activeTabId) await detach();
  activeTabId = tid;
  capturedBodies.clear();
  try {
    const tab = await chrome.tabs.get(tid);
    activeOrigin = new URL(tab.url).origin;
  } catch(e) { activeOrigin = ''; }
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId: tid }, '1.3', () => {
      if (chrome.runtime.lastError) { activeTabId = null; resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      chrome.debugger.sendCommand({ tabId: tid }, 'Network.enable', {}, () => {
        if (chrome.runtime.lastError) { chrome.debugger.detach({ tabId: tid }); activeTabId = null; resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve({ ok: true });
      });
    });
  });
}

async function fullCapture(tid, sendResponse) {
  const reply = (data) => { try { sendResponse(data); } catch(e) {} };

  // Attach debugger
  const att = await attach(tid);
  if (!att.ok) { reply({ ok: false, error: att.error }); return; }

  // Get domain for filename
  let domain = '';
  try {
    const tab = await chrome.tabs.get(tid);
    domain = new URL(tab.url).hostname;
  } catch(e) { domain = 'site'; }

  // Switch to tab so scrolling works
  await chrome.tabs.update(tid, { active: true });
  await sleep(300);

  // Reload page
  await chrome.debugger.sendCommand({ tabId: tid }, 'Page.enable', {}).catch(() => {});
  await chrome.tabs.reload(tid);

  // Wait for page load
  await waitForPageLoad(tid);

  // Extra wait for all network requests to complete
  await sleep(3000);

  // Scroll to trigger lazy resources
  try {
    await chrome.debugger.sendCommand({ tabId: tid }, 'Runtime.evaluate', {
      expression: `(async()=>{const d=ms=>new Promise(r=>setTimeout(r,ms));for(let p=0;p<document.body.scrollHeight;p+=500){scrollTo(0,p);await d(100)}scrollTo(0,0);return 1})()`,
      awaitPromise: true
    });
    await sleep(2000);
  } catch(e) {}

  // Get final HTML via DOM API (more reliable than Runtime.evaluate)
  let html = '';
  let htmlMethod = 'none';
  try {
    await chrome.debugger.sendCommand({ tabId: tid }, 'DOM.enable', {}).catch(() => {});
    const doc = await chrome.debugger.sendCommand({ tabId: tid }, 'DOM.getDocument', { depth: 0 }).catch(() => {});
    if (doc && doc.root && doc.root.nodeId) {
      const r = await chrome.debugger.sendCommand({ tabId: tid }, 'DOM.getOuterHTML', { nodeId: doc.root.nodeId }).catch(() => {});
      if (r && r.outerHTML) { html = r.outerHTML; htmlMethod = 'DOM.getOuterHTML'; }
    }
  } catch(e) {}

  // Fallback: try Runtime.evaluate (for pages where DOM API is blocked)
  if (!html.includes('<html') && !html.includes('<!DOCTYPE')) {
    try {
      const r = await chrome.debugger.sendCommand({ tabId: tid }, 'Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true
      });
      html = r.result.value || '';
      htmlMethod = 'Runtime.evaluate';
    } catch(e) {}
  }

  // Last resort: try network response body
  if (!html.includes('<html') && !html.includes('<!DOCTYPE')) {
    for (const [, b] of capturedBodies) {
      try {
        const d = b.base64Encoded ? atob(b.body) : b.body;
        if (d.includes('<html') || d.includes('<!DOCTYPE')) { html = d; htmlMethod = 'network:' + b.localPath; break; }
      } catch(e) {}
    }
  }

  // Collect all bodies
  const allBodies = Array.from(capturedBodies.values());

  // Detach
  activeTabId = null;
  await chrome.debugger.detach({ tabId: tid }).catch(() => {});

  reply({ ok: true, html, bodies: allBodies, domain, htmlMethod });
}

async function startBuilder(tid) {
  if (activeTabId !== tid) return { ok: false, error: 'Сначала начните запись через попап' };

  try {
    await chrome.debugger.sendCommand({ tabId: tid }, 'Runtime.evaluate', {
      expression: `(async()=>{const d=ms=>new Promise(r=>setTimeout(r,ms));for(let p=0;p<20000;p+=400){scrollTo(0,p);await d(80)}scrollTo(0,0);await d(500);return 1})()`,
      awaitPromise: true
    });
    await sleep(2000);
  } catch(e) {}

  let html = '';
  try {
    const r = await chrome.debugger.sendCommand({ tabId: tid }, 'Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    });
    html = r.result.value;
  } catch(e) {}

  const allBodies = Array.from(capturedBodies.values());
  activeTabId = null;
  await chrome.debugger.detach({ tabId: tid });

  return { ok: true, html, bodies: allBodies, title: 'site' };
}

function waitForPageLoad(tid) {
  return new Promise((resolve) => {
    const handler = (debuggeeId, method, params) => {
      if (debuggeeId.tabId !== tid) return;
      if (method === 'Page.frameStoppedLoading') {
        chrome.debugger.onEvent.removeListener(handler);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(handler);
    setTimeout(() => { chrome.debugger.onEvent.removeListener(handler); resolve(); }, 15000);
  });
}

async function detach() {
  if (!activeTabId) return;
  await chrome.debugger.detach({ tabId: activeTabId }).catch(() => {});
  activeTabId = null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
