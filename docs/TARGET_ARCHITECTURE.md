# openSave Target Architecture

> Historical broad architecture from the ultra review. The active MVP scope is `docs/PRODUCT_ROADMAP.md`; developer extraction, browser-state restoration, WARC/WACZ, reconstruction, single-HTML, incremental capture, diff, and repair features described below are not scheduled.

## Decision

Keep the current no-build Manifest V3 extension and its process topology:

```text
Side panel / UI
    |
    | mission commands, progress, export requests
    v
Extension service worker
    |
    | Chrome DevTools Protocol
    v
Tab, frames, workers, network and browser storage
```

Do not treat `background.js` and `sidepanel.js` as the domain architecture. They are current deployment entry points. Introduce the boundaries below as plain browser-compatible modules or clearly delimited sections first. Split files when contracts stabilize and tests prove parity. A framework migration or build system is not required by current evidence.

## Architectural Invariants

1. Observed bytes and metadata are immutable.
2. `observed`, `refetched`, `derived`, `inferred`, and `user-supplied` are distinct provenance classes.
3. URL is not request identity, response identity, or body identity.
4. A failure cannot be erased because another source later produced bytes for the same URL.
5. Capture, transformation, replay, extraction, and validation consume versioned records through narrow interfaces.
6. Bodies are content-addressed and stored once; aliases and exchanges remain distinct.
7. Every derived artifact cites evidence IDs and the transform version that created it.
8. Hermetic replay fails closed and records every miss; it never silently reaches the live origin.
9. Normal archives are sanitized by default. Private state is explicit, local, and separately labeled.
10. Static ZIP remains a supported output. New outputs are writers over one capture model.
11. No core hostname, product-brand, framework, or site-specific branch is allowed.
12. The extension stays no-build until a selected browser dependency cannot be safely vendored and measured evidence justifies a reproducible build.

## Canonical Flow

```text
CaptureMission
  -> CaptureGraph metadata
  -> BodyStore immutable blobs
  -> LiveSnapshot checkpoints
  -> ResourceReference discovery
  -> CrawlPlan and rendered page evidence
  -> ArchiveWriter derived artifacts
  -> ReplayRuntime request decisions
  -> Validator observations
  -> DeveloperExtractor derived outputs
```

No arrow points backward into immutable evidence. Repair, optimization, and alternative output create new derived artifact versions.

## 1. Capture Mission Lifecycle

### Responsibility

Own one user-intent operation from creation through capture, export, validation, completion, cancellation, or recoverable failure. Replace global operation variables as the source of truth.

### Required Record

```text
CaptureMission {
  schemaVersion
  id
  parentMissionId?
  requestedMode
  effectivePolicyVersion
  sourceTabId
  sourceUrl
  createdAt
  updatedAt
  state
  phase
  budgets
  counters
  cancellationRequestedAt?
  terminalReason?
  partialExportAvailable
}
```

Mission states must include at least `created`, `attaching`, `capturing`, `quiescing`, `transforming`, `writing`, `validating`, `completed`, `partial`, `failed`, and `cancelled`. Transitions are persisted before destructive cleanup.

### Interface

```text
createMission(input) -> missionId
transitionMission(missionId, expectedState, nextState, details)
requestCancellation(missionId, reason)
getMission(missionId)
listRecoverableMissions()
finalizeMission(missionId, result)
deleteMission(missionId)
```

### Ownership And Lifetime

- The extension service worker owns CDP attachment and capture transitions.
- The side panel observes state and requests actions; closing it must not define mission cancellation.
- Active debugger attachment keeps Chrome 125+ extension workers alive, but mission state is still persisted for detach, reload, crash, post-capture export, and explicit recovery.
- Cancellation is cooperative and checked by body reads, crawl steps, transforms, writers, and validator.

### Compatibility

The existing one-operation-at-a-time policy can remain initially. Represent it as a mission scheduler constraint rather than a global-state assumption. Quick, Deep, recording, and picker become mission types or subflows with typed terminal states.

### Session Ownership

