# openSave

<p align="center">
  <img src="logo.png" width="160" alt="openSave logo">
</p>

OpenSave preserves modern interactive websites, including SPAs, WebGL experiences, and campaign microsites, as portable offline archives with API replay and capture diagnostics.

It is a Chrome extension for preserving modern interactive webpages and bounded same-origin sites. OpenSave captures supported browser-visible resources, rewrites them for offline use, and packages the result as a structured `.zip`. Archives can be viewed through the included local launchers without a build step, Node.js project, or backend.

## Why this exists

Modern web projects often depend on client-side routing, runtime-loaded assets, API responses, canvas state, and delayed interactions. Conventional file downloads do not preserve all of these dependencies.

OpenSave observes supported resources through the Chrome DevTools Protocol, records their provenance in a capture graph, and rewrites captured paths for best-effort offline replay. The included service worker handles supported routes and API snapshots while blocking unexpected live-network requests during replay.

Captured archives are not Node.js projects. Do not run `npm install` or `npm run dev` inside them. New archives include `open-windows.bat`, `open-windows.ps1`, and `open-unix.sh` launchers for local viewing.

## Who it is for

- Digital agencies preserving completed campaign sites.
- Creators archiving interactive portfolios.
- QA and development teams reproducing frontend states.
- Researchers and preservation teams archiving authorized public web material.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

You need Chrome 125+.

## How to use it

Open the authorized webpage or project you want to preserve, click the openSave icon, choose a mode, and select Download.

**Quick** saves the current page and its supported direct dependencies. It is intended for individual pages and focused captures.

**Deep** reloads the page and performs a bounded capture:

- waits for delayed loaders and activates a limited set of start overlays, such as the `START` or `BEGIN` screens used by some WebGL projects
- scrolls the page and nested containers to trigger lazy-loaded assets
- explores explicitly permitted same-origin routes within fixed page, time, and byte budgets
- interacts with a limited set of reversible UI elements, such as tabs, accordions, and menus
- replays a recorded scenario if you recorded one
- exports supported `CacheStorage` entries and canvas fallbacks for WebGL or other canvas-based experiences
- snapshots supported `fetch`/`XHR` responses for best-effort offline API replay

There are also two smaller tools:

- **Record scenario**: walk through a flow yourself, such as opening a configuration panel or switching a tab, then let Deep capture replay it during the bounded capture.
- **Element picker**: highlight one block on the page and export it as a smaller archive.

## How it differs from Save Page As and wget

- Observes supported resources through the Chrome DevTools Protocol instead of relying only on the final document source.
- Supports SPA routing and selected same-origin routes within bounded capture limits.
- Records supported `fetch`/`XHR` responses as API snapshots for offline replay.
- Produces validation diagnostics and a completeness report instead of silently omitting unsupported resources.
- Blocks unexpected live-network requests during service-worker replay.

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
├── open-windows.bat            Windows launcher
├── open-windows.ps1            Windows fallback server
├── open-unix.sh                macOS/Linux launcher
└── README.txt
```

`sitesaver-report.json` contains a completeness score, validation results, and diagnostics for resources or behavior that could not be preserved. Review it before relying on or distributing an archive.

## Engineering highlights

- Chrome DevTools Protocol capture for supported browser-visible responses and child targets.
- A provenance-aware capture graph that distinguishes observed, derived, and refetched artifacts.
- Durable capture storage with interruption recovery and cleanup of temporary bodies.
- Typed HTML, CSS, SVG, and JavaScript resource discovery and path rewriting.
- Service-worker routing and exact-match replay for supported API snapshots.
- Bounded rendered-route exploration with time, page, byte, and interaction limits.
- Post-export validation, completeness reporting, and explicit diagnostics for unsupported behavior.
- Live DOM serialization with open shadow-root support and best-effort WebGL, canvas, and blob URL fallbacks.

## Privacy guardrails

OpenSave applies privacy guardrails to known sensitive headers, URL parameters, request metadata, and sensitive form fields. It can redact recognized values or exclude artifacts when automated sanitization would be unsafe.

These checks are defensive filters, not a guarantee that every secret or personal value will be detected. API response bodies and captured resources may contain personal, confidential, or account-specific data that automated rules do not recognize.

Treat every archive as private and not safe to share until its contents and `sitesaver-report.json` have been reviewed manually.

## What it can't do

- Reconstruct content or server behavior that was not available during capture.
- Bypass authentication, paywalls, access controls, or other restrictions.
- Guarantee that every framework, API call, WebSocket stream, service worker, or browser feature can be replayed offline.
- Guarantee pixel-identical WebGL or GPU output; canvas and media fallbacks are best-effort.
- Follow cross-origin links or perform an unbounded crawl.
- Produce a perfect copy of every website. Unsupported behavior remains visible in diagnostics and completeness reporting.

## Responsible use

- Use OpenSave only on websites you own or have permission to preserve.
- Do not use it to bypass authentication, paywalls, or access controls.
- You are responsible for having the right to preserve and distribute captured content.
- Review archive contents, privacy findings, and validation diagnostics before publication or sharing.

## Development

```bash
node --check background.js
node --check sidepanel.js
node tests/golden-capture.mjs tests/fixtures/offline-archive
node tests/browser-integration.mjs tests/fixtures/offline-archive   # needs Chrome
node tests/benchmark-corpus.mjs --repeat=2                        # needs Chrome
node tests/start-overlay-regression.mjs
```

CI runs these on every push and PR with a fresh Chrome for Testing.

## Roadmap

The deliberately small MVP plan lives in [`sessions/`](./sessions/README.md). Developer extraction, WARC/WACZ, reconstruction, browser-state restoration, single-HTML, incremental updates, diffs, and repair automation are explicitly out of scope. The product plan is in [`docs/PRODUCT_ROADMAP.md`](./docs/PRODUCT_ROADMAP.md).

## License

MIT. See [LICENSE](./LICENSE).
