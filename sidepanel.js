const btnCapture = document.getElementById('btnCapture');
const progress = document.getElementById('progress');
const statusEl = document.getElementById('status');
const fillEl = document.getElementById('fill');
const logEl = document.getElementById('log');

function log(msg, type) {
  logEl.style.display = 'block';
  const div = document.createElement('div');
  div.className = type || '';
  div.textContent = msg;
  logEl.appendChild(div);
}

function status(msg, pct) {
  if (pct !== undefined) fillEl.style.width = pct + '%';
  statusEl.textContent = msg;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractUrls(html, origin) {
  const urls = [];
  const seen = new Set();
  const patterns = [
    /(?:src|href)="([^"]+)"/gi,
    /(?:src|href)='([^']+)'/gi,
    /data-src="([^"]+)"/gi,
    /srcset="([^"]+)"/gi,
    /url\(["']?([^"')]+)["']?\)/gi
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      let val = m[1];
      if (pattern.toString().includes('srcset')) {
        val.split(',').forEach(s => {
          const p = s.trim().split(/\s+/)[0];
          if (p && !p.startsWith('data:')) {
            try { const a = new URL(p, origin).href; if (!seen.has(a)) { seen.add(a); urls.push(a); } } catch(e) {}
          }
        });
      } else if (!val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
        try { const a = new URL(val, origin).href; if (!seen.has(a)) { seen.add(a); urls.push(a); } } catch(e) {}
      }
    }
  }
  html.replace(/"https?:\/\/[^"'\s<]+"/g, (match) => {
    const u = match.replace(/"/g, '');
    try { const a = new URL(u).href; if (!seen.has(a) && new URL(a).origin === origin) { seen.add(a); urls.push(a); } } catch(e) {}
  });
  return urls;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

btnCapture.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) { status('Нет активной вкладки'); return; }

  btnCapture.disabled = true;
  btnCapture.textContent = 'Захват...';
  progress.style.display = 'block';
  log('');
  status('Подключаюсь...', 5);

  const resp = await chrome.runtime.sendMessage({ action: 'fullCapture', tabId: tab.id });

  if (!resp || !resp.ok) {
    status('Ошибка: ' + ((resp && resp.error) || 'нет ответа'));
    log('✖ ' + ((resp && resp.error) || 'нет ответа'), 'err');
    btnCapture.disabled = false;
    btnCapture.textContent = 'Захватить сайт';
    return;
  }

  const { html, bodies, domain, htmlMethod } = resp;
  log('HTML: ' + (html.length / 1024).toFixed(1) + ' KB (метод: ' + htmlMethod + ')');
  log('Первые 200 символов: ' + html.substring(0, 200).replace(/\n/g, ' '));
  log('Ресурсов из debugger: ' + (bodies || []).length);
  log('');

  // Build resources
  const resources = [];
  const seenPaths = new Set();
  const urlToRelPath = new Map();

  for (const b of (bodies || [])) {
    if (seenPaths.has(b.localPath)) continue;
    seenPaths.add(b.localPath);
    const relPath = b.localPath.replace(/^\//, '');
    resources.push({
      localPath: relPath,
      url: b.url,
      data: b.body,
      isBase64: b.base64Encoded,
      mimeType: b.mimeType
    });
    urlToRelPath.set(b.url, relPath);
    try { urlToRelPath.set(new URL(b.url).pathname, relPath); } catch(e) {}
    log('✔ ' + relPath, 'ok');
  }

  let origin = '';
  if (bodies && bodies.length > 0) {
    try { origin = new URL(bodies[0].url).origin; } catch(e) {}
  }

  // Fetch missing resources from HTML
  const htmlUrls = extractUrls(html, origin);
  let fetchedCount = 0;
  for (let i = 0; i < htmlUrls.length; i++) {
    const url = htmlUrls[i];
    status('Загрузка ' + (i + 1) + '/' + htmlUrls.length, 10 + Math.round((i / htmlUrls.length) * 30));

    let localPath;
    try {
      const parsed = new URL(url);
      localPath = parsed.pathname.replace(/^\//, '');
      if (!localPath || localPath === '/') localPath = 'index.html';
      if (localPath.endsWith('/')) localPath += 'index.html';
    } catch(e) { continue; }

    if (seenPaths.has(localPath)) continue;

    try {
      const resp2 = await fetch(url, { credentials: 'include' });
      const blob = await resp2.blob();
      resources.push({ localPath, url, data: blob, isBase64: false, mimeType: resp2.headers.get('content-type') || '' });
      seenPaths.add(localPath);
      urlToRelPath.set(url, localPath);
      try { urlToRelPath.set(new URL(url).pathname, localPath); } catch(e) {}
      fetchedCount++;
      log('✔ (fetch) ' + localPath + ' (' + (blob.size / 1024).toFixed(1) + ' KB)', 'ok');
    } catch(e) {
      log('✖ ' + url + ' — ' + e.message, 'err');
    }
  }

  log('');
  log('Всего ресурсов: ' + resources.length);
  status('Фикс путей...', 60);

  let fixedHtml = html;
  const sorted = [...urlToRelPath.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [origUrl, relPath] of sorted) {
    try {
      const esc = origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      fixedHtml = fixedHtml.replace(new RegExp(esc, 'g'), relPath);
    } catch(e) {}
  }

  status('Сборка архива...', 70);

  const zip = new JSZip();
  zip.file('package.json', JSON.stringify({
    name: domain.replace(/[^a-z0-9]/g, '-'),
    private: true,
    scripts: { dev: 'npx http-server -p 8080 --cors' }
  }, null, 2));
  zip.file('index.html', fixedHtml);

  let fileCount = 1;
  for (const r of resources) {
    try {
      if (r.isBase64 && r.data) {
        zip.file(r.localPath, r.data, { base64: true });
      } else if (r.data instanceof Blob) {
        zip.file(r.localPath, r.data);
      } else if (r.data) {
        zip.file(r.localPath, r.data);
      }
      fileCount++;
    } catch(e) {
      log('✖ ' + r.localPath + ' — ' + e.message, 'err');
    }
  }

  status('Генерация...', 85);
  const blob = await zip.generateAsync({ type: 'blob' });

  log('✔ Архив: ' + (blob.size / 1024 / 1024).toFixed(2) + ' MB, ' + fileCount + ' файлов');
  status('Скачиваю...', 90);

  const filename = domain + '.zip';
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
    progress.style.display = 'none';
    log('');
    log('✔ Готово! Распакуйте архив, откройте папку в терминале и запустите:', 'ok');
    log('   npm run dev', '');
    log('   Затем откройте http://localhost:8080/', '');
    btnCapture.disabled = false;
    btnCapture.textContent = 'Захватить ещё';
  });
});
