# Golden Capture Checks

After capturing a controlled test site, unpack the archive and run:

```powershell
node tests/golden-capture.mjs C:\path\to\unpacked-archive
```

The check fails if an export has the root URL rewrite regression, remote HTML dependencies, a missing offline service worker, no SPA fallback, no strict external-network block, or no completeness metric.

## Browser Integration

This uses a real local Chrome instance, starts a static server for an unpacked archive, waits for the generated service worker, opens a SPA route, and fails on outside-network requests, browser exceptions, or console errors.

```powershell
node tests/browser-integration.mjs C:\path\to\unpacked-archive
```

It writes a screenshot to `tests/artifacts/`. To compare a capture to a known baseline, set `SITESAVER_BASELINE_DIR` to a directory containing a PNG named after the unpacked archive folder.
