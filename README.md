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

SiteSaver is a Chrome extension that downloads entire websites — HTML, CSS, JavaScript, fonts, images. Everything. It zips it all up with a `package.json` so you just extract and run `npm run dev`.

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
- `package.json` — just run `npm run dev`

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
6. Open the folder in terminal:
   ```bash
   npm run dev
   ```
7. Open `http://localhost:8080`.

### Tech stuff

- **Manifest V3** — modern Chrome extension architecture.
- **chrome.debugger API** — hooks into DevTools protocol to intercept all network traffic.
- **Triple HTML fallback**: DOM API → Runtime.evaluate → raw network response. Never fails.
- **MIME filter** — blocks API responses and analytics junk.
- **URL rewriting** — replaces every URL in HTML with the local file path.
- **JSZip** — builds the archive in-browser.

### License

MIT

---

## Русский

SiteSaver — это расширение для Chrome, которое скачивает сайты целиком: HTML, CSS, JavaScript, шрифты, картинки. Всё, что есть на странице. Упаковывает в zip с `package.json` — распаковал, запустил `npm run dev`, готово.

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
- `package.json` — запустил `npm run dev` и всё работает

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
6. Откройте папку в терминале:
   ```bash
   npm run dev
   ```
7. Откройте `http://localhost:8080`.

### Техническое

- **Manifest V3** — современная архитектура расширений Chrome.
- **chrome.debugger API** — перехватывает весь сетевой трафик на уровне протокола DevTools.
- **Тройной fallback**: DOM API → Runtime.evaluate → сырой ответ сервера. Никаких пустых страниц.
- **MIME-фильтр** — отсекает API-запросы и мусор аналитики.
- **Замена URL** — каждый адрес в HTML заменяется на локальный путь к файлу.
- **JSZip** — сборка архива прямо в браузере.

### Лицензия

MIT

---

<p align="center">Built by <a href="https://github.com/hizyyo">hizyyo</a></p>
