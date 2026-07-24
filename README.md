<p align="center">
  <img src="icon.png" width="128" height="128" alt="SiteSaver logo">
</p>

<h1 align="center">SiteSaver</h1>

<p align="center">
  <strong>Полная офлайн-копия любого сайта в один клик</strong><br>
  <em>Download any website as a fully offline copy — one click</em>
</p>

<p align="center">
  Chrome Extension · Manifest V3 · <code>chrome.debugger</code> API
</p>

---

## 🇷🇺 Русский

### Описание

**SiteSaver** — это Chrome-расширение, которое скачивает любой сайт целиком: HTML, CSS, JavaScript, шрифты, изображения, анимации. Сайт сохраняется в виде zip-архива с готовым `package.json`, достаточно распаковать и запустить `npm run dev`.

### Как это работает

Расширение использует `chrome.debugger` API (режим разработчика), чтобы перехватывать все HTTP-ответы, включая динамические JS-чанки и ленивые ресурсы. Оно не просто скачивает HTML — оно собирает полный слепок страницы со всеми зависимостями.

**Процесс в один клик:**
1. Нажать «Захватить сайт» в боковой панели
2. Расширение перезагружает страницу через отладчик
3. Ожидает полной загрузки всех ресурсов
4. Прокручивает страницу для подгрузки ленивых изображений
5. Собирает HTML через DOM API (с тремя уровнями fallback)
6. Упаковывает всё в zip и скачивает

### Установка

1. Скачайте репозиторий или [релиз](https://github.com/hizyyo/sitesaver/releases)
2. Откройте `chrome://extensions`
3. Включите «Режим разработчика»
4. Нажмите «Загрузить распакованное» и выберите папку с расширением
5. Готово — иконка расширения появится в панели

### Использование

1. Откройте любой сайт в Chrome
2. Нажмите на иконку расширения (пазл → SiteSaver) — откроется боковая панель
3. Нажмите «Захватить сайт»
4. После завершения скачается zip-архив
5. Распакуйте архив, откройте папку в терминале:
   ```bash
   npm run dev
   ```
6. Откройте `http://localhost:8080`

### Технические детали

- **Manifest V3** — современная архитектура расширений Chrome
- **Side Panel** — панель справа, не закрывается при обновлении страницы
- **chrome.debugger API** — перехватывает все сетевые запросы на уровне протокола DevTools
- **Тройной fallback для HTML:**
  1. `DOM.getOuterHTML` — напрямую из DOM (самый надёжный)
  2. `Runtime.evaluate` — через `document.documentElement.outerHTML`
  3. Сетевое тело ответа — последний шанс
- **Фильтр MIME-типов** — отсекает API-ответы и ненужный мусор
- **Автоматическая замена URL** — все ссылки в HTML заменяются на локальные пути
- **Scrolling** — прокрутка страницы для подгрузки lazy-ресурсов
- **JSZip** — сборка архива на стороне клиента

### Возможности

- ✔ Один клик — полная копия сайта
- ✔ Работает с SPA, статикой, WordPress, любыми сайтами
- ✔ Не требует API-ключей или сторонних сервисов
- ✔ Локальный сервер через `npm run dev`
- ✔ Автоматическая обработка путей
- ✔ Поддержка ленивых изображений
- ✔ Поддержка шрифтов и иконок
- ✔ Поддержка видео и аудио
- ✔ Фильтрация мусора (API-запросы, аналитика)

### Лицензия

MIT

---

## 🇬🇧 English

### Description

**SiteSaver** is a Chrome extension that downloads any website in its entirety: HTML, CSS, JavaScript, fonts, images, animations. The site is saved as a zip archive with a ready-to-use `package.json` — just extract and run `npm run dev`.

### How It Works

The extension uses the `chrome.debugger` API (developer mode) to intercept all HTTP responses, including dynamic JS chunks and lazy resources. It doesn't just download the HTML — it captures a complete snapshot of the page with all dependencies.

**One-click process:**
1. Click "Capture Site" in the side panel
2. The extension reloads the page via the debugger
3. Waits for all resources to fully load
4. Scrolls the page to trigger lazy images
5. Captures HTML via the DOM API (with three fallback levels)
6. Packages everything into a zip and downloads it

### Installation

1. Clone the repo or download a [release](https://github.com/hizyyo/sitesaver/releases)
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extension folder
5. Done — the extension icon will appear in the toolbar

### Usage

1. Open any website in Chrome
2. Click the extension icon (puzzle → SiteSaver) — the side panel opens
3. Click "Capture Site"
4. When complete, a zip archive downloads
5. Extract the archive, open the folder in a terminal:
   ```bash
   npm run dev
   ```
6. Open `http://localhost:8080`

### Technical Details

- **Manifest V3** — modern Chrome extension architecture
- **Side Panel** — stays open across page navigations
- **chrome.debugger API** — intercepts all network requests at the DevTools protocol level
- **Triple fallback for HTML:**
  1. `DOM.getOuterHTML` — directly from the DOM (most reliable)
  2. `Runtime.evaluate` — via `document.documentElement.outerHTML`
  3. Network response body — last resort
- **MIME type filter** — filters out API responses and garbage
- **Automatic URL rewriting** — all URLs in HTML are replaced with local paths
- **Scrolling** — auto-scrolls to trigger lazy-loaded resources
- **JSZip** — client-side archive generation

### Features

- ✔ One click — full site copy
- ✔ Works with SPAs, static sites, WordPress, any website
- ✔ No API keys or third-party services required
- ✔ Local server via `npm run dev`
- ✔ Automatic path rewriting
- ✔ Lazy image support
- ✔ Font and icon support
- ✔ Video and audio support
- ✔ Garbage filtering (API requests, analytics)

### License

MIT

---

<p align="center">Built with ❤️ by <a href="https://github.com/hizyyo">hizyyo</a></p>
