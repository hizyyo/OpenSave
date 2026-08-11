# Changelog

All notable changes to SiteSaver are documented here.

## Unreleased

### Added

- Quick and Deep capture modes.
- Safe UI-state exploration, hover and scroll-container discovery.
- Element picker and selected-block export.
- Recorded capture scenarios with sensitive-field exclusion.
- API snapshots, offline service worker, SPA fallback, completeness reports, and archive manifests.
- `glTF`, Three.js-adjacent asset, worker, source-map, and module dependency discovery.
- Golden archive and headless Chrome integration checks.
- Public repository documentation, contribution guidance, security policy, issue templates, and monochrome brand assets.

### Changed

- Offline archives are static and portable; they no longer include or require a Node.js `package.json`.
- URL rewriting is structured by document/resource type instead of broad string replacement.
- TanStack SSR hydration payloads are restored from captured document responses when available.

### Fixed

- Resource path collisions across source hosts and query strings.
- Root URL rewrite corruption.
- Unmatched offline API requests escaping to production.
- Unsafe traversal of external iframe documents and module-like strings in minified bundles.