Sessions 02 and 03 define the durable record; Sessions 06, 08, and 16 consume cancellation/progress.

## 2. Capture Graph And Body Store

### Responsibility

Represent what Chrome observed, what openSave later refetched, and how all artifacts relate. Store body bytes durably and independently from metadata.

### Graph Records

```text
TargetRecord: tab, frame, worker, service worker, execution context
RequestRecord: method, original URL, normalized URL, headers, body ref/hash,
  timestamps, initiator, target/frame, redirect predecessor, sequence
ResponseRecord: request ID, status, status text, headers, MIME, protocol,
  timestamps, cache/SW source, encoded size, body state/ref, failure reason
BodyRecord: content hash, byte size, storage key, media type hint, integrity state
DocumentRecord: route/page identity, response ID, live checkpoint IDs
ApiExchangeRecord: request ID, response ID, classification only
DependencyEdge: owner artifact/checkpoint, target identity, syntax/role, source
DiagnosticRecord: code, severity, phase, evidence IDs, occurrence count, truncation
DerivedArtifactRecord: writer/transform/version, input evidence IDs, body ref
```

### Provenance

Every record has exactly one provenance class:

- `observed`: emitted by CDP or browser storage protocol during the mission.
- `refetched`: a later request initiated by openSave.
- `derived`: deterministic transformation of named evidence.
- `inferred`: heuristic conclusion with confidence and evidence IDs.
- `user-supplied`: scenario, policy, labels, or authorization provided by the user.

Refetches are first-class request/response records. They never fill the body slot of an observed response. A writer may choose a refetched body through explicit policy and must record that choice.

### Body Store Interface

```text
beginBody(missionId, expectedSize?) -> bodyWriter
bodyWriter.write(bytes)
bodyWriter.commit(hash, size) -> bodyRef
bodyWriter.abort(reason)
openBody(bodyRef) -> readable stream or bounded chunks
hasBody(hash)
retainBody(hash, ownerId)
releaseBody(hash, ownerId)
getQuotaStatus()
cleanupMission(missionId)
```

Select OPFS or IndexedDB only after Session 03 measures support, streaming, transaction, quota, and cleanup behavior. Metadata and bodies may use different stores behind one interface.

### Body Read Scheduler

`Network.loadingFinished` enqueues a body-read job. The scheduler applies measured concurrency/backpressure, persists state (`pending`, `reading`, `stored`, `unavailable`), and does not permit detach/finalization while eligible jobs are unresolved unless the mission becomes explicitly partial. Timeouts produce per-response reason codes.

### Immutability

- Never rewrite `BodyRecord` content.
- Text decoding is a derived view.
- Rewritten HTML/CSS/JS/glTF is a new body and `DerivedArtifactRecord`.
- Content-hash deduplication shares bytes, not request/response identity.

### Versioning

Schema versions are independent from archive format versions. Readers reject unsupported major versions and preserve unknown fields where round-tripping is required. Migrations operate on metadata, not raw bytes.

### Session Ownership

Session 02 defines graph/schema/adapters. Session 03 defines durable storage. Sessions 10-14 and 18-21 consume it without adding parallel evidence maps.

## 3. Live DOM And State Snapshots

### Responsibility

Capture browser-visible state not represented by response bytes and attach it to a document, route, frame, and interaction checkpoint.

### Snapshot Shape

```text
LiveSnapshot {
  id
  missionId
  documentId
  targetId
  routeStateId
  checkpointKind
  capturedAt
  serializedDomBodyRef
  formStateRef?
  shadowRootRefs[]
  adoptedStylesheetRefs[]
  canvasRefs[]
  mediaStateRef?
  scrollStateRef?
  unsupported[]
  redactions[]
}
```

### Rules

- Original document response and live snapshot remain separate.
- The entry HTML writer explicitly selects a live snapshot, original response, or composite transform and records the choice.
- Form/password/payment/file/private state is redacted before persistence according to policy.
- Open shadow roots and adopted styles are supported; closed roots are reported, not claimed.
- Canvas failures include tainted/context-lost/size reason codes.
- Blob URLs are materialized as evidence only when browser access permits and ownership is known.
- Interaction checkpoints include expected route/DOM/state fingerprints; no bare click count implies state coverage.

