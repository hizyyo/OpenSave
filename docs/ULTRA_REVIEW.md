# openSave Ultra Review

> Historical review of the original broad roadmap. Its developer extraction, interoperability, reconstruction, single-HTML, incremental, diff, and repair recommendations were cut from the MVP. Current scope is defined only by `docs/PRODUCT_ROADMAP.md` and the remaining files in `sessions/`.

Review date: 2026-08-28

## Scope And Method

This is a documentation-only review of the current repository. It covers `README.md`, `manifest.json`, `background.js`, `sidepanel.js`, `sidepanel.html`, all tests and fixtures, current docs and changelog, all session prompts, and the latest 15 Git commits. No product code was changed.

Evidence labels used below:

- **Verified** means directly established from current source, tests, Git history, or a cited primary source.
- **Inference** means a consequence of the verified implementation that still needs a reproducing fixture or measurement.
- **Marketing claim** means first-party product language not independently benchmarked here.

## Executive Verdict

**Revise the architecture incrementally and continue. Do not rewrite the extension or add a framework/build system now.** Quick, Deep, selected-block export, scenario recording, launchers, and route mapping are real working behaviors, and the baseline suite passes. However, the current representation cannot support evidentiary claims: request/response identity is collapsed to URL, response metadata is discarded, later authenticated refetches are merged with browser-observed bodies, and all bodies are retained and repeatedly copied in memory.

The existing `background.js`/`sidepanel.js` process boundary is usable as a deployment boundary, but not as the long-term domain boundary. Preserve the no-build MV3 extension and add stable interfaces for mission lifecycle, capture graph/body storage, typed transformation, writers, replay, and validation. Split physical files only after those contracts are tested.

## Severity-Ordered Findings

### Critical

#### C1. URL-only storage silently collapses distinct HTTP evidence

**Verified.** `saveCapturedBody` removes the fragment and keys `capturedBodies` only by normalized URL. The first body wins; a later response at the same URL is discarded, except that an XHR/fetch can toggle `preserveUrl` on the existing entry (`background.js:301-314`). `apiSnapshots` improves the key to method, URL, and post-data, but still keeps only the first response for that key and only records successful 2xx fetch/XHR responses (`background.js:316-331`). Cache entries use the same URL-only body key and first-wins API key (`background.js:474-499`). Redirect records, response headers, request headers, timestamps, initiators, frames, repeated polling order, non-2xx API bodies, and content hashes do not reach the result (`background.js:165-171`, `background.js:301-331`, `background.js:565-577`).

**Impact.** Two GETs returning different bytes, repeated polling, content negotiation, redirects, and state-dependent responses can be reported as captured while only one variant survives. Sessions 07, 10, 13, 20, and 21 cannot be implemented correctly on this representation.

**Required action.** Session 02 must introduce request, response, and immutable body identities before feature extraction or standards export.

#### C2. Refetched resources are merged with observed bodies without provenance

**Verified.** After CDP capture completes, `collectMissingFiles` performs new extension-context `fetch()` calls with `credentials: 'include'` and `cache: 'no-store'` (`sidepanel.js:903-998`). The returned blob is inserted through the same `catalog.add` path as CDP bodies (`sidepanel.js:964-969`, `sidepanel.js:851-895`). The archive manifest only counts resources and does not identify which were observed versus refetched (`sidepanel.js:1189-1198`). `finalizeReport` removes prior network/unreadable failures whenever a normalized URL now exists in the catalog (`sidepanel.js:51-72`).

**Impact.** A later response can differ by time, cookie context, CORS behavior, cache, or server state yet silently replace a missing observation and erase its diagnostic. This contradicts the README claim that everything is what “the browser actually received” (`README.md:7-13`). It also sends authenticated refetches from the extension and may put private response data into the ZIP without a privacy gate.

**Required action.** Sessions 02 and 17 must preserve provenance and privacy status. Refetch may remain a fidelity fallback, but must be labeled `refetched`, linked to its own request/response, and must not resolve an observed-body failure.

#### C3. Closely finishing responses launch unbounded body reads and timeout causes deterministic omission

**Verified.** Every `Network.loadingFinished` immediately calls asynchronous `captureResponseBody` without awaiting it, queueing it, or limiting concurrency (`background.js:199-215`, `background.js:284-299`). `pendingBodyReads` tracks completion but provides no backpressure. The CDP buffer is configured for 500 MiB total and 200 MiB per resource (`background.js:401-407`); those are capture buffers, not guaranteed durable storage. If Quick exceeds 3 seconds or Deep exceeds 10 seconds waiting, `waitForPendingBodies` records a generic timeout and returns false (`background.js:1145-1157`), but `fullCapture` ignores that return value, snapshots the current maps, reports success, and detaches (`background.js:557-581`). Responses still in `pendingResponses` have never started a body read. Late body reads fail the operation-ID check or the debugger detach and are not included (`background.js:284-299`).

**Direct answer to the focus question.** Bodies are not dropped because JavaScript events overwrite one request ID; `requestKey` includes child session and request ID (`background.js:272-274`). They are dropped or delayed because all completions fan out into concurrent `Network.getResponseBody` calls, Chrome has bounded protocol buffers, there is no read scheduler, and the fixed wait deadline proceeds to serialization and detach while work remains.

