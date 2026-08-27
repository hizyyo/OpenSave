# openSave Test Harness

SiteSaver → **openSave** uses two complementary archive checks.

It also has a focused regression check for delayed, non-semantic start overlays used by WebGL and 3D experiences.

```powershell
node tests/start-overlay-regression.mjs
```

This check ensures Deep capture activates a visible startup control before generic UI exploration, waits for delayed loaders, and does not treat links or forms as safe startup controls.

`tests/deep-runtime-regression.mjs` ensures every Deep-stage `Runtime.evaluate` call that returns an object or array uses `returnByValue: true`. Without it, CDP returns only a remote object handle and the side panel receives misleading zero counters or empty canvas snapshots.

`tests/archive-safety-regression.mjs` guards SRI removal, same-origin offline CSP, lazy `data-src` rewriting, quoted CSS URLs, and duplicate/external script filtering.

## Golden Archive Check

The golden check validates archive structure without launching a browser.

```powershell
node tests/golden-capture.mjs C:\path\to\unpacked-archive
```

It verifies:

- Required offline runtime, manifest, report, and README files exist.
- The archive does not ship a Node.js `package.json`.
- Root URL rewriting was not corrupted.
- Remote executable scripts and stylesheets are absent from the entry document.
- The generated service worker has SPA fallback and external-network blocking.
- The capture report includes a completeness score.
- TanStack Router hydration payloads are preserved when the captured source document contains them.

## Browser Integration Check

The browser check starts a local static server and a real headless Chrome session.

```powershell
node tests/browser-integration.mjs C:\path\to\unpacked-archive
```

It verifies:

- The root route renders non-empty content.
- The generated service worker controls the archive.
- A SPA route renders after navigation.
- Runtime exceptions and console errors are absent.
- The archive makes no external HTTP(S) requests.
- A PNG screenshot is written to `tests/artifacts/`.

`tests/artifacts/` is ignored by Git.

## Screenshot Baselines

Set `SITESAVER_BASELINE_DIR` to compare the produced screenshot against a baseline PNG named after the archive directory.

```powershell
$env:SITESAVER_BASELINE_DIR = "C:\path\to\baselines"
node tests/browser-integration.mjs C:\path\to\unpacked-archive
```

The current comparison uses SHA-256 byte equality. Use it for deterministic fixtures rather than live production captures.

## Fixture

`tests/fixtures/offline-archive/` is a minimal valid openSave archive. It keeps CI independent from external sites and is used by `.github/workflows/validate.yml`.

## Adding a Regression Fixture

1. Add a small, authorized static archive fixture.
2. Add the bug invariant to `golden-capture.mjs` or `browser-integration.mjs`.
3. Run both checks locally.
4. Keep fixtures small, deterministic, and free of private data.