### Session Ownership

Session 04 owns the contract. Sessions 06, 08, 09, 11, 14, and 21 consume checkpoints.

## 4. Resource Discovery And Typed Rewriting

### Responsibility

Discover and transform URL-bearing syntax without broad text replacement. Resolve all references through one URL/mount policy.

### Resource Reference

```text
ResourceReference {
  id
  ownerArtifactId
  ownerBodyRef
  syntaxKind
  role
  rawValue
  resolvedOriginalUrl?
  sourceLocation
  targetRequestOrAliasIds[]
  disposition
  diagnosticIds[]
}
```

Syntax kinds include HTML URL attributes, `srcset`, inline/style CSS, CSS URL/import/image-set/source-map, SVG href/paint/filter/mask, import maps, static ES imports, dynamic import with static literal, worker/importScripts/new URL, source-map comments, and glTF URI fields.

### Resolver Contract

```text
resolveReference(reference, ownerBaseUrl, captureGraph, replayMount) -> {
  originalUrl?
  selectedEvidenceId?
  replayUrl?
  disposition: localize | preserve-for-runtime | block | unresolved
  reasonCode
}
```

The replay URL is mount-relative, not hard-coded origin-root. The resolver must distinguish original URL identity from archive storage path. Code that semantically needs source origin may require replay-runtime URL virtualization rather than literal replacement.

### Transform Rules

- Rewrite only parser-confirmed URL nodes.
- Preserve original bytes and emit source maps/transform ledgers where feasible.
- Missing executable references are blocked with diagnostics.
- Missing non-executable references use typed placeholders only when policy names them; never silently substitute `data:,`.
- CSP and SRI changes are explicit transforms with reason/evidence.
- Framework hydration is handled through generic document-stream/live-snapshot composition, not TanStack marker branches in core.

### Dependency Policy

Prefer browser-native parsers where correct. A permissively licensed vendored parser is acceptable with version/license/provenance. Add a build system only if a selected parser cannot be safely consumed as a browser-ready artifact and the maintenance/size evidence justifies it.

### Session Ownership

Session 05 owns parsing/resolution. Session 19 reuses the same references for single-file output.

## 5. Crawl Planner

### Responsibility

Separate candidate discovery and safety decisions from browser navigation/execution.

### Route Candidate

```text
RouteCandidate {
  id
  originalUrl
  normalizedRouteIdentity
  discoveredFromEvidenceId
  discoveryKind
  priority
  scopeDecision
  safetyDecision
  state
  redirectAliasIds[]
  diagnostics[]
}
```

### Planner Interface

```text
discoverCandidates(checkpointOrArtifact) -> candidates
decideScope(candidate, policy) -> decision with reason
nextCandidate(graph, budgets) -> candidate?
recordVisit(candidate, result)
requestStop(reason)
```

### Browser Executor

Visits accepted routes in an isolated target when possible, preserves authorized session context, waits for bounded network and DOM stabilization, records every request/response and live checkpoint, and closes/restores state. It never follows cross-origin routes by default.

### Interaction Safety

- Replace English/Russian danger and external-brand regexes with structural policy plus observable effects.
- Default exploration is disclosure/state controls with bounded before/after checkpoints.
- Any route/history/storage/network mutation is recorded and evaluated before continuing.
- Form submit, payment, wallet, account, deletion, logout, and unknown mutation actions remain prohibited.
- Optional recipes are declarative, disabled by default, provenance-labeled, and outside core.
- Generic heuristics require controlled tests across at least three unrelated stacks.

### Fetch Fallback

The current side-panel HTML fetch remains available as a lower-fidelity discovery/capture strategy. Its resulting requests/responses are `refetched`, and page records are marked `unrendered`. It is never counted as equivalent to a browser-rendered checkpoint.

### Session Ownership