**Impact.** Burst-heavy pages can produce a superficially successful archive with omitted bodies. The report can contain a timeout, but archive success and completeness do not enforce it.

**Required action.** Session 01 must reproduce burst pressure; Session 02 must model body state/reasons; Session 03 must persist incrementally and bound reads.

#### C4. The archive pipeline has multi-copy, whole-site memory amplification

**Verified.** CDP returns bodies as strings/Base64 and all retained bodies live in global maps (`background.js:6-11`, `background.js:301-331`). The complete body and API arrays are structured-cloned in one runtime message (`background.js:565-577`). The side panel retains those objects in the catalog, decodes Base64 text to another byte array/string (`sidepanel.js:243-247`), converts fetched blobs to text during discovery and again during rewriting (`sidepanel.js:935-986`, `sidepanel.js:1001-1023`), mutates text bodies into rewritten strings, adds bodies to JSZip, and finally generates the complete ZIP as one Blob (`sidepanel.js:1175-1223`). API bodies can exist in both `bodies` and `apiSnapshots` (`background.js:301-331`, `sidepanel.js:1203-1212`). JSZip is v3.10.1 (`lib/jszip.min.js:1-4`).

**Inference.** Peak memory can be several times archive payload, especially for Base64 and rewritten text. The exact factor is not measured by current tests.

**Impact.** Large media/model captures risk side-panel or extension-process termination despite `unlimitedStorage`, because that permission does not create streaming or durable mission state.

**Required action.** Measure in Session 01, persist in Session 03, and do not add WACZ, optimization, incremental capture, or multiple writers before storage supports streamed reads.

#### C5. Replay is origin-root-specific and captured application service workers can replace it

**Verified.** Generated HTML, bootstrap, service-worker registration, precache entries, API snapshot paths, CSS/HTML replacements, and 404 redirection all use leading `/` paths (`sidepanel.js:253-260`, `sidepanel.js:439-445`, `sidepanel.js:481-600`, `sidepanel.js:762-848`). Documentation explicitly requires origin-root hosting (`docs/OFFLINE_ARCHIVE_FORMAT.md:52-58`). Therefore an archive deployed at `https://host.example/archive/` requests `https://host.example/sitesaver-sw.js`, not `/archive/sitesaver-sw.js`, and route keys see `/archive/...` rather than source route identities.

The captured application scripts are retained and executable. openSave does not neutralize `navigator.serviceWorker.register`; it only registers its own root worker (`sidepanel.js:773-777`). A captured application call such as `register('/sw.js')` on replay targets the replay origin. If `/sw.js` is saved and served, it can create or update a competing registration and may replace openSave for the same scope; if it is not saved, registration fails. More-specific application scopes can coexist and intercept part of the archive. Service-worker registration behavior and scope replacement are defined by the platform, not by openSave.

**Impact.** “Any static host” is only true at origin root, and replay isolation is not stable for PWA captures or for two archives sharing one origin. Activation currently deletes every cache beginning `sitesaver-offline-` except the current cache, so one archive can delete another archive’s cache on the same origin (`sidepanel.js:532-536`).

**Required action.** Session 07 must define a mount-aware replay namespace and a captured-service-worker policy. Until then, origin-root hosting is contractual and subpath hosting is unsupported.

### High

#### H1. Response metadata is discarded before the archive boundary

`Network.responseReceived` receives status, status text, headers, protocol, timing, cache/service-worker source, and security data, but body records retain only URL, MIME, body, encoding, and a replay flag (`background.js:161-175`, `background.js:301-331`). The replay runtime synthesizes headers from the static server plus content type (`sidepanel.js:584-590`, `sidepanel.js:817-825`). Status is retained only for 2xx API snapshots; static resources and documents lose their status and headers. This blocks evidence-grade HAR/WARC and can change CORS, cache, range, module, and content-disposition semantics. Owner: Sessions 02, 07, 10, 13.

#### H2. Deep page crawling is a privileged refetch, not rendered crawling

Deep discovers same-origin anchors from DOM or fetched HTML (`sidepanel.js:144-161`, `sidepanel.js:927-933`) and fetches at most 40 page URLs in extension context (`sidepanel.js:903-998`). It does not navigate/render each route, wait for route APIs, capture route DOM state, or preserve page-specific browser history. Quick uses the same fallback resource fetch but does not enqueue pages (`sidepanel.js:1152-1154`). Calling this a crawler is a useful product shorthand, but it is lower fidelity than the current roadmap requires. Owner: Session 06.

#### H3. Cross-origin URL identity is preserved in storage but broken in application semantics

Archive paths correctly include source hostname and a query hash (`sidepanel.js:219-232`), so simple filename collision is addressed. However, rewrites return root-relative local paths (`sidepanel.js:253-260`). Code that derives behavior from `new URL(asset, import.meta.url)`, URL origin/hostname, CDN path prefixes, signed query order, or same-origin checks now observes the replay origin and `/assets/...`, not the original cross-origin URL. Broad JavaScript literal rewriting changes any literal that happens to resolve to a catalog URL, not only typed URL nodes (`sidepanel.js:272-279`). API resources are exempted through `preserveUrl` (`background.js:310-314`, `sidepanel.js:888-891`), creating a separate runtime interception assumption.

