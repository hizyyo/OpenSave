# Session 03: Durable Capture Storage

Make large captures survive MV3 service-worker suspension and avoid holding the entire site in memory.

## Objective

Persist mission metadata and response bodies incrementally in extension storage while capture is running. Prefer OPFS or IndexedDB based on measured browser support and streaming needs.

## Required Work

1. Measure current memory amplification for strings, Base64, Blob conversion, and JSZip generation.
2. Define a storage interface keyed by capture ID and content hash.
3. Write bodies as they arrive instead of retaining them all in global maps.
4. Persist mission state, pending work, cancellation, and recovery metadata.
5. Make cleanup explicit for success, cancellation, extension reload, tab close, and failed export.
6. Add quota checks and actionable failure messages.
7. Preserve the existing in-memory path only as a small-capture fallback if justified by benchmarks.

## Constraints

- No unbounded Base64 concatenation.
- No silent data eviction.
- Do not request new permissions without explaining why existing storage permissions are insufficient.
- Raw authenticated bodies remain local and are deleted when the user deletes the mission.

## Acceptance Criteria

- A synthetic capture larger than the old practical memory ceiling completes.
- Restarting or suspending the extension does not corrupt persisted mission metadata.
- Cancellation removes temporary data.
- Export reads bodies incrementally where the ZIP library allows it.
- Quota exhaustion produces a clear diagnostic and a recoverable partial mission.
- Benchmark Quick mode does not regress materially for small pages.

## Stop/Go

Stop if the chosen storage backend cannot provide reliable cleanup or body streaming. Document alternatives before continuing.

## Verification

Add storage lifecycle, interruption, quota, cleanup, duplicate-body, and large-fixture tests.
