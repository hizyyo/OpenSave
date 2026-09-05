# Session 07: Hermetic Replay And Request Matching

Make offline behavior deterministic and explain every replay miss.

## Objective

Guarantee zero external network egress and resolve saved pages, assets, and exact saved Fetch/XHR requests locally.

## Required Work

1. Define exact request identity using method, normalized URL, content type, and body hash.
2. Support GET/HEAD, navigations, redirects, and exact JSON/form POST variants already present in capture evidence.
3. Match repeated identical requests in recorded order.
4. Record ambiguity instead of guessing silently.
5. Fail closed for unknown mutations, WebSocket, SSE, beacon, range, and streaming requests.
6. Produce `replay-misses.json` with reason codes and evidence.
7. Keep CSP/service-worker blocking as defense in depth, not as the matcher.

## Acceptance Criteria

- Controlled replay makes zero external requests.
- All required saved page/asset requests and at least 98% of supported recorded requests are locally fulfilled on the benchmark corpus.
- Every miss has a reason code.
- Repeated polling responses replay in recorded order.
- POST variants to the same URL do not collide.
- Ambiguous matches are visible in the report.
- Unknown mutation requests fail closed.

## Stop/Go

Do not add heuristic body equivalence until exact and normalized matching metrics are measured. Prefer visible misses over unsafe guesses.

## Verification

Add GET/POST variants, repeated requests, redirect, unknown mutation, beacon, WebSocket/SSE fail-closed, and zero-egress tests.