Session 06 owns planner/executor. Sessions 01 and 08 define measurement and validation.

## 6. Archive Writers

### Responsibility

Turn graph evidence and snapshots into derived outputs without mutating inputs.

### Writer Interface

```text
planArchive(missionId, outputPolicy) -> file plan, estimates, diagnostics
writeArchive(plan, bodyStore, sink, cancellation) -> artifact manifest
```

Every output file manifest entry contains path, hash, size, media type, derivation, evidence IDs, and privacy/rights status.

### Writers

- **Static ZIP writer:** existing runnable archive contract, with versioned compatibility adapter during migration.
- **Selection writer:** consumes the same graph/reference pipeline scoped to a checkpoint subtree.
- **WARC/WACZ writer:** additive standards output from observed/refetched HTTP records; never reconstructed from rewritten files.
- **Single HTML writer:** content-oriented output using live snapshots and typed references.
- **Developer-pack writer:** neutral evidence/derived artifact package.

### Static ZIP V2 Requirements

- Mount-relative runtime URLs.
- Per-archive replay namespace and cache ownership.
- Original and derived provenance in manifest/report.
- Replay miss ledger and validation result.
- No application service worker registration unless explicitly supported by policy.
- Launcher/server capability recorded.
- Stream or bounded-chunk reads from body store; do not materialize every source representation simultaneously.

### Compatibility

Maintain V1 output until benchmark parity is reached. The adapter can reproduce current root-mounted behavior from the graph. Do not continue writing new features directly against `capturedBodies`/`apiSnapshots` arrays.

### Session Ownership

Sessions 05, 07, 13, 14, 18, and 19 own writer capabilities. Session 03 determines sink/stream constraints.

## 7. Replay Runtime

### Responsibility

Map replay-origin requests to recorded responses or explicit misses without live-origin egress.

### Replay Package

```text
ReplayManifest {
  schemaVersion
  archiveId
  mountPath
  routes[]
  resources[]
  exchanges[]
  stateCheckpoints[]
  unsupportedPolicies[]
}
```

### Request Matcher

Identity includes method, canonical original URL, selected headers, content type, body hash, initiator/page state where available, and chronological sequence. Matching returns one of:

- exact recorded response
- explicit normalized match with named rule
- ambiguous match error
- unsupported protocol response
- missing evidence response
- blocked mutation response

Repeated identical requests replay in recorded order within a page/state context. A selected fallback never masquerades as exact.

### Routing And Mounts

- Source route identity is independent from hosting mount.
- All generated URLs resolve relative to configured mount.
- Direct navigation under the mount maps captured rendered pages before SPA fallback.
- Unknown routes produce an explicit policy decision, not unconditional root success.
- Two archives can coexist on one origin without sharing/deleting caches or registrations.

### Service-Worker Policy

The replay bootstrap owns the replay scope. Captured application service-worker registration is disabled or virtualized by default before application code executes. Original registrations remain evidence in the graph/state capsule. Enabling publisher worker behavior is an advanced, validated mode with isolated scope and no ability to replace replay control.

### Hermeticity

- CSP is defense in depth.
- Service-worker/request interception is the enforcement boundary once controlled.
- First-load behavior is explicitly tested and launchers may use a bootstrap/control reload before executing application modules.
- Fetch, XHR, beacon, WebSocket, SSE, workers, navigation, frames, media, CSS, images, forms, pings, range requests, and browser preload are covered by policy/tests.
- Every miss appends a typed record to `replay-misses.json` or an equivalent durable ledger.

### Session Ownership

Session 07 owns runtime/matcher. Sessions 08 and 22 validate and repair derived runtime artifacts.

## 8. Validator

### Responsibility

Validate a generated artifact, not source-code substrings or only a hand-authored fixture.

### Validator Inputs

- Artifact manifest and hashes.
- Capture graph/routes/checkpoints.
- Replay manifest and expected request examples.
- Privacy/rights policy.
- Validation budgets and mount/server matrix.

### Checks

