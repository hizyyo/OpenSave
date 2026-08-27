# Changelog

All notable changes to openSave are documented here.

## Unreleased

## [1.0.2] - 2026-08-27

### Fixed

- Deep capture now returns structured `Runtime.evaluate` results by value. Hover, scrolling, interactive-state, scenario, and start-overlay counters no longer fall back to zero.
- Canvas fallback arrays are now transferred from the inspected page, allowing generated canvas screenshots to reach the archive.

## [1.0.1] - 2026-08-27

### Added

- Generated archives now include `open-windows.bat`, `open-windows.ps1`, and `open-unix.sh` launchers so users can run the offline copy directly without creating a Node.js project.
- Archive README now explicitly says not to run `npm install` or `npm run dev` inside the capture output.

## [1.0.0] - 2026-08-17

### Changed

- Renamed the extension from **SiteSaver** to **openSave**.
- Rewrote the README with polished branding, badges, and capture-mode documentation.

## [3.2.1] - 2026-08-11

### Fixed

- Deep capture now waits for and activates safe visible startup overlays such as `START`, `BEGIN`, `ENTER`, and `LAUNCH` before generic UI exploration. This supports WebGL and 3D sites that load their scene only after a non-semantic clickable `div` is activated.
- Startup overlay activation explicitly excludes links, forms, and editable controls to avoid navigation or data-changing actions.

## [3.2.0] - 2026-08-11

### Added

- Quick and Deep capture modes.
- Safe UI-state exploration, hover discovery, and scroll-container discovery.
- Element picker and selected-block export.
- Recorded capture scenarios with sensitive-field exclusion.
- API snapshots, offline service worker, SPA fallback, completeness reports, and archive manifests.
- `glTF`, Three.js-adjacent asset, worker, source-map, and module dependency discovery.
- Golden archive and headless Chrome integration checks.
- Screenshot output and optional deterministic screenshot-baseline comparison for archive integration tests.
- Public repository documentation, architecture and archive-format references, contribution guidance, security policy, issue templates, and monochrome brand assets.
- GitHub Actions validation with an installed Chrome for Testing browser.

### Changed

- Offline archives are static and portable; they no longer include or require a Node.js `package.json`.
- URL rewriting is structured by document/resource type instead of broad string replacement.
- TanStack SSR hydration payloads are restored from captured document responses when available.
- Extension metadata now identifies the release as version `3.2.0` and includes standard Chrome icon sizes.

### Fixed

- Resource path collisions across source hosts and query strings.
- Root URL rewrite corruption.
- Unmatched offline API requests escaping to production.
- Unsafe traversal of external iframe documents and module-like strings in minified bundles.
- Headless Chrome startup on GitHub-hosted Linux runners.