**Direct answer to the focus question.** Complex query strings are hashed safely for filenames, but query-bearing aliases and JavaScript semantics assume that replacing a source URL with a root-relative local path is acceptable. `srcset` is split on commas and whitespace (`sidepanel.js:133-135`, `sidepanel.js:416-427`), which does not parse data URLs or all valid candidates. CSS uses a regex that cannot represent the full escaped/nested CSS grammar (`sidepanel.js:15`, `sidepanel.js:163-177`, `sidepanel.js:263-269`). Owner: Session 05.

#### H4. HTML/CSS/JS rewriting is destructive and original evidence is not exported separately

The writer removes SRI, original meta CSP, `<base>`, unresolved external executable/resource attributes, duplicate script nodes, and some `srcset` attributes (`sidepanel.js:359-436`). Missing absolute CSS URLs are silently changed to `data:,` (`sidepanel.js:263-269`). Text resource bodies are overwritten in place with rewritten content and marked non-Base64 (`sidepanel.js:1001-1023`). Root DOM HTML comes from a live serialization, while selected hydration scripts may be extracted from the original response and inserted into it (`background.js:854-873`, `sidepanel.js:452-479`). These transformations are valid replay strategies but are derived artifacts, not immutable evidence. Owner: Sessions 02, 04, 05.

#### H5. Replay matching cannot represent chronology, headers, binary bodies, or XHR semantics

API matching uses method, exact normalized URL or same-origin path/query, and text post body (`sidepanel.js:538-551`, `sidepanel.js:781-825`). The first matching snapshot always wins. `normalizeBody` returns empty for Blob, ArrayBuffer, FormData, streams, and many Request-body forms (`sidepanel.js:787-792`). XHR fallback rewrites the operation into asynchronous GET, losing response status/statusText/headers, sync mode, credentials, responseType, progress, and normal unmatched error events; unmatched XHR is simply aborted (`sidepanel.js:828-843`). Owner: Session 07.

#### H6. External-network blocking is defense in depth, not a proved first-load guarantee

The injected CSP limits `connect-src`/frames/workers to self and the generated worker fails closed for uncached requests (`sidepanel.js:439-445`, `sidepanel.js:559-600`). That is good. However, worker registration is asynchronous and its rejection is swallowed (`sidepanel.js:773-777`), while captured inline/module scripts remain executable. The first document is served from the static host before a worker controls it; CSP covers many network APIs but not every browser-mediated side effect, and the policy deliberately allows inline/eval/blob execution. The current integration fixture contains no application scripts or API behavior (`tests/fixtures/offline-archive/index.html:1-13`) and verifies request egress only after loading one trivial archive (`tests/browser-integration.mjs:141-213`). Owner: Sessions 01, 07, 08.

#### H7. There is no durable mission, cancellation command, or recovery path

Mission identity and all progress are global variables (`background.js:1-13`, `background.js:241-254`). One operation is allowed globally. There is no cancel message, abort controller, tab-close recovery record, restart recovery, quota accounting, or partial export. Closing the side panel only makes `sendResponse` throw and be ignored (`background.js:510-517`); capture continues. User/DevTools detach resets state (`background.js:116-121`, `background.js:1180-1202`) without delivering a typed terminal result. Chrome 125 mitigates ordinary idle suspension because an active `chrome.debugger` session keeps the extension worker alive, but extension reload, browser/worker crash, debugger replacement, and post-detach side-panel work remain non-durable. Owner: Session 03, with UI in Session 16.

#### H8. Interactive exploration can navigate or mutate state despite safety regexes

`exploreInteractiveElements` selects summaries, tabs, menuitems, any `[aria-expanded]`, any `[data-toggle]`, and selected buttons (`background.js:990-1000`). Its safety decision is based on the candidate’s labels/attributes and only rejects an ancestor form/link, selected English/Russian danger words, and a hard-coded list of external brand names (`background.js:1019-1047`). It does not inspect attached listeners, framework action semantics, descendants, controlled panel contents, network method, resulting URL, history, storage, or mutation effects.

Exact failure heuristics:

- A menuitem or `aria-expanded` element can call `location.assign`, `history.pushState`, open a route, or mutate account state without an `href`/form.
- A destructive label in another language, icon-only accessible name not present in the inspected attributes, or generic text such as “Continue” passes.
- URL attributes on descendants or event-handler data stored under unlisted attributes are not checked.
- `restore` clicks every summary/`aria-expanded` candidate again regardless of whether the first click removed it, navigated, or changed expansion asynchronously (`background.js:1054-1068`). A second click can trigger a different action.
- Non-tab/non-disclosure controls have no rollback; unchanged first 50,000 characters of `body.innerHTML` is counted as rollback even if URL, storage, network state, shadow DOM, or later DOM changed (`background.js:1006-1011`, `background.js:1061-1068`).
- `visited` records element objects, but rerendered replacement nodes are new objects and can be clicked in later rounds (`background.js:995`, `background.js:1081-1116`).
- The fingerprint truncation can collide or ignore meaningful state after byte 50,000.

