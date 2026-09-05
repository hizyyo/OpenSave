# Session 05: Typed Resource Discovery And Rewriting

Replace the most fragile regex-based URL handling with typed parsers and one resolver contract.

## Objective

Make common page resource discovery and rewriting deterministic across HTML, CSS, SVG, `srcset`, lazy-loading attributes, and static module references.

## Current Problem To Verify

`sidepanel.js` currently has separate regex and DOM paths for CSS, JavaScript strings, HTML attributes, source maps, and glTF. Broad JavaScript string rewriting can change application semantics, while CSS and responsive-image syntax have edge cases that regex alone handles poorly.

## Required Work

1. Define one `ResourceReference` shape: owner artifact, syntax kind, raw value, resolved URL, byte range or DOM location, role, and rewrite policy.
2. Implement typed discovery adapters for:
   - HTML URL attributes and lazy attributes
   - `srcset` and image candidates
    - CSS `url()`, `@import`, `@font-face`, and `image-set`
    - SVG href/xlink/filter/mask/paint references
    - static ES module specifiers using a JavaScript parser
3. Centralize URL normalization, aliases, redirects, and unresolved policy.
4. Rewrite only syntax nodes known to be URL references. Do not replace arbitrary JavaScript strings.
5. Preserve original source as evidence and emit rewritten output separately.

Defer typed glTF parsing, source-map discovery, import maps, workers, `importScripts`, and uncommon dynamic module patterns. Existing bounded behavior may remain, but this session does not expand it.

## Constraints

- Select dependencies with permissive licenses and browser-compatible bundles.
- If introducing a build step, prove why vendored browser-ready parser files are insufficient and document reproducible builds.
- Do not make one parser failure abort the whole capture; emit typed diagnostics.

## Acceptance Criteria

- Paths containing spaces, parentheses, fragments, queries, Unicode, escaped characters, and data/blob URLs pass.
- JavaScript fixtures prove ordinary strings are not rewritten.
- Nested CSS imports and SVG references resolve.
- Unresolved executable references are removed or blocked according to policy.
- Existing benchmark completeness does not regress.

## Stop/Go

Stop broad JavaScript rewriting as soon as parser-based module rewriting reaches parity. Do not keep both indefinitely.

## Verification

Add table-driven parser tests plus golden-output tests for every syntax family.