```text
structure and integrity
service-worker/bootstrap control
root and direct deep-link routing
captured-page identity versus SPA fallback
request fulfillment and miss reasons
zero external egress from first load onward
console/runtime errors
DOM checkpoint assertions
visual comparisons with volatility masks
saved API variants and chronology
publisher service-worker attempts
root/subpath and launcher/server behavior
```

### Result

`pass`, `partial`, `fail`, or `cancelled`, with separate classifications for capture miss, transform/rewrite defect, replay defect, privacy failure, unsupported browser feature, and validator infrastructure failure. Validation failure does not destroy or suppress download; the artifact and result are linked.

### Session Ownership

Session 01 builds controlled measurement infrastructure; Session 08 makes validation a product stage; Session 22 consumes typed failures.

## 9. Developer Extractors

### Responsibility

Produce analysis artifacts from immutable evidence without changing capture/replay.

### Extractor Interface

```text
analyze(graphReader, bodyReader, policy, cancellation) -> {
  artifacts[]
  claims[]
  diagnostics[]
}
```

Every claim contains classification (`observed`, `derived`, `inferred`, `user-supplied`), evidence IDs, confidence where inferred, extractor/version, and privacy/rights status.

### Extractors

- API/HAR/OpenAPI candidate.
- SVG/font/CSS/design-token inventory.
- Source-map/module graph.
- Route/state/journey inventory.
- Capture comparison/diff.
- Neutral project/reconstruction specification.

Extractors cannot import replay-runtime internal state as evidence. They consume the graph and validation outputs through versioned readers.

### Session Ownership

Sessions 10-12, 14, and 21.

## Diagnostics Contract

Replace free-form/capped arrays as the primary model with typed records:

```text
Diagnostic {
  code
  phase
  severity
  userCategory
  messageParameters
  evidenceIds[]
  occurrences
  firstSeenAt
  lastSeenAt
  actionable
  recommendedActionCode?
}
```

UI may cap displayed rows, but persisted counts and truncation are explicit. Resolution adds a linked resolution record; it never deletes the original diagnostic.

## Security, Privacy, And Rights Boundaries

- Authenticated refetch is disabled or disclosed by policy and always provenance-labeled.
- Headers, URLs, bodies, browser state, reports, and developer artifacts pass local secret classification before shareable export.
- Sealed private artifacts are separate from sanitized normal output.
- Captured runnable scripts are untrusted content. Replay isolation is not a promise that the content itself is safe.
- Rights status follows every body/derived artifact.
- AGPL/GPL project source is behavior-only research. MPL source reuse requires an explicit file-level license decision. Maintain provenance for dependencies and independently implemented standards behavior.

## Migration Sequence

1. Session 01 captures current V1 behavior and failures as executable benchmarks.
2. Session 02 introduces graph records and adapters while V1 ZIP remains byte/behavior compatible where intentional.
3. Session 03 moves bodies/mission state behind durable interfaces and adds bounded body reads.
4. Session 04 adds live checkpoints without changing response evidence.
5. Session 05 makes resource references and transforms typed; V1 broad rewrite is retired after parity.
6. Session 06 adds planner/executor over graph and checkpoints.
7. Session 07 produces Replay V2 with mount/service-worker/matcher contracts.
8. Session 08 validates actual writer output and becomes the gate for later writers/extractors.

Physical file splitting should follow these boundaries, but no step requires converting the project to React, TypeScript, bundlers, or another extension framework.

## Architecture Gates

- No feature after Session 02 may add a new parallel evidence map keyed only by URL.
- No writer after Session 03 may require all body bytes in one service-worker message.
- No transform after Session 05 may rewrite arbitrary JavaScript strings.
- No crawl heuristic after Session 06 may use hostname/product-brand checks in core.
- No replay success after Session 07 may omit a miss reason.
- No output after Session 08 may be labeled validated unless generated artifact validation ran.
- WARC/WACZ and incremental output stop if durable streaming is unavailable.
- A build system proposal must include the measured limitation, selected dependency/license, bundle/reproducibility plan, and no-build alternative.
