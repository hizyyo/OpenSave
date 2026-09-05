# Session 00: Ultra Review

You are reviewing the current openSave repository as a senior browser-platform engineer. This session is analysis and documentation only. Do not implement product features.

## Objective

Produce a current, evidence-based architecture review and a prioritized development plan. Separate verified facts from assumptions and competitor marketing.

## Required Work

1. Read `README.md`, `manifest.json`, `background.js`, `sidepanel.js`, all tests, docs, changelog, and recent Git history.
2. Map the complete data flow from action click to ZIP download and local replay.
3. Identify every place where capture evidence is mutated, inferred, fetched again, rewritten, dropped, or silently replaced by a fallback.
4. Identify global mutable state, MV3 service-worker lifetime risks, memory amplification, body-size limits, race conditions, and detach/cancellation behavior.
5. Audit Quick, Deep, scenario recording, start-overlay activation, page crawling, API snapshots, cache capture, URL rewriting, route mapping, CSP, and launchers.
6. Review current tests and list failure classes they cannot detect.
7. Verify competitor repositories and licenses. Do not rely on names or star counts from the prompt.
8. Compare behavior, not code, against SingleFile, WebScrapBook, ArchiveWeb.page, Browsertrix, ArchiveBox extension, and Monolith.
9. Search the openSave core for hostname/domain checks and accidental site-specific behavior.
10. Evaluate whether current `background.js` and `sidepanel.js` boundaries can support the later sessions without a rewrite.

## Focus Questions For This Codebase

- Where does `background.js` drop or delay response bodies when multiple requests finish close together?
- Which parts of `sidepanel.js` assume same-origin relative paths and break on cross-origin assets with complex query strings?
- How does the current router handle SPA deep links versus static HTML files when served from a subpath versus origin root?
- What happens when a captured site registers its own service worker during offline replay?
- Which exact heuristics in `exploreInteractiveElements` can cause navigation or state loss despite the safety regexes?

## Deliverables

Create or replace:

- `docs/ULTRA_REVIEW.md`
- `docs/TARGET_ARCHITECTURE.md`
- `docs/RISK_REGISTER.md`

`ULTRA_REVIEW.md` must contain findings ordered by severity with exact file/function references.

`TARGET_ARCHITECTURE.md` must define these boundaries without prescribing a framework rewrite unless evidence requires it:

- capture mission lifecycle
- capture graph and body store
- live DOM/state snapshots
- resource discovery and typed rewriting
- crawl planner
- archive writers
- replay runtime
- validator
- developer extractors

`RISK_REGISTER.md` must include likelihood, impact, detection, mitigation, owner session, and stop/go criteria.

## Constraints

- No feature implementation.
- No competitor source copying.
- No vague recommendation such as "add more tests"; name the exact test and failure it catches.
- Do not propose a full framework migration unless a measured limitation makes it necessary.
- Preserve the no-build extension until a later session proves a build system is required.

## Acceptance Criteria

- Every critical finding cites current code.
- Every roadmap item maps to one session in `sessions/`.
- License risks are explicit.
- The review identifies which current behaviors are contractual and which are accidental.
- The review ends with a ranked top five and a recommendation to continue, revise, split, or delete each later session.

## Verification

Run existing syntax and test commands only to establish baseline status. Do not fix failures in this session. Record the commands and outputs in `docs/ULTRA_REVIEW.md`.
