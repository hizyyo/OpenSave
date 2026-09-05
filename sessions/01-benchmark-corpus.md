# Session 01: Benchmark Corpus And Fidelity Baseline

Implement a repeatable benchmark before adding more capture heuristics.

## Objective

Create controlled fixtures and metrics that reveal whether a change improves archive fidelity or merely fixes one site.

## Required Fixtures

Add small, deterministic, locally served fixtures for at least these classes:

1. Static HTML with CSS imports, fonts, SVG references, `srcset`, and paths containing spaces.
2. SPA routes with history navigation and direct reload.
3. Multi-page site with same-origin links and page-specific assets.
4. Open shadow roots plus adopted stylesheets and pseudo-elements.
5. Lazy images, nested scroll containers, and mutation-driven content.
6. Canvas/WebGL fallback behavior.
7. Fetch/XHR variants: query parameters, POST bodies, repeated polling, errors, redirects.
8. Worker, service worker, iframe, blob URL, and CacheStorage resources.

Use generated fixture data; do not copy production sites into the repository.

## Metrics

Record per fixture:

- discovered resource count
- eligible response body count
- captured body count
- unresolved count by reason
- external requests during replay
- console/runtime errors during replay
- saved page routes
- screenshot hash or perceptual difference
- capture duration
- archive size
- peak body bytes held in extension memory when measurable

## Implementation Requirements

- Add one command that runs the full local corpus.
- Emit machine-readable JSON and a concise Markdown scorecard.
- Run each deterministic fixture at least twice and report variance.
- Keep authorized real-site checks optional and outside CI.
- Do not loosen tests to make a failing site look green.

## Acceptance Criteria

- CI runs all controlled fixtures without external network access.
- A seeded missing resource is reported as a miss.
- A seeded external request fails the benchmark.
- A seeded runtime exception fails the benchmark.
- A saved multi-page route is distinguishable from SPA root fallback.
- Repeated fixture runs produce stable counts and screenshot results.

## Stop/Go

Stop if the benchmark itself is flaky in more than one of ten repeated runs. Fix measurement before changing capture behavior.

## Verification

Run all existing checks plus the new corpus command. Include exact results in the final response.
