# Rendered Page Crawler

Deep `Save site` capture visits explicit same-origin anchors in an inactive temporary tab. The source tab is never reloaded or navigated, and the temporary tab is closed in `finally` on success, failure, or cancellation.

## Route Identity

- Document routes use the URL without a fragment.
- History routes preserve the full URL, including the fragment.
- Redirect and canonical URLs are aliases of the selected rendered checkpoint.
- Every discovered route has a terminal state and a decision reason.

## Budgets

The planner enforces hard limits for accepted pages, discovered candidates, elapsed crawl time, per-route time, captured bytes, and history states. Reaching a limit marks queued or newly discovered routes with `page-budget`, `candidate-budget`, `time-budget`, `byte-budget`, or `state-budget`.

## Stabilization

Each visit waits for both a bounded network-idle window and a bounded DOM-mutation-idle window. A checkpoint is still retained on `network-idle-timeout` or `dom-idle-timeout`, with the timeout recorded on the route.

## Safety

- Same-origin HTTP(S) anchors only.
- No form submission or control discovery.
- Download links and non-self targets are skipped.
- Cancellation is checked between routes and during idle waits.

## Fidelity

Rendered routes produce `rendered-page` or `rendered-history-state` live DOM documents. If rendered navigation fails, the existing `fetch()` path may capture that route as `unrendered-refetch`, with `rendered-navigation-failed-fetch-fallback` recorded as the reason.
