<p align="center">
  <img src="icon.png" width="128" alt="SiteSaver">
</p>

<h1 align="center">SiteSaver</h1>

<p align="center">
  <b>Download any website as a full offline copy. One click.</b><br>
  <i>Скачать любой сайт целиком в офлайн. Один клик.</i>
</p>

<p align="center">Chrome Extension · Manifest V3 · <code>chrome.debugger</code> API</p>

---

## English

SiteSaver is a Chrome extension that downloads website snapshots — HTML, CSS, JavaScript, fonts, images, API responses, and media — into a static offline archive.

### Why this exists

Other "save page" tools miss half the resources. Dynamic JS chunks, lazy-loaded images, CDN fonts — they only get what's in the initial HTML. SiteSaver uses `chrome.debugger` to intercept every HTTP request at the browser protocol level. Nothing gets missed.

### How it works

1. You open a site and click "Capture" in the side panel.
2. SiteSaver reloads the page through Chrome's debugger, intercepting every response.
3. It waits for everything to finish loading, then scrolls the page to trigger lazy resources.
4. It grabs the final DOM (with three fallback methods so nothing breaks).
5. All URLs in the HTML are rewritten to local paths.
6. Everything gets packed into a zip and downloaded.

The zip includes:
- `index.html` with all paths rewritten
- All CSS, JS, fonts, images, videos
- `sitesaver-manifest.json` and `sitesaver-report.json`
- `README.txt` with static-hosting requirements

### Install

1. Clone this repo or grab a [release](https://github.com/hizyyo/sitesaver/releases).
2. Go to `chrome://extensions`, enable Developer mode.
3. Click "Load unpacked" and pick the folder.
4. Done.

### Using it

1. Open any site in Chrome.
2. Click the SiteSaver icon in the toolbar (or puzzle icon → SiteSaver).
3. The side panel opens on the right.
4. Click "Захватить сайт".
5. A zip downloads. Extract it.
6. Upload the extracted folder to any static HTTP(S) host at its root, or open it through any local static server.

### Tech stuff

- **Manifest V3** — modern Chrome extension architecture.
- **chrome.debugger API** — hooks into DevTools protocol to intercept all network traffic.
- **Triple HTML fallback**: DOM API → Runtime.evaluate → raw network response. Never fails.
- **MIME filter** — blocks API responses and analytics junk.
- **URL rewriting** — replaces every URL in HTML with the local file path.
- **JSZip** — builds the archive in-browser.

### Research capture mode

SiteSaver also exports an offline service worker, API snapshots, a completeness score, `sitesaver-report.json`, cache/worker diagnostics, and a static regression check in `tests/golden-capture.mjs`. For high-value captures, use a manual scenario before capture and run the golden check against the unpacked archive.

Deep captures stream resource data through Chrome DevTools Protocol when Chrome supports it, preserve safe UI-state exploration with rollback, and can be checked in a real headless Chrome session with `tests/browser-integration.mjs`.

### License

MIT

---

## Русский

SiteSaver — это расширение для Chrome, которое создаёт статический офлайн-архив сайта: HTML, CSS, JavaScript, шрифты, картинки, API-ответы и медиа.

### Зачем это нужно

Обычные «сохранить страницу» пропускают половину ресурсов. Динамические JS-чанки, ленивые картинки, шрифты с CDN — они берут только то, что в изначальном HTML. SiteSaver использует `chrome.debugger` и перехватывает каждый HTTP-запрос на уровне протокола браузера. Ничего не теряется.

### Как работает

1. Открываете сайт, нажимаете «Захватить сайт» в боковой панели.
2. Расширение перезагружает страницу через отладчик и перехватывает все ответы.
3. Ждёт полной загрузки, потом прокручивает страницу, чтобы подгрузились ленивые ресурсы.
4. Забирает финальный DOM (три уровня fallback — если один не сработает, сработает другой).
5. Заменяет все URL в HTML на локальные пути.
6. Упаковывает всё в zip и скачивает.

В архиве:
- `index.html` с переписанными путями
- Все CSS, JS, шрифты, картинки, видео
- `sitesaver-manifest.json`, `sitesaver-report.json` и `README.txt`

### Установка

1. Склонируйте репозиторий или скачайте [релиз](https://github.com/hizyyo/sitesaver/releases).
2. Откройте `chrome://extensions`, включите «Режим разработчика».
3. Нажмите «Загрузить распакованное» и выберите папку с расширением.
4. Готово.

### Как пользоваться

1. Откройте любой сайт в Chrome.
2. Нажмите на иконку SiteSaver (или пазл → SiteSaver).
3. Справа откроется панель.
4. Нажмите «Захватить сайт».
5. Скачается zip. Распакуйте.
6. Разместите распакованную папку в корне любого статического HTTP(S) сервера или хостинга.

### Техническое

- **Manifest V3** — современная архитектура расширений Chrome.
- **chrome.debugger API** — перехватывает весь сетевой трафик на уровне протокола DevTools.
- **Тройной fallback**: DOM API → Runtime.evaluate → сырой ответ сервера. Никаких пустых страниц.
- **MIME-фильтр** — отсекает API-запросы и мусор аналитики.
- **Замена URL** — каждый адрес в HTML заменяется на локальный путь к файлу.
- **JSZip** — сборка архива прямо в браузере.

### Research capture mode

SiteSaver также экспортирует offline service worker, API-снимки, метрику полноты, `sitesaver-report.json`, диагностику cache/worker и статическую проверку `tests/golden-capture.mjs`. Для важных захватов запишите ручной сценарий, затем проверьте распакованный архив golden-тестом.

Глубокий захват читает ресурсы через Chrome DevTools Protocol в потоковом режиме, когда Chrome это поддерживает, обходит безопасные UI-состояния с откатом и проверяется реальным headless Chrome через `tests/browser-integration.mjs`.

### Лицензия

MIT

---

<p align="center">Built by <a href="https://github.com/hizyyo">hizyyo</a></p>