The hard-coded external-brand regex is site/service-specific behavior in core, contrary to the generic-policy rule (`background.js:998`). Owner: Sessions 01 and 06; remove brand policy during that work.

### Medium

#### M1. Start-overlay activation has a smaller but real mutation risk

The stage waits up to eight seconds and clicks the first visible exact `START|BEGIN|ENTER|LAUNCH` label outside forms, links, and editable content (`background.js:810-848`). Exact labels and form/link exclusions reduce risk, but a plain `div`/`span` with an onclick can still navigate or mutate state. The source-regex test proves only that strings and ordering exist, not behavior (`tests/start-overlay-regression.mjs:1-28`). Owner: Sessions 01 and 06.

#### M2. Scenario recording is lossy and replay is not state-verified

Recording excludes text inputs and selected sensitive input types, records at most 200 deduplicated actions, and creates selectors from IDs/test IDs or DOM positions (`background.js:134-143`, `background.js:721-765`). It does not store timing, page/route identity, frame/shadow-root context, expected state, or failures. Replay skips missing selectors silently and invokes `.click()`/events (`background.js:778-808`). Finishing a scenario always initiates Deep capture (`background.js:98-100`). Owner: Sessions 02, 04, 06, 08.

#### M3. Cache capture conflates cache artifacts with network/API observations

Deep inventories the page origin plus origins inferred from child-target URLs (`background.js:435-453`). Every successful cache entry can be added both as a resource body and an API snapshot regardless of whether it was observed during this mission (`background.js:455-503`). Request headers are used to retrieve the cache entry but not retained. Owner: Sessions 02 and 09.

#### M4. Completeness can report 100% with no discovered resources and hides resolved failures

Completeness considers only `discoveredResources`, not every eligible CDP response, API exchange, route, state, or runtime request. An empty set scores 100 (`sidepanel.js:51-72`; fixture `tests/fixtures/offline-archive/sitesaver-report.json:1`). Failures are removed if any catalog item normalizes to the same URL. Owner: Sessions 01, 02, 08, 16.

#### M5. Reporting truncates diagnostics silently at 100 records

Both `addReport` and `addReportItem` stop adding at 100 with no truncation counter (`background.js:256-260`, `sidepanel.js:45-49`). A noisy site can hide later high-value misses. Report update send failures are swallowed (`background.js:263-269`). Owner: Sessions 02 and 16.

#### M6. Child-target coverage is partial and target provenance is lost

Auto-attach recursively enables listed out-of-process target types (`background.js:401-429`), but same-process iframe execution contexts are not inventoried, and target identity is discarded from saved body records. Chrome’s debugger documentation distinguishes same-process frame execution contexts from out-of-process targets. Owner: Session 02 and Session 04.

#### M7. Publisher CSP is replaced with a permissive execution policy

Removing source CSP is necessary for rewritten assets, but the replacement allows `'unsafe-inline'`, `'unsafe-eval'`, and blob workers/scripts (`sidepanel.js:372-377`, `sidepanel.js:439-445`). Network restrictions are useful, but the archive is not a safe-content sandbox and should not be described as one. Owner: Session 07.

#### M8. Launcher and static-host routing behavior is inconsistent

The PowerShell launcher maps unknown extensionless paths to root `index.html` before service-worker control (`sidepanel.js:698-733`). Python launchers return normal static-server 404s and depend on the generated `404.html` behavior of a hosting provider or an already controlling worker (`sidepanel.js:633-759`). The 404 file redirects to root (`sidepanel.js:481-493`). Direct deep-link behavior therefore varies by launcher/server and all variants assume root mounting. Owner: Sessions 01 and 07.

## Complete Data Flow

1. Chrome action behavior is configured only during `runtime.onInstalled`; clicking the action opens `sidepanel.html` through `sidePanel.setPanelBehavior` (`background.js:38-40`, `manifest.json:9-17`). **Inference:** profiles where this setting was not persisted after an extension update need a focused test.
2. The side panel asks for the active tab and sends `fullCapture` with Quick or Deep (`sidepanel.js:898-901`, `sidepanel.js:1116-1134`).
3. The background creates one global operation, attaches the debugger, clears in-memory maps, enables Network/Target capture, disables browser cache, enables Page, and reloads the tab (`background.js:56-64`, `background.js:241-254`, `background.js:376-424`, `background.js:510-534`).
4. Network events populate request and response maps. Eligible responses are selected by MIME/extension, with cross-origin documents rejected; finished responses start asynchronous body reads (`background.js:123-225`, `background.js:276-299`).
5. Quick waits after reload and captures the live outer HTML. Deep additionally activates a start overlay, replays a scenario, scrolls, hovers, clicks candidate UI states, scrolls again, takes limited canvas snapshots, and reads CacheStorage (`background.js:536-576`).
6. `fullCapture` returns live HTML, URL-deduplicated bodies, first-wins API snapshots, interaction counters, snapshots, and diagnostics in one message, then detaches (`background.js:565-582`).
7. The side panel builds URL-to-local-path catalog entries. It parses HTML and retained text resources, then refetches missing resources and, in Deep, same-origin linked pages (`sidepanel.js:851-999`, `sidepanel.js:1149-1164`).
8. It derives API snapshot files, filters report failures by URL presence, destructively rewrites HTML/CSS/glTF/JavaScript, restores selected TanStack hydration scripts from a captured document body, and injects CSP/bootstrap (`sidepanel.js:1166-1180`).
9. It creates root HTML/404, replay JS/service worker, report/manifest, launchers, snapshots, canvases, and rewritten resources in JSZip (`sidepanel.js:1182-1213`).
10. JSZip materializes one archive Blob; `chrome.downloads.download` downloads a hostname-named ZIP (`sidepanel.js:1214-1224`).
11. On local replay, a static server serves root `index.html`; bootstrap registers root `/sitesaver-sw.js`, patches fetch/XHR and unavailable streaming APIs, and restores a route passed by `404.html` (`sidepanel.js:762-848`).
12. Once controlling, the service worker checks exact cache, captured page routes, API snapshot matching, then exact cache; it returns 503 for external/non-GET misses and 404 for unsaved same-origin GETs (`sidepanel.js:496-600`).

