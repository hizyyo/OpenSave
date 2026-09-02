# Offline Archive Format

## Goals

An archive is portable, static, and inspectable. It should work from any static HTTP(S) host without the original application source, build tool, or backend runtime.

## Required Files

| File | Purpose |
| --- | --- |
| `index.html` | Captured entry document with local resource paths. |
| `404.html` | Static-host fallback for SPA paths. |
| `replay-matcher.js` | Shared exact matcher for method, normalized URL, content type, and request body hash. |
| `replay-misses.json` | Inspectable capture-time miss ledger; the service worker serves a live view with runtime misses. |
| `validation-plan.json` | Bounded root/route checkpoints and required archive files. |
| `validation-report.json` | Machine-readable `ready`, `partial`, `failed`, or `cancelled` result with typed diagnostics. |
| `archive-validator.js` | Shared validation planning, static checks, and classification core. |
| `archive-validator-companion.mjs` | Optional final localhost runner when extension APIs cannot validate the service-worker update fetch. |
| `validate-windows.bat` / `validate-unix.sh` | Launchers for the optional final validator. |
| `sitesaver-sw.js` | Offline service worker. |
| `sitesaver-offline.js` | Runtime bootstrap and API replay fallback. |
| `sitesaver-report.json` | Capture diagnostics and completeness score. |
| `sitesaver-manifest.json` | Archive metadata. |
| `README.txt` | Hosting instructions for the archive recipient. |
| `open-windows.bat` | Windows launcher. |
| `open-windows.ps1` | Windows fallback static server. |
| `open-unix.sh` | macOS/Linux launcher. |

## Resource Layout

```text
assets/<source-host>/<original-path>
api-snapshots/<request-hash>.<extension>
screenshots/canvas-<n>.png
```

Query strings are represented by a deterministic short hash in the filename. This prevents different versions of the same pathname from overwriting each other.

## Manifest

`sitesaver-manifest.json` contains:

```json
{
  "format": "sitesaver-offline-archive",
  "version": 3,
  "sourceUrl": "https://example.com/",
  "captureMode": "deep",
  "capturedAt": "2026-08-11T00:00:00.000Z",
  "resourceCount": 42,
  "apiSnapshotCount": 3,
  "replayMissCount": 0,
  "validationStatus": "partial",
  "validationDurationMs": 8421
}
```

## Report

`sitesaver-report.json` includes a completeness score calculated from discovered dependencies that were successfully saved. It also records unresolved resources, unavailable pages, crawler limits, HTTP/network diagnostics, and cache/child-target observations.

The `replay` section reports supported recorded-request coverage, locally fulfillable exchanges, ambiguity count, and capture-time miss reason counts. `replay-misses.json` contains evidence references for every known miss; when served through the generated service worker, the same path also includes runtime misses recorded since activation.

The `validation` section mirrors `validation-report.json`. It separates capture misses, rewrite failures, replay-runtime failures, and validator-infrastructure limitations. Validation failure never removes or suppresses the archive download.

## Post-Export Validation

The extension validates the completed in-memory ZIP before download. It mounts files through CDP request interception, blocks external requests before network access, executes the root and every saved route within a hard route/time budget, checks route-specific injected markers, and collects runtime exceptions, console errors, failed local requests, and replay diagnostics.

Chrome does not expose the service-worker update fetch to the extension debugger in this validation context. When that final check is unavailable, the automatic result is `partial` with `local-companion-required`; it is never labeled `ready`. Run `validate-windows.bat` or `validate-unix.sh` from the unpacked archive to use a temporary localhost server and isolated headless Chrome. The companion applies the same schema, verifies real service-worker control and zero egress, then updates `validation-report.json`, `sitesaver-report.json`, and `sitesaver-manifest.json` in place.

## Request Identity

Fetch/XHR replay uses an exact identity: uppercase method, normalized URL without a fragment, normalized media type, and SHA-256 of the exact request body bytes represented by the captured text. Repeated identical identities consume saved responses in recorded order. Runtime-origin requests may map by pathname and query only when that mapping has a single captured source origin; collisions are reported as `ambiguous` rather than guessed.

GET, HEAD, JSON POST, form POST, saved redirects, navigations, and saved static assets are supported. Unknown mutations, ranges, streaming uploads, beacons, WebSockets, and server-sent events fail closed with explicit reason codes.

## Hosting Requirements

Serve the archive from the origin root over HTTP(S). The generated service worker requires a secure context on production hosts; `localhost` is treated as secure by modern browsers. Do not rely on `file://`.

The archive is not a Node.js project. It intentionally does not include `package.json`; use the generated launcher scripts or any static HTTP server.

Deep archives map each captured same-origin page route to its saved HTML file. Unknown routes still fall back to root `index.html` for client-side SPAs.
