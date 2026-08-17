<div align="center">

![openSave](icon.png)

# ⬇️ openSave

### The offline-first website archiver that never misses a file.

**openSave** is a Manifest V3 Chrome extension that turns any live site into a self-contained,
reproducible offline archive — HTML, CSS, JS, fonts, images, 3D models, API responses, and cache,
all wrapped into a single portable `.zip` that runs anywhere with zero dependencies.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0e1016?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=%2322c55e&color=%230e1016)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge&labelColor=%230e1016&color=%2322c55e)](#)
[![Chrome 125+](https://img.shields.io/badge/Chrome-125%2B-blue?style=for-the-badge&labelColor=%230e1016&color=%2322c55e)](#)
[![No Build Step](https://img.shields.io/badge/No%20Build%20Step-✓-blue?style=for-the-badge&labelColor=%230e1016&color=%2322c55e)](#)
[![No Node.js](https://img.shields.io/badge/No%20Node.js-✓-blue?style=for-the-badge&labelColor=%230e1016&color=%2322c55e)](#)

> **Load → Click → Archive.** The archive is 100% local, static, and portable.

</div>

---

## 🧭 What is openSave?

openSave drives your tab through the **Chrome DevTools Protocol** and records everything the
browser actually received: every document, script, stylesheet, image, font, WebSocket-era fetch,
XHR call, `CacheStorage` entry, and even the three.js/WebGL scenes behind a loading overlay.

The result is a **static offline copy** that works from any HTTP(S) host — no build step, no
server, no `node_modules`, no runtime framework. Just open it and it works.

```
   ┌─────────────────────────────────────────────────────────────┐
   │  openSave — deep capture                                     │
   │  HTML: 8.4 KB (DOM.getOuterHTML)                             │
   │  Captured responses: 24                                      │
   │  Start overlay activated after 1200 ms                       │
   │  Interactive: 12 clicked, 3 skipped · Hover: 40              │
   │  + assets/henryheffernan.com/bundle.cf64….js                 │
   │  + assets/henryheffernan.com/c28874fa5b347023.mp4            │
   │  API snapshots: 14 · Archive: 16.76 MB, 27 files             │
   │  Completeness: 85.7% (6/7 dependencies)                      │
   └─────────────────────────────────────────────────────────────┘
```

---

## ✨ Why openSave?

|                                | openSave | “Save page as…” | wget `--mirror` |
|--------------------------------|----------|-----------------|-----------------|
| Offline archive, one click     | ✅       | ✅ (HTML only)  | ⚠️ partial      |
| Scripts, CSS, fonts, images    | ✅       | ⚠️             | ✅              |
| Runs 3D / WebGL scenes         | ✅       | ❌              | ❌              |
| API snapshots (fetch/XHR)      | ✅       | ❌              | ❌              |
| Service worker + SPA fallback  | ✅       | ❌              | ❌              |
| Reproducible report & score    | ✅       | ❌              | ❌              |
| Portability (no build step)    | ✅       | ✅              | ❌              |

---

## 🚀 Quick start

1. **Install** — open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder (or load a packaged build).
2. Open any site you're allowed to archive.
3. Click the **openSave** icon → pick **Quick** or **Deep** → hit **Download**.

That's it. You get a `.zip` like:

```
site.zip
├── index.html                  # captured entry document
├── 404.html                    # SPA fallback
├── assets/                     # CSS, JS, media, fonts, images, glTF
│   └── example.com/…
├── api-snapshots/              # captured Fetch/XHR responses
├── sitesaver-offline.js        # runtime bootstrap + API replay
├── sitesaver-sw.js             # offline service worker
├── sitesaver-report.json       # completeness score + diagnostics
├── sitesaver-manifest.json     # archive metadata
└── README.txt                  # human-readable archive guide
```

### Serve it anywhere

```bash
npx serve site        # or: python3 -m http.server   # or: caddy file-server
```

Open `http://localhost:3000` → the service worker registers, SPA routes resolve, and blocked
external calls stay offline.

---

## 🎯 Capture modes

### ⚡ Quick
Current page + direct dependencies. Perfect for “just save this article before it disappears.”

### 🌀 Deep
Full-site exploration. openSave will:

- **Reload and wait** for the real content (delayed loaders, virtualized lists).
- **Activate safe start overlays** — `START` / `BEGIN` / `ENTER` / `LAUNCH` — that gate WebGL and
  3D experiences before capture begins.
- **Scroll** the page and nested scroll containers to trigger lazy assets.
- **Hover** interactive elements to reveal dropdowns, tooltips, and hover-state resources.
- **Click** safe UI elements (tabs, accordions, `aria-expanded`, menus) and roll back state.
- **Replay recorded scenarios** — record a manual flow (open the 3D config, switch tabs), then
  let deep capture replay it after reload.
- **Capture cache storage**, canvas fallbacks, and full **Fetch/XHR snapshot** replay.

### 🎨 Element picker
Highlight any block on the page and export just that selection as a focused, self-contained
archive — perfect for single components or sections.

### 🎬 Scenario recorder
Record a short safe interaction flow (no typing in password/number fields), then replay it during
deep capture so the archive reflects the fully-opened state.

---

## 🧩 What gets captured

- HTML/CSS/JS, images, fonts, video, audio, and all same-origin resources
- **glTF / GLB** models, `.hdr`, `.ktx2`, `.basis`, `.drc`, `.meshopt`, worker scripts, source maps
- **API snapshots** — `fetch` and `XHR` responses, replayed offline by both the service worker and
  the bootstrap script
- **Cache Storage** entries observed during capture
- **Canvas fallbacks** — PNG snapshots of WebGL/`<canvas>` scenes
- **TanStack SSR hydration payloads** restored so client-side routers boot correctly

## 🚧 What openSave can't do

- Reconstruct content the browser never received (server-rendered-only, login-walled, or
  WebSocket-only data).
- Guarantee pixel-perfect rendering of GPU scenes without a canvas fallback.
- Archive across pages you can't navigate to from the active session.

---

## 🧭 Boundaries & ethics

openSave is built for sites and content **you own or are explicitly authorized to archive**.
A full capture may contain copyrighted material, personal data, or session tokens.

- Review `sitesaver-report.json` before sharing an archive.
- Never publish captures containing credentials, private data, or content you may not redistribute.
- openSave never follows external links, never runs destructive actions, and blocks all external
  network access in the generated offline archive.

---

## 🛠️ Development

```bash
# Static checks (no dependencies required)
node --check background.js
node --check sidepanel.js

# Archive validation
node tests/golden-capture.mjs tests/fixtures/offline-archive

# Headless Chrome integration (needs Chrome installed)
node tests/browser-integration.mjs tests/fixtures/offline-archive

# Start-overlay regression guard
node tests/start-overlay-regression.mjs
```

CI (`.github/workflows/validate.yml`) runs all checks on every push and PR with a real
Chrome for Testing.

---

## 📄 License

Released under the [MIT License](./LICENSE).

---

<div align="center">

**openSave** — save the web, offline.

</div>