## Evidence Mutation Ledger

| Stage | Evidence action | Reference | Visible today? |
| --- | --- | --- | --- |
| Eligibility | Non-HTTP, unsupported MIME/extension, and cross-origin documents are dropped | `background.js:276-282` | Partly, as `skippedResponses`; capped |
| Request capture | POST data defaults to empty and is bounded by CDP’s 10 MiB setting | `background.js:190-195`, `background.js:401-407` | No truncation distinction |
| Response capture | Headers/timing/redirect/source metadata are dropped | `background.js:161-175`, `background.js:301-331` | No |
| Body identity | Fragments removed; repeated URL variants collapse first-wins | `background.js:301-331` | No |
| API identity | Only 2xx fetch/XHR; repeated key collapses first-wins | `background.js:316-331` | No |
| Body failure | Error becomes unreadable diagnostic; no body record | `background.js:284-299` | Yes, capped |
| Pending timeout | Current partial maps are returned as success, then debugger detaches | `background.js:557-581`, `background.js:1145-1157` | Diagnostic only |
| Live document | Original HTML response is replaced as entry point by current outerHTML | `background.js:854-873`, `sidepanel.js:1177-1179` | `htmlMethod` only in UI, not manifest |
| Optional stages | Failure is replaced with a zero/empty fallback | `background.js:585-591` | Diagnostic plus apparently valid counter |
| Cache | Pre-existing 2xx cache entry is inferred as resource and API snapshot | `background.js:455-503` | Counts only |
| Refetch | New authenticated response is merged into observed catalog | `sidepanel.js:954-986` | Fetch count only |
| Failure filtering | URL presence removes network/unreadable/unresolved diagnostics | `sidepanel.js:51-72` | No provenance |
| HTML rewrite | CSP/base/SRI/remote attributes/scripts are removed or replaced | `sidepanel.js:359-436` | No per-change ledger |
| CSS rewrite | Missing absolute URL is replaced by `data:,` | `sidepanel.js:263-269` | No |
| JS rewrite | Arbitrary matching string literals become local paths | `sidepanel.js:272-279` | No |
| Text resources | Original body property is overwritten by derived text | `sidepanel.js:1001-1023` | No immutable copy contract |
| Hydration | Scripts are copied from response HTML into live DOM serialization | `sidepanel.js:452-479` | No derivation record |
| Replay | Original headers and many request semantics are synthesized/dropped | `sidepanel.js:538-600`, `sidepanel.js:762-848` | No replay-miss ledger |

## Feature Audit

| Feature | Verified current contract | Main limitation | Decision |
| --- | --- | --- | --- |
| Quick | Reload current tab, capture eligible network bodies/live HTML, refetch direct discovered dependencies, no linked-page enqueue | Not a passive snapshot; URL collapse and refetch provenance apply | Preserve; benchmark in S01 |
| Deep | Quick plus bounded start/scenario/scroll/hover/click/canvas/cache and linked-page refetch | Interaction can mutate; pages are not rendered individually | Preserve behind current label; revise through S06 |
| Scenario | Records selected click/change actions, redacts common sensitive inputs, then forces Deep replay | No timing/frame/expected-state evidence; silent skips | Preserve; attach to graph/checkpoints |
| Start overlay | Exact English startup labels, visible, excludes links/forms/editable | Non-semantic handlers remain unsafe; source-only test | Preserve but measure and report |
| Page crawling | Same-origin anchor discovery, 40-page cap, extension fetch | Fetch-only HTML, not route state | Reclassify as lower-fidelity fallback |
| API snapshots | First successful fetch/XHR response by method/URL/post body | No errors/headers/sequence/binary identity | Preserve as v1 compatibility adapter |
| Cache capture | Reads paged CacheStorage entries from known origins | Pre-existing data and API classification are inferred | Preserve with provenance |
| URL rewriting | Host-partitioned paths and query hashes; HTML/CSS/glTF/JS transforms | Regex/parser gaps and destructive in-place mutation | Replace behind typed interface |
| Route mapping | Exact source pathname+query maps to saved HTML; unknown navigation returns root | Root-mounted only; direct server behavior varies | Preserve as v1 root contract |
| CSP | Blocks connect/frame/worker to external origins and forms | Allows unsafe execution; not a content sandbox | Preserve as defense in depth |
| Launchers | Windows Python/PowerShell and Unix Python serve localhost root | Port fixed/default and route fallback differs | Preserve; add fixtures, not rewrite |

