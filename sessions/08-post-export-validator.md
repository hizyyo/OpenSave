# Session 08: Automatic Post-Export Validation

Turn archive validation into a product feature, not only a repository test.

## Objective

After generation, open every saved route within the crawl budget, verify required local files, and report whether the copy is ready, partial, or failed.

## Required Work

1. Define validator inputs from capture graph, route graph, required resources, and report.
2. Serve or mount the generated archive without external network access.
3. Validate root page and every captured route within budget against its route marker or expected content.
4. Collect console errors, exceptions, failed required requests, replay misses, service-worker control, and DOM assertions.
5. Distinguish capture misses from rewrite failures and replay-runtime failures.
6. Add a side-panel result: ready, partial, or failed, with exact diagnostics.
7. Do not block archive download when validation fails; mark it clearly and retain evidence.

Defer screenshot comparison, interaction replay, saved API example testing, and a separate local validator application.

## Acceptance Criteria

- Seeded stale SRI, external script, duplicate script, broken route, missing required asset, and runtime exception are detected.
- Zero-egress is verified.
- Saved page routes are checked against their own page content, not only non-empty HTML.
- Validation can be cancelled.
- Validation overhead is measured and bounded.
- Reports are machine-readable and included in the archive.

## Stop/Go

If browser restrictions make in-extension validation unreliable, design a small optional local validator companion instead of faking success. Preserve the same report schema.

## Verification

Extend the controlled corpus with one seeded failure per validator category.
