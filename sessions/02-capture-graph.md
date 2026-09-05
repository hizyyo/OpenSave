# Session 02: Provenance-Aware Capture Graph

Replace loosely related response maps with one versioned capture model.

## Objective

Create a single source of truth for observed requests, responses, bodies, aliases, documents, pages, frames, workers, API exchanges, and derived dependencies.

## Current Problem To Verify

The current architecture stores related facts in multiple global structures such as `capturedBodies`, `pendingResponses`, `pendingRequests`, `apiSnapshots`, and report arrays. URL-only deduplication can collapse distinct request variants, and derived fallback fetches are difficult to distinguish from bytes observed by Chrome.

## Required Data Model

Define versioned records with stable IDs:

- capture mission
- target/frame/worker
- request
- response
- body/blob
- document/page
- dependency edge
- API exchange
- derived artifact
- diagnostic

Every record must distinguish:

- `observed`: delivered through CDP
- `refetched`: fetched later by openSave
- `derived`: parsed or rewritten from evidence
- `inferred`: heuristic conclusion

Include request method, normalized URL, original URL, request body hash, response status, MIME type, redirect chain, timestamps, source target, content hash, size, and evidence references.

## Implementation Requirements

- Introduce the graph behind existing capture behavior without changing archive output in the first step.
- Add adapters from the graph to the current ZIP writer and report.
- Do not deduplicate only by URL. Preserve aliases while deduplicating bodies by content hash.
- Keep original bytes immutable. Rewritten files are derived artifacts.
- Version the schema and document migration expectations.
- Remove old parallel maps only after parity tests pass.

## Acceptance Criteria

- Existing fixtures produce equivalent archive content and no lower completeness.
- GET and POST to the same URL remain distinct exchanges.
- Redirected URLs retain both original and final identities.
- Identical bytes from two URLs share a blob but retain two request/response records.
- Refetched resources are visibly different from observed responses in the report.
- No hostname-specific logic is introduced.

## Stop/Go

Do not proceed to durable storage until archive parity and report parity pass on the benchmark corpus.

## Verification

Add schema tests, deduplication tests, redirect tests, request-variant tests, and end-to-end archive parity checks.