## Contractual Versus Accidental Behavior

Contractual because it is documented and/or regression-tested:

- No-build MV3 extension on Chrome 125+ (`manifest.json:2-17`, `README.md:7-23`).
- Quick and Deep modes, selected block, scenario flow, launchers, static ZIP, root hosting, external-network blocking, and SPA/page route behavior (`README.md:25-63`, `docs/OFFLINE_ARCHIVE_FORMAT.md:52-58`).
- Root route and unknown SPA route return non-empty content; captured `/card` returns saved content in the fixture (`tests/browser-integration.mjs:158-213`).
- Start activation occurs before generic exploration and Deep Runtime results use `returnByValue` (`tests/start-overlay-regression.mjs`, `tests/deep-runtime-regression.mjs`).

Accidental or under-specified and must not be frozen as a new contract:

- First response wins for a URL/request key.
- A later refetch erases an observed capture failure.
- 3/10-second body deadlines and 100-item report caps.
- Root-only generated URLs beyond the explicitly documented hosting requirement.
- TanStack-specific hydration reconstruction (`sidepanel.js:452-479`), the only framework-specific core branch found.
- External-brand names in the interaction safety policy (`background.js:998`).
- Cache names from one archive deleting other openSave caches on the origin.
- 100% completeness for zero dependencies.

## Hostname And Site-Specific Search

No production branch matches a concrete capture-site hostname. Hostname is used generically for output naming and host-partitioned paths (`background.js:562-575`, `sidepanel.js:219-232`). Same-origin checks are generic and intentional (`background.js:276-282`, `sidepanel.js:144-161`, `sidepanel.js:927-930`).

Two accidental special cases exist:

- `restoreSsrHydration` recognizes TanStack Router implementation markers (`$_TSR`, `tsr-stream-barrier`, `self.$R`) and injects those scripts (`sidepanel.js:452-479`). This violates stack-agnostic core policy even without a hostname check.
- `exploreInteractiveElements` hard-codes external service/brand names including YouTube, Discord, Telegram, GitHub, Spotify, and app stores (`background.js:998`). This safety denylist is neither complete nor generic.

## Test Coverage And Blind Spots

Current tests are mostly source-presence contracts plus one trivial generated-archive fixture. They cannot detect these exact failure classes:

| Missing exact test | Failure caught |
| --- | --- |
| Burst 300 response completions with delayed `getResponseBody` and a body-read concurrency gauge | C3 omission/race and timeout-detach behavior |
| Two sequential different GET responses at one URL plus repeated identical POST/poll responses | C1 first-wins collapse and chronology loss |
| Redirect plus request/response headers/status/timestamps round-trip assertion | H1 metadata loss |
| Captured-body failure followed by a different authenticated side-panel refetch | C2 provenance merge and failure erasure |
| 1 GiB synthetic mixed binary/Base64/text capture with peak-memory telemetry | C4 practical memory ceiling and amplification |
| Extension service-worker restart/detach/side-panel-close/cancel lifecycle fixture | H7 durability and cancellation |
| Archive mounted at `/captures/a/`, two archives on one origin, and direct deep-link first load | C5 root/subpath/cache namespace failures |
| Captured app registering root and nested-scope service workers | C5 replacement/interception behavior |
| CSS escaped parentheses/Unicode/fragments; `srcset` data URL; JS ordinary-string collision; import map scopes | H3/H4 parser corruption |
| Cross-origin CDN URL with signed complex query and code checking URL origin/path | H3 semantic breakage |
| Deep linked route whose content/API exists only after browser rendering | H2 fetch-crawler false success |
| Icon-only/destructive/menuitem/history navigation and async disclosure interactions across three stacks | H8 interaction mutation/state loss |
| Binary/FormData/GraphQL/error/range API plus repeated polling replay | H5 matcher gaps |
| First-load script attempting fetch, image, form, ping, worker, WebSocket, beacon, and navigation before SW control | H6 zero-egress boundary |
| Missing required asset with empty/partial discovery and resolved-by-refetch variants | M4 misleading completeness |
| Tainted canvas, form values, open shadow roots, adopted stylesheets, and closed-root diagnostics | Current live-state omissions |
| Launcher matrix: Python, PowerShell, static 404 host, root and deep link | M8 routing inconsistency |

`start-overlay-regression.mjs`, `deep-runtime-regression.mjs`, and `archive-safety-regression.mjs` inspect source strings; they can pass even if runtime behavior is broken. `golden-capture.mjs` validates artifact presence and selected substrings, not generator output. `browser-integration.mjs` validates a hand-authored 12-file fixture, not a ZIP produced by `sidepanel.js`, and its unknown-route check only requires non-empty root fallback (`tests/browser-integration.mjs:169-213`).

