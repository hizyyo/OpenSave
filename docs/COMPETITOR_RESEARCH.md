# Competitor Research

> Behavioral research only. Suggested developer/export capabilities in this document are not active roadmap items unless they also appear in `docs/PRODUCT_ROADMAP.md`.

Verified on 2026-08-28. This document is about behavior and architecture. No competitor source has been copied into openSave.

## Corrections To Common Claims

- SingleFile is not approximately 15k stars anymore. GitHub reported 22,255 stars during this review.
- `dgraham/save-page-we` does not exist. Save Page WE is distributed through browser stores; available GitHub repositories are unofficial mirrors or adaptations.
- "Resource Saver" and "Site Sucker" describe a product category, not one verified canonical open-source architecture.
- High star count does not mean a design is compatible with openSave's MIT license or static-ZIP architecture.

## Verified Projects

| Project | Repository | License | Main Strength | Reuse Decision |
| --- | --- | --- | --- | --- |
| SingleFile | `gildas-lormeau/SingleFile` | AGPL-3.0 | Mature live-DOM single-file capture, lazy loading, frames, optimization, many output/destination options | Behavioral reference only; no source copying or close porting |
| WebScrapBook | `danny0838/webscrapbook` | MPL-2.0 | Capture missions, linked-page crawl, multiple formats, archive management, IndexedDB-backed work | Prefer clean-room implementation; copied MPL files would retain MPL obligations |
| ScrapBook X | `danny0838/firefox-scrapbook` | MPL-2.0 | Archive tree, metadata, indexing, annotation | Legacy architecture; data-model reference only |
| ArchiveWeb.page | `webrecorder/archiveweb.page` | AGPL-3.0 | CDP network evidence, WARC/WACZ, high-fidelity replay | Standards/behavior reference only |
| Browsertrix Crawler | `webrecorder/browsertrix-crawler` | AGPL-3.0-or-later | Browser behavior execution, scoped crawl, retries, reproducible WACZ | Behavior and benchmark reference only |
| ArchiveBox browser extension | `ArchiveBox/archivebox-browser-extension` | MIT | Redundant artifacts, MHTML, screenshots, OPFS, capture manifest | Permissive reference after dependency/license review |
| Monolith | `Y2Z/monolith` | CC0-1.0 | Deterministic static resource graph and embedding | Parser/export concepts are permissive; browser-state capture is out of scope |

## What Competitors Demonstrate

### SingleFile

Useful behavioral targets:

- live DOM state matters as much as network bytes
- deferred/lazy content needs a bounded activation stage
- frames, shadow roots, canvas, form state, CSSOM, and adopted styles require explicit handling
- output adapters should be separate from capture
- every optimization should be optional because removing "unused" content can destroy fidelity

Do not copy its implementation. AGPL is incompatible with silently transplanting code into an MIT extension.

### WebScrapBook

Useful architectural targets:

- a capture mission should be durable and cancellable
- large capture work should spill to IndexedDB rather than remain in memory
- page crawl needs budgets, scope, deduplication, redirect handling, and explicit decisions
- capture, storage, organization, and export are separate concerns
- multiple output formats should consume one capture model

### ArchiveWeb.page And Browsertrix

Useful targets:

- raw request/response evidence deserves a standards-based archive
- WARC/WACZ should be additive to the static ZIP
- browser behaviors and crawl scope must be versioned and reported
- replay fidelity should be measured independently of capture success
- an archive must explain missing response bodies rather than silently omit them

### Save Page WE

Useful behavioral targets from available distributions/mirrors:

- staged discovery before serialization
- current form/canvas state
- lazy-load scrolling modes
- single-file portability
- unsaved-resource reporting

The source commonly found online is GPL-licensed and unofficial. Do not use it as upstream source code.

## openSave Differentiation

openSave should not compete only on "one HTML file." Its strongest direction is a local developer capture compiler:

1. Preserve immutable browser evidence and provenance.
2. Produce a hermetic offline replay and explain every miss.
3. Derive API contracts, page/state graphs, assets, and design tokens with evidence and confidence.
4. Produce an authorized reconstruction pack without claiming to recover original proprietary source.

## Features To Adopt Independently

Priority order:

1. Benchmark corpus and post-export validator.
2. Provenance-aware capture graph.
3. Durable OPFS/IndexedDB body storage.
4. Live DOM and shadow/adopted-style capture.
5. Typed resource parsing and rewriting.
6. Rendered multi-page crawl.
7. Hermetic chronological replay.
8. Browser state capsule.
9. API evidence and OpenAPI candidate.
10. Asset/design-token export.
11. Source-map module graph with rights controls.
12. Independently implemented WARC/WACZ export.
13. Framework-neutral developer pack.

## Explicit Non-Goals

- DRM, captcha, anti-bot, or access-control circumvention
- autonomous checkout, wallet, account, or destructive actions
- claiming generated code is original recovered source
- domain-specific branches in core
- copying AGPL/GPL implementations while keeping an MIT label
