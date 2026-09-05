# Session 06: Rendered Multi-Page Crawler

Capture internal pages as rendered browser states instead of relying only on `fetch()` HTML.

## Objective

Build a small, opt-in `Save site` crawler that visits explicit same-origin links in an isolated target and saves each rendered page.

## Current Problem To Verify

The current fallback crawler can discover and fetch same-origin HTML, but fetched HTML is not equivalent to a rendered route. JavaScript navigation frameworks, authenticated page initialization, route-specific APIs, and client-rendered state may be missed.

## Required Work

1. Define route identity, cancellation, and hard page/time/byte budgets.
2. Build a route graph with discovery source and decision reason.
3. Visit explicit same-origin links through browser navigation in an isolated target.
4. Wait for bounded network-idle plus DOM-mutation idle; record timeout reasons.
5. Capture each page's network evidence and live DOM checkpoint.
6. Deduplicate redirects, aliases, and canonical URLs.
7. Keep `fetch()`-only discovery as a lower-fidelity fallback and label it.

## Safety Rules

- Same-origin navigation only by default.
- Never submit forms or perform account mutations.
- Respect hard page, time, byte, and state budgets.
- Only follow ordinary anchors and history routes. Do not discover routes by clicking controls.
- No hostname hardcodes or site recipes in this session.

## Acceptance Criteria

- Multi-page fixtures save and replay page-specific content and assets.
- SPA history states and document navigations are represented distinctly.
- Every skipped route has a reason.
- Infinite calendars/pagination stop at budget.
- Original active tab URL and state are restored or the isolated target is closed.
- React SPA, SSR, and static multi-page fixtures improve without lowering existing completeness.

## Stop/Go

Stop at the configured budget. Do not add speculative pagination, calendar expansion, or UI-state exploration.

## Verification

Add static multi-page, React SPA, SSR, redirect, infinite-link, cross-origin, and cancellation fixtures.
