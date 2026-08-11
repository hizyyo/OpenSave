# Architecture

## Overview

SiteSaver is a no-build Manifest V3 Chrome extension with three runtime layers:

```text
Side Panel -> Service Worker -> Chrome DevTools Protocol -> Active Tab
     |              |                    |
     |              |                    +-- Network / DOM / Runtime / Cache Storage
     |              +-- Capture state and archive metadata
     +-- Resource graph, URL rewriting, JSZip export
```

## Background Service Worker

`background.js` owns the single active capture operation.

- Attaches Chrome Debugger to the active tab.
- Enables Network capture and child target observation.
- Tracks request/response metadata and reads finished response bodies.
- Captures same-origin documents, supported static resource types, API snapshots, and Cache Storage entries when available.
- Runs safe Deep-mode exploration and reports diagnostics to the side panel.
- Provides scenario recording and the element-picker overlay through `Runtime.evaluate` and CDP bindings.

Only one operation is allowed at once to prevent response bodies from different tabs mixing in one archive.

## Side Panel

`sidepanel.js` receives the raw capture result and builds the archive.

- Computes collision-safe archive paths by hostname, pathname, query hash, and MIME type.
- Discovers CSS URLs, module references, source maps, `glTF` dependencies, and safe same-origin pages.
- Rewrites HTML, CSS, `glTF`, and recognized JavaScript URL literals to local archive paths.
- Restores supported SSR hydration payloads, including TanStack Router bootstrap scripts, from the original document response.
- Generates the offline service worker, API replay runtime, report, manifest, and ZIP.

## Offline Runtime

The exported `sitesaver-sw.js` caches all archive files, answers saved API snapshots, handles SPA navigation, and blocks external network access. `sitesaver-offline.js` registers it before application modules initialize.

## Safety Model

Deep exploration never follows links or submits forms. It only considers explicitly stateful controls such as tabs, menu items, summaries, disclosure elements, and controls with `aria-controls`, `data-state`, or `data-toggle`.

The crawler rejects obvious payment, deletion, logout, order, subscription, and external-service actions. This is a safety filter, not proof that arbitrary third-party UI is safe to automate.

## Testing

`tests/golden-capture.mjs` validates archive invariants. `tests/browser-integration.mjs` uses a real headless Chrome instance to validate service-worker activation, local-only networking, SPA navigation, console/runtime errors, and optional screenshot baselines.
