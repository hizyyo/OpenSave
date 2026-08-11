<p align="center">
  <img src="icon.png" width="112" alt="SiteSaver black and white document icon">
</p>

<h1 align="center">SiteSaver</h1>

<p align="center">
  <strong>Capture a web experience. Export a reproducible offline archive.</strong><br>
  Chrome extension for research-grade HTML, asset, API, and interaction capture.
</p>

<p align="center">
  <a href="https://github.com/hizyyo/sitesaver/blob/main/LICENSE">MIT License</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#capture-modes">Capture Modes</a> ·
  <a href="#russian">Русский</a>
</p>

---

## What SiteSaver Does

SiteSaver is a Manifest V3 Chrome extension that captures the active page through the Chrome DevTools Protocol and exports a static offline archive.

The archive can include:

- Final page HTML and structured local URL rewrites.
- CSS, JavaScript, images, video, audio, fonts, WebAssembly, and 3D resources.
- Dynamic imports, module dependencies, worker dependencies, source maps, `glTF` buffers, and model textures when they are discoverable.
- Captured `fetch` and XHR response snapshots for offline replay.
- Same-origin internal pages in Deep mode.
- A generated offline service worker, SPA fallback, capture report, and portable archive manifest.

SiteSaver is designed for websites and content you own or are authorized to archive.

## Capture Modes

### Quick

Fast capture for the current page.

- Reloads and records the page's direct network responses.
- Collects direct HTML, CSS, JS, media, font, and module dependencies.
- Does not crawl internal pages, explore UI states, hover elements, inspect Cache Storage, or capture canvas fallbacks.

Use it when you need a fast static snapshot.

### Deep

Exhaustive capture for reproducibility research.

- Scrolls the document and internal scroll containers.
- Explores safe UI states such as tabs, menus, accordions, and disclosure controls.
- Performs hover exploration and state rollback.
- Captures API snapshots, same-origin iframe/worker traffic, Cache Storage where Chrome exposes it, canvas fallback images, and internal pages.
- Produces a completeness score and diagnostics in `sitesaver-report.json`.

Deep mode intentionally refuses forms, external links, payments, deletion, logout, subscription, and similarly unsafe interactions.

### Element Picker

Choose a single block instead of an entire page.

1. Click **Choose a block on page**.
2. Hover any visible element to preview the black-and-white outline.
3. Click to export the selected DOM subtree, its layout context, styles, and discovered assets.
4. Press `Esc` to cancel.

### Recorded Scenario

Use **Record scenario** to manually expose a modal, 3D configuration, tab, or other application state before deep capture. SiteSaver records safe semantic actions, excludes sensitive text fields, and replays the scenario after reload.

## Quick Start

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Open the target site, click SiteSaver, select **Quick** or **Deep**, then start capture.
6. Extract the downloaded ZIP.
7. Serve the extracted folder from the root of any static HTTP(S) host.

Do not open the archive with `file://`. Browsers require HTTP(S) for ES modules and service workers.

## Archive Format

Every full capture produces a portable static archive:

```text
index.html                 Captured entry document
404.html                   SPA fallback helper
assets/                    Captured resources grouped by source host
api-snapshots/             Captured Fetch/XHR response bodies
screenshots/               Canvas/WebGL fallbacks when available
sitesaver-sw.js            Offline service worker
sitesaver-offline.js       Offline runtime bootstrap
sitesaver-manifest.json    Source URL, mode, timestamps, resource counts
sitesaver-report.json      Completeness score and diagnostics
README.txt                 Static-hosting instructions for the archive
```

The archive does not require Node.js, a bundler, or the original source code. Any static HTTP(S) host can serve it.

## Offline Behavior

The generated runtime:

- Serves saved HTML, CSS, JS, media, and font files from Cache Storage.
- Replays matching API snapshots.
- Falls back to `index.html` for SPA navigation.
- Blocks outside-network requests instead of silently reaching production.
- Reports incomplete captures through `sitesaver-report.json`.

## Completeness Report

`sitesaver-report.json` is the source of truth for capture quality. It records:

- Discovered versus saved resource count and completeness score.
- Missing files and unavailable internal pages.
- Network/HTTP diagnostics.
- Child target, worker, iframe, and Cache Storage observations.
- Crawler limits when a Deep capture reaches its exploration budget.

An incomplete report does not mean the archive is unusable. It identifies exactly which browser-visible resources were unavailable or intentionally excluded.

## Known Boundaries

SiteSaver can preserve what the browser receives. It cannot reconstruct:

- Server-side source code, databases, secrets, payment systems, or private backend logic.
- Authentication state that was not available to the capture session.
- Live WebSocket sessions or future server-generated data.
- Resources that require an interaction or state that was never reached during capture.
- Closed Shadow DOM contents or browser responses Chrome does not expose.

## Development

There is no build step. Chrome loads the extension files directly.

```powershell
node --check background.js
node --check sidepanel.js
node tests/golden-capture.mjs tests/fixtures/offline-archive
node tests/browser-integration.mjs tests/fixtures/offline-archive
```

The browser integration test starts local Chrome, loads a fixture archive, verifies service-worker control and SPA navigation, checks for runtime/console errors, blocks external network requests, and saves a screenshot artifact.

See:

- [Contributing guide](CONTRIBUTING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Offline archive format](docs/OFFLINE_ARCHIVE_FORMAT.md)
- [Test harness](tests/README.md)
- [Security policy](SECURITY.md)
- [Repository metadata](REPOSITORY_METADATA.md)

## Security and Ethics

Use SiteSaver only for sites and content you own or have explicit permission to archive. A full capture may contain copyrighted material, personal data, tokens available to the active session, or third-party assets.

Review `sitesaver-report.json` before sharing an archive. Never publish captures containing credentials, private data, or materials you are not authorized to redistribute.

## License

[MIT](LICENSE)

---

<a id="russian"></a>

## Русский

SiteSaver создаёт воспроизводимый статический офлайн-архив активного сайта через Chrome DevTools Protocol.

### Что сохраняется

- Финальный HTML, CSS, JS, изображения, видео, шрифты, WebAssembly и 3D-ресурсы.
- Динамические импорты, worker-зависимости, `glTF` buffers/текстуры и API-снимки.
- В Deep режиме: внутренние страницы текущего домена, безопасные UI-состояния, Cache Storage, iframe/worker наблюдения и canvas fallback.
- `sitesaver-sw.js`, SPA fallback, `sitesaver-report.json` и `sitesaver-manifest.json`.

### Режимы

- **Быстро**: текущая страница и прямые зависимости без долгого обхода.
- **Глубоко**: scroll, hover, безопасные tabs/menu/accordion, API, cache, crawler и отчёт полноты.
- **Выбор блока**: экспорт одного выделенного DOM-блока с контекстом и зависимостями.
- **Сценарий**: вручную открыть нужное состояние, затем повторить его перед Deep захватом.

### Как открыть архив

Распакуйте ZIP и разместите папку в корне любого статического HTTP(S) сервера или хостинга. Node.js не нужен архиву. `file://` не поддерживается, потому что service worker и ES modules требуют HTTP(S).

### Ограничения

Расширение сохраняет только то, что увидел браузер. Оно не восстанавливает backend, платежи, базы данных, секреты, закрытые серверные вычисления и неиспользованные пользователем состояния приложения.

Перед распространением архива проверьте `sitesaver-report.json` и убедитесь, что у вас есть право сохранять и публиковать контент.

---

<p align="center">Built for reproducible web research by <a href="https://github.com/hizyyo">hizyyo</a>.</p>
