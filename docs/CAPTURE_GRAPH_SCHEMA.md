# Capture Graph Schema v1

The capture graph is openSave's metadata source of truth for capture evidence. Its schema version is independent from the static ZIP archive version. Session 03 persists graph snapshots and body references in IndexedDB while capture runs.

## Envelope

```text
schemaName: opensave-capture-graph
schemaVersion: 1
minimumReaderVersion: 1
createdAt: number
nextIds: object
missions: CaptureMission[]
targets: TargetRecord[]
requests: RequestRecord[]
responses: ResponseRecord[]
bodies: BodyRecord[]
documents: DocumentRecord[]
dependencyEdges: DependencyEdge[]
apiExchanges: ApiExchangeRecord[]
derivedArtifacts: DerivedArtifactRecord[]
diagnostics: DiagnosticRecord[]
```

Every record has a stable mission-local `id`, `missionId`, `provenance`, and `evidenceRefs`. IDs are never derived from a URL. Body IDs are derived from the SHA-256 hash of decoded bytes.

## Provenance

- `observed`: CDP events or bytes exposed by a Chrome protocol domain during the mission.
- `refetched`: a later request initiated by openSave rather than delivered through CDP.
- `derived`: deterministic output produced from named evidence, including live DOM serialization and rewritten files.
- `inferred`: a heuristic conclusion or diagnostic.
- `user-supplied`: mission policy, capture mode, scenario, or label supplied by the user.

Refetched records never fill an observed response's body slot. A compatibility writer can select refetched evidence for an archive path, but the report retains separate counts and evidence IDs.

## Records

### Capture Mission

Stores mission type, capture mode, state, source tab/URL, and start/completion timestamps.

### Target

Stores page, frame, worker, shared worker, or service-worker identity, CDP target/session IDs, parent target, frame ID, source URL, and attachment timestamp.

### Request

Stores method, original and normalized URL, headers, request body, request body SHA-256, CDP request ID, source target/frame, sequence, timestamps, initiator, and redirect predecessor/successor IDs. Missing request bodies remain `null`; an explicitly empty body is hashed as empty bytes.

### Response

Stores request ID, original and normalized URL, status, status text, headers, MIME type, protocol, resource type, source target/frame, timestamps, cache/service-worker flags, encoded size, body state, body ID, content hash, decoded size, failure reason, and redirect successor ID.

### Body

Stores an immutable body reference, original Base64 flag, decoded byte size, SHA-256 content hash, media-type hint, integrity state, linked response IDs, provenance-bearing acquisition paths, IndexedDB storage key, and chunk count. Durable records set inline `body` to `null`. Identical decoded bytes share one content blob even when URLs, methods, requests, responses, or acquisition provenance differ; each acquisition retains its own provenance and evidence references.

### Document

Stores page/document identity, URL, target, selected response or body, document kind, and capture time. Derived live documents also carry the optional additive `snapshotVersion` and aggregate `stateSummary`; sensitive values and canvas/blob bytes stay in the derived body rather than metadata. A live DOM serialization does not replace the original document response.

### Dependency Edge / ResourceReference

Stores the Session 05 `ResourceReference` contract: owner evidence artifact, target evidence when resolved, syntax kind, raw value, resolved and normalized URL, byte range and/or DOM location, role, rewrite policy, and disposition. HTML, responsive-image, CSS, SVG, and static-module adapters emit the same shape. Parser failures are isolated as typed diagnostics rather than aborting the mission.

### API Exchange

Links one request to one response and records resource type/classification. Repeated polling, non-2xx responses, and request variants remain separate records. The V1 replay adapter intentionally selects only the first successful exchange for each legacy method/URL/body key.

### Derived Artifact

Stores artifact type, transform name/version, input evidence IDs, output body ID, URL, and timestamp. Rewriters receive compatibility clones and create a new artifact/body; they never mutate graph evidence.

Session 05 uses transform version 2 for typed resource rewrites. Original response/live-snapshot bodies remain immutable evidence; localized HTML/CSS/SVG/JavaScript bytes are separate derived bodies.

### Diagnostic

Stores code, severity, phase, message, evidence IDs, occurrence count, timestamp, and truncation state. Legacy report arrays can remain capped while graph diagnostics retain every occurrence.

## Compatibility Adapters

`projectV1Bodies` reproduces the current first-completed-body-per-normalized-URL behavior and `preserveUrl` promotion for Fetch/XHR. `projectV1ApiSnapshots` reproduces the current first successful method/normalized-URL/request-body selection. Both return mutable clones so the V1 writer cannot modify graph records.

`projectReport` preserves the legacy report and adds `captureGraph` counts, provenance totals, redirect links, refetched resources, and evidence-linked diagnostics. The static ZIP format remains version 1 and does not gain a graph member in this migration step.

The Session 02 parity shadows were removed after the benchmark archive/report gate passed. Writer inputs are projected from the graph and hydrated by storage key in the side panel; body bytes are not copied through the runtime message.

## Migration Rules

1. Readers reject an unknown `schemaName`, a newer major `schemaVersion`, or a graph whose `minimumReaderVersion` exceeds their supported version.
2. Additive optional fields do not require a schema-version increment. Readers preserve unknown fields when round-tripping metadata.
3. A breaking field or identity change increments `schemaVersion` and requires an explicit metadata migration.
4. Migrations may rewrite metadata and references but never body bytes or content hashes.
5. Missing historical facts remain `null` or receive an `inferred` record with confidence/evidence; migrations do not fabricate `observed` facts.
6. Archive format migrations and capture graph migrations are independent.

## Session 02 Gate

Durable storage must not begin until unit tests preserve variants, redirects, aliases, content-hash deduplication, provenance, and V1 adapter parity, and the benchmark corpus passes archive/replay/report checks without lower completeness.

This gate passed before Session 03. Durable storage lifecycle and backend details are documented in `docs/CAPTURE_STORAGE.md`.

## Session 04 Live State

`live-dom-state.js` creates snapshot version 1 before Quick capture reloads and after Deep scenario/exploration stages. It normalizes safe form and disclosure properties, embeds open shadow roots as inert templates, materializes adopted/CSSOM rules, and embeds bounded canvas/blob fallbacks. The offline bootstrap restores templates as open shadow roots. Closed roots, tainted canvases, inaccessible adopted sheets, and size-limit omissions produce evidence-linked diagnostics.