## Baseline Verification

Commands run unchanged on 2026-08-28:

```text
node --check background.js
exit 0, no output

node --check sidepanel.js
exit 0, no output

node tests/start-overlay-regression.mjs
PASS: start-overlay activation regression contract holds

node tests/deep-runtime-regression.mjs
PASS: deep Runtime.evaluate results are returned by value

node tests/archive-safety-regression.mjs
PASS: archive rewrite and safety regression contract holds

node tests/golden-capture.mjs tests/fixtures/offline-archive
Checked 12 files in tests\fixtures\offline-archive
PASS: offline archive invariants hold

node tests/browser-integration.mjs tests/fixtures/offline-archive
externalRequests: []
consoleErrors: []
exceptions: []
serviceWorkerControlled: true
rootText: "fixture offline archive"
routeText: "fixture offline archive"
savedPageText: "fixture saved card page"
screenshotHash: c92b27c7d48799b60524860eefc3987aae5255a8e5991a48ddba425a12f0a133
PASS: offline archive passed headless Chrome integration checks
```

The browser test rewrote `tests/artifacts/offline-archive.png` as its documented output. Passing establishes the current fixture baseline only; it does not invalidate the blind spots above.

## Recent Git History

The last five functional commits show rapid hardening around the current two-file design:

- `1d7251b` added captured-page route mapping, archive-specific cache names, and one saved `/card` integration assertion.
- `a71922f` added `returnByValue`, destructive offline safety rewriting/CSP, and source-regex regression checks.
- `b4b98e7` added local launchers.
- `28563f1` added start-overlay activation and a source-regex test.
- `69643b8` introduced most of the current capture/replay pipeline and fixture harness.

This history explains why behavior exists but has not yet been isolated behind stable data contracts. It supports incremental extraction, not a framework rewrite.

## Competitor Behavior And License Verification

Verified from official repositories and first-party documentation on 2026-08-28. No source was copied. “Complete,” “faithful,” and similar product claims were not treated as benchmark results.

| Project | Verified behavior relevant to openSave | Verified license | MIT openSave rule |
| --- | --- | --- | --- |
| SingleFile | Browser-rendered current-page capture into a self-contained document; scripts generally removed by default; not an HTTP evidence archive | AGPL-3.0-or-later in package metadata; AGPL license file | Behavioral reference only; high clean-room risk |
| WebScrapBook | Displayed DOM/source/selection capture, form/canvas/shadow/adopted-style state, batch and recursive linked-page capture, folder/HTZ/MAFF/single HTML | MPL-2.0 | Clean-room default; copied/modified files retain MPL obligations |
| ArchiveWeb.page | Interactive CDP traffic recording to WARC/WACZ with service-worker URL-rewritten replay | AGPL-3.0-or-later | Standards and behavior only; do not port capture/replay code |
| Browsertrix / Crawler | Automated browser crawl with explicit scope/budgets/behaviors; WARC/WACZ outputs and replay QA | AGPL-3.0 / AGPL-3.0-or-later | Behavior/benchmark reference only |
| ArchiveBox extension/server | Extension submits URLs and can create local screenshot/MHTML/SingleFile artifacts; server runs multiple independent extractors | MIT for extension and server; SingleFile integration remains separately AGPL | Low core copyright risk after dependency/provenance review |
| Monolith | One fetched document plus recursively embedded resources; no JS engine; explicit isolation CSP option | CC0-1.0 | Low copyright risk, but preserve provenance and review dependencies/IP |

Behavioral conclusion:

- SingleFile/WebScrapBook/Monolith primarily optimize document artifacts.
- ArchiveWeb.page/Browsertrix preserve browser traffic records and replay through an archive router.
- ArchiveBox is an ingestion/orchestration model with heterogeneous outputs.
- openSave’s differentiator should be an immutable capture graph feeding both a runnable static archive and evidence/developer writers. Static ZIP should not pretend to be raw evidence.

Primary sources:

- SingleFile: <https://github.com/gildas-lormeau/SingleFile>, <https://github.com/gildas-lormeau/SingleFile/blob/master/LICENSE>, <https://github.com/gildas-lormeau/SingleFile/blob/master/package.json>
- WebScrapBook: <https://github.com/danny0838/webscrapbook>, <https://github.com/danny0838/webscrapbook/blob/main/LICENSE.txt>, <https://github.com/danny0838/webscrapbook/wiki/Scheme>
- ArchiveWeb.page: <https://github.com/webrecorder/archiveweb.page>, <https://github.com/webrecorder/archiveweb.page/blob/main/LICENSE.md>, <https://archiveweb.page/en/usage/capture/>
- Browsertrix: <https://github.com/webrecorder/browsertrix>, <https://github.com/webrecorder/browsertrix-crawler>, <https://crawler.docs.browsertrix.com/user-guide/crawl-scope/>, <https://crawler.docs.browsertrix.com/user-guide/outputs/>
- ArchiveBox: <https://github.com/ArchiveBox/archivebox-browser-extension>, <https://github.com/ArchiveBox/archivebox-browser-extension/blob/main/LICENSE>, <https://github.com/ArchiveBox/ArchiveBox>
- Monolith: <https://github.com/Y2Z/monolith>, <https://github.com/Y2Z/monolith/blob/master/LICENSE>
- WARC/WACZ: <https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/>, <https://specs.webrecorder.net/wacz/1.1.1/>
- Chrome MV3 lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome debugger/targets: <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- CDP Network: <https://chromedevtools.github.io/devtools-protocol/tot/Network/>
- Service-worker registration/scope: <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register>

