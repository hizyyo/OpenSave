# Product Roadmap

The active roadmap is deliberately small. openSave is a reliable local website saver, not a web forensics suite, source-reconstruction product, monitoring tool, or browser-state emulator.

## Product Goal

Save the current rendered page or a bounded same-origin site into one structured ZIP that:

- opens through the included local launchers
- preserves visible page state and required files
- makes no unexpected external replay requests
- reports every important miss
- warns about credentials and archive size
- tells an ordinary user whether the result is ready, partial, or failed

## Foundation

Sessions 00-05 are complete:

- controlled benchmark corpus
- provenance-aware capture graph
- durable mission and body storage
- explicit interruption, quota, cancellation, and cleanup behavior
- safe current form/disclosure state, open shadow roots, adopted/CSSOM styles, and bounded canvas/blob fallback
- explicit diagnostics for closed roots, tainted canvases, inaccessible styles, and size limits
- typed HTML, CSS, SVG, responsive-image, and static-module resource references with syntax-only rewriting

## Remaining Work

### Resource Fidelity And Crawl

Sessions 05-06 (`05` complete):

- replace unsafe common URL rewriting with typed references (complete)
- add a small opt-in rendered crawler for explicit same-origin links

Exit gate:

- ordinary JavaScript strings are not rewritten
- every skipped route/resource has a reason
- crawler budgets and cancellation work

### Replay And Validation

Sessions 07-08:

- local exact request matching and fail-closed unsupported requests
- zero-egress replay
- automatic validation of every saved route within budget
- ready/partial/failed result based on required content, not an aggregate vanity score

Exit gate:

- all required saved pages/assets resolve locally
- supported request fulfillment reaches the measured target
- seeded route, asset, runtime, and external-request failures are detected

### User Safety And Cost

Sessions 09-11:

- plain-language progress and result summary
- credential and sensitive-form guardrails for metadata/reports/logs
- content-hash deduplication, ZIP compression, size estimates, warnings, and explicit large-media choice

Exit gate:

- users can distinguish ready, partial, failed, cancelled, and recoverable captures
- seeded credentials do not appear in metadata, reports, or logs
- optimization reduces duplicate-heavy archives without lowering route or required-asset success

## Not In Scope

- browser storage/cookie restoration
- API/OpenAPI extraction
- design-token or developer asset extraction
- source-map graph or recovered source export
- WARC/WACZ
- project reconstruction/scaffolding
- Developer Mode
- single-file HTML
- incremental updates
- capture diff/change tracking
- automated repair framework

These capabilities were removed because they serve niche developer workflows, create separate products, duplicate the export pipeline, or add substantial privacy and correctness risk without improving the core user promise.

## Scope Gate

Do not add a new format, extractor, emulator, heuristic interaction engine, or secondary workflow unless controlled evidence shows that users cannot complete the core save/open task without it. Fix deterministic exporter defects at their source instead of building a repair assistant.
