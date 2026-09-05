# openSave MVP Sessions

This directory is the executable roadmap. Run one session at a time in its own engineering session. Later prompts assume the contracts and tests from earlier prompts.

## Product Promise

openSave saves the current rendered page or a small, bounded same-origin site as a structured ZIP that opens locally without external network access. The MVP preserves visible content and navigation, reports what is missing, protects obvious credentials in metadata and logs, and avoids pretending to emulate an entire browser or backend.

## Completed Foundation

| Session | Outcome |
| --- | --- |
| `00-ultra-review.md` | Measured risks and architecture priorities. |
| `01-benchmark-corpus.md` | Controlled capture and replay benchmarks. |
| `02-capture-graph.md` | Provenance-aware capture graph. |
| `03-durable-capture-storage.md` | Durable mission metadata and chunked body storage. |
| `04-live-dom-state.md` | Versioned safe live DOM state, open shadow roots, styles, canvas/blob fallback, and omission diagnostics. |
| `05-resource-parser.md` | Typed HTML, CSS, SVG, responsive-image, and static-module discovery and rewriting. |

## Remaining MVP

| Session | User outcome |
| --- | --- |
| `06-rendered-page-crawler.md` | Opt-in `Save site` visits a small bounded set of explicit same-origin links as rendered pages. |
| `07-hermetic-replay.md` | Saved pages and supported exact requests resolve locally; unknown requests fail closed with reasons. |
| `08-post-export-validator.md` | Every saved route is opened and classified as ready, partial, or failed. |
| `09-user-status-and-logs.md` | Users get clear progress, result counts, warnings, and one recommended action. |
| `10-privacy-guardrails.md` | Credentials and sensitive form values are kept out of metadata, reports, and logs. |
| `11-archive-optimization.md` | Deterministic deduplication, compression, size warnings, and explicit large-media choices reduce archive size safely. |

The original sessions 09-15 and 19-22 were removed because they were developer-only, speculative, high-risk, or separate products. The three retained user-facing prompts were renumbered to keep the active sequence contiguous.

## Explicitly Cut

- browser-state/cookie/IndexedDB restoration
- HAR/OpenAPI and API-contract extraction
- design-token and developer asset packs
- source-map/module graph export
- WARC/WACZ output
- project reconstruction packs and generated scaffolds
- Developer Mode and a large settings surface
- single-HTML export
- incremental capture updates
- capture diff/change monitoring
- automatic repair assistant

Do not reintroduce these without measured user demand and a separate product decision.

## MVP Defaults

- `Save page` is the default; `Save site` is opt-in and bounded.
- The structured ZIP is the only output format.
- No form submission, destructive interaction, speculative route clicking, or cross-origin crawl.
- No cloud service or external SaaS dependency.
- No hostname, framework, or product-specific branches in core.
- Unsupported behavior remains visible as partial or failed.
- Captures are private by default and are not labeled safe to share automatically.

## Definition Of Done

- Existing Quick, Deep, selected-block, scenario, and launcher behavior remains available unless the assigned session explicitly replaces it.
- New behavior has positive and negative tests across unrelated stacks where heuristics are involved.
- Syntax, focused regressions, golden archive, browser integration, and full benchmark corpus pass.
- Offline replay makes zero unexpected external requests.
- Documentation states known limits and the final response reports changed files and exact checks.
- Do not commit, tag, push, or start another session unless explicitly requested.