## Ranked Top Five

These are risk-reduction priorities, not permission to skip dependency order:

1. **Build the controlled benchmark corpus (Session 01).** Current tests cannot quantify body loss, memory, replay fulfillment, or heuristic safety.
2. **Introduce the provenance-aware capture graph (Session 02).** This resolves the most damaging evidence collapse and gives every later subsystem stable IDs.
3. **Persist bodies and mission state incrementally (Session 03).** This removes the practical scale/recovery ceiling before adding outputs.
4. **Replace broad URL rewriting with typed references (Session 05, after Session 04’s live-state contract).** Current transformations can corrupt application semantics and destroy evidence.
5. **Make replay mount-aware, chronological, and auditable (Session 07, after rendered crawl in Session 06).** Root-only routing, first-match APIs, application service workers, and first-load isolation need one replay contract.

## Session Disposition

Execute in numeric dependency order unless the note says otherwise.

| Session | Decision | Required revision or reason |
| --- | --- | --- |
| 01 Benchmark corpus | **Continue** | Add burst-body, subpath, competing SW, generator-to-replay, interaction mutation, and peak-memory fixtures named above. |
| 02 Capture graph | **Continue, revise** | Include original/normalized URL, headers, redirect chain, target/frame, body state/reason, refetch provenance, immutable blobs, and transformation evidence. Do not preserve first-wins URL semantics. |
| 03 Durable storage | **Continue, revise** | Include side-panel/export mission state, debugger-detach terminal states, bounded body-read queue, and cleanup after abandoned downloads. Chrome debugger keepalive is not persistence. |
| 04 Live DOM state | **Continue** | Make live snapshots derived checkpoints linked to response evidence; include route/frame and redaction status. |
| 05 Resource parser | **Continue, revise** | Make mount/base strategy part of resolver output; explicitly eliminate broad JS literal rewriting and test cross-origin semantic URLs. |
| 06 Rendered crawler | **Continue, revise** | Split policy/planner from browser executor within the session; keep existing fetch crawler as labeled fallback. Add navigation/state rollback and no-brand-denylist gates. |
| 07 Hermetic replay | **Continue, revise** | Add mount namespace, first-load threat model, captured-service-worker policy, per-archive cache ownership, direct-deep-link contract, and original-header limitations. |
| 08 Validator | **Continue, revise** | Validate generated output, not only hand-authored fixture; classify capture vs transform vs replay failures and include launcher/subpath matrix. |
| 09 Browser state | **Continue** | Depends on privacy schema; inventory service-worker registrations but do not replay publisher workers by default. |
| 10 API contracts | **Continue** | Start only after graph preserves all statuses/headers/variants; current `apiSnapshots` are insufficient evidence. |
| 11 Developer assets | **Continue** | Consume immutable graph and live checkpoints; no capture-core scanning. |
| 12 Source-map graph | **Continue** | Current source-map regex is discovery only; preserve authorization and default exclusion. |
| 13 Standard archive | **Continue, revise** | Require durable streaming and complete HTTP metadata first; keep AGPL implementation quarantine/provenance log explicit. |
| 14 Project export | **Split** | Deliver neutral developer pack first. Move optional scaffold to a later go/no-go sub-session after three pilots, as its own acceptance gate already implies. |
| 15 Settings/Developer Mode | **Continue, pull partially forward only when needed** | A minimal internal feature-flag/settings schema may precede UI; do not expose unavailable outputs. |
| 16 User status/logs | **Continue, revise** | Typed diagnostics should originate in Sessions 02/03/07; UI work consumes them. Never use URL presence to erase failure provenance. |
| 17 Privacy scanner | **Continue, pull threat model forward** | Full UI can wait, but secret classification/redaction contracts must influence S02/S03/S09/S10. Scan refetch credentials and response bodies. |
| 18 Optimization | **Continue** | Only after immutable content hashes, durable storage, and validator exist. Complete profile remains the evidence-preserving baseline. |
| 19 Single HTML | **Continue** | Independent writer over graph/live state; never fork capture. Preserve clean-room log for AGPL/GPL references. |
| 20 Incremental capture | **Continue** | Requires capture lineage, hashes, state compatibility, and durable storage; otherwise delete rather than URL-reuse. |
| 21 Capture diff | **Continue** | Requires validated graph versions and explicit volatile policy. |
| 22 Repair assistant | **Continue, revise** | Limit automatic repairs to versioned writer/replay transforms; never mutate evidence. Keep hard loop/version limits. |

No entire session should be deleted now. Session 14’s scaffold portion is the only work that should be split because it has a separate market-validation gate and is not required for the durable developer-pack contract.
