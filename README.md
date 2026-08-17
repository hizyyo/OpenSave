# openSave

<p align="center">
  <img src="logo.png" width="160" alt="openSave logo">
</p>

A Chrome extension that captures the page you're looking at and saves it as a complete offline copy. HTML, CSS, JS, fonts, images, 3D models, API responses — everything the browser actually received goes into one `.zip` you can open from any static server. No build step, no Node.js, no backend.

## Why this exists

"Save page as…" gives you a pile of HTML with broken references. wget mirrors folders but mangles SPA routing and misses API calls. openSave sits on the real network layer via the Chrome DevTools Protocol, so it records what the browser really loaded — then rewrites all the paths so the archive works offline.

The archive is a static folder. Serve it with any static host (or just `python3 -m http.server`) and the included service worker handles routing, saved API responses, and blocks any attempt to reach the live network.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

You need Chrome 125+.

## How to use it

Open the site you want to keep, click the openSave icon, pick a mode, and hit Download.

**Quick** — saves the current page and its direct dependencies. Good for articles and single pages.

**Deep** — reloads the page and walks the site:

- waits for delayed loaders and activates safe start overlays (the `START` / `BEGIN` screens some WebGL sites put in front of their content)
- scrolls the page and nested containers to trigger lazy-loaded assets
- hovers and clicks through safe UI states (tabs, accordions, menus) and rolls them back
- replays a recorded scenario if you recorded one
- exports `CacheStorage` entries and canvas fallbacks for 3D scenes
- snapshots `fetch`/`XHR` responses so API calls still work offline

There are also two smaller tools:

- **Record scenario** — walk through a flow yourself (open the config panel, switch a tab), then let Deep capture replay it during the crawl.
- **Element picker** — highlight one block on the page and export just that as a small archive.

## What's inside the archive

```
site.zip
├── index.html                  entry document
├── 404.html                    SPA fallback
├── assets/…                    CSS, JS, media, fonts, models
├── api-snapshots/…             saved fetch/XHR responses
├── sitesaver-offline.js        bootstrap + API replay
├── sitesaver-sw.js             offline service worker
├── sitesaver-report.json       completeness score + diagnostics
├── sitesaver-manifest.json     archive metadata
└── README.txt
```

`site-saver-report.json` has a completeness score and lists anything that couldn't be saved, so you know what's missing before you share the archive.

## What it can't do

- Rebuild content the browser never received (login-walled data, WebSocket streams).
- Guarantee a GPU 3D scene renders identically — canvas fallbacks cover the common case.
- Follow external links or touch pages outside the current session. It intentionally doesn't.

## Boundaries

Only use this on sites you own or are allowed to archive. A capture may include copyrighted material, personal data, or session tokens. Check `sitesaver-report.json` before distributing anything, and never publish captures with credentials or private data.

## Development

```bash
node --check background.js
node --check sidepanel.js
node tests/golden-capture.mjs tests/fixtures/offline-archive
node tests/browser-integration.mjs tests/fixtures/offline-archive   # needs Chrome
node tests/start-overlay-regression.mjs
```

CI runs these on every push and PR with a fresh Chrome for Testing.

## License

MIT. See [LICENSE](./LICENSE).