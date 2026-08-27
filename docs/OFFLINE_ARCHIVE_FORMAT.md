# Offline Archive Format

## Goals

An archive is portable, static, and inspectable. It should work from any static HTTP(S) host without the original application source, build tool, or backend runtime.

## Required Files

| File | Purpose |
| --- | --- |
| `index.html` | Captured entry document with local resource paths. |
| `404.html` | Static-host fallback for SPA paths. |
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
  "version": 1,
  "sourceUrl": "https://example.com/",
  "captureMode": "deep",
  "capturedAt": "2026-08-11T00:00:00.000Z",
  "resourceCount": 42,
  "apiSnapshotCount": 3
}
```

## Report

`sitesaver-report.json` includes a completeness score calculated from discovered dependencies that were successfully saved. It also records unresolved resources, unavailable pages, crawler limits, HTTP/network diagnostics, and cache/child-target observations.

## Hosting Requirements

Serve the archive from the origin root over HTTP(S). The generated service worker requires a secure context on production hosts; `localhost` is treated as secure by modern browsers. Do not rely on `file://`.

The archive is not a Node.js project. It intentionally does not include `package.json`; use the generated launcher scripts or any static HTTP server.

Deep archives map each captured same-origin page route to its saved HTML file. Unknown routes still fall back to root `index.html` for client-side SPAs.
