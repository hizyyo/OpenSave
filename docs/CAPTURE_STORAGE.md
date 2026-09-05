# Durable Capture Storage

Session 03 moves capture bodies and mission recovery state into `opensave-capture-storage`, an IndexedDB database shared by the MV3 service worker and side panel.

## Backend Decision

IndexedDB is the selected backend. Chrome 125+ exposes it in both extension contexts, stores `ArrayBuffer` chunks without Base64, supports transactional metadata/index updates, and provides indexed, idempotent mission cleanup. The local Chrome corpus verified access from the unpacked extension on Chrome 152.

OPFS was considered because its writable streams are useful for single large files. It was not selected because mission metadata, content-hash indexes, ownership, and recovery would still require IndexedDB, while commit and cleanup could not be atomic across both backends. IndexedDB chunk streams provide the required bounded reads with one transactional cleanup authority.

No permission was added. The manifest already grants `storage` and `unlimitedStorage`. The latter avoids ordinary extension quota eviction but does not guarantee free disk space, so the store still checks `navigator.storage.estimate()` and handles `QuotaExceededError` explicitly.

There is no small-capture in-memory fallback. The controlled Quick fixtures stayed complete and within a sub-second absolute range of the prior baseline, while retaining a second body path would restore the duplication and recovery ambiguity that this session removes.

## Interface

The interface is keyed by capture ID and SHA-256 content hash:

```text
createMission(capture)
saveMission(captureId, patch)
getMission(captureId)
beginBody(captureId, expectedSize) -> writer
writer.write(ArrayBuffer | Uint8Array)
writer.commit(contentHash, metadata) -> bodyRef
writer.abort(reason)
openBody(bodyRef) -> ReadableStream<Uint8Array>
readBody(bodyRef, mimeType) -> Blob
hasBody(contentHash)
retainBody(contentHash, captureId)
getQuotaStatus(requiredBytes)
recoverInterruptedMissions(reason)
cleanupTemporaryBodies(captureId)
cleanupMission(captureId)
cancelMission(captureId, reason)
```

Body chunks are 1 MiB by default. `BodyRecord.body` is `null` after persistence; `storageKey`, verified decoded `size`, and `contentHash` remain in the capture graph. Equal hashes share chunks while per-mission owner records prevent one mission's cleanup from deleting another mission's body.

## Mission Recovery

Mission records persist the graph, state, pending body jobs, cancellation request, source tab, and recovery reason. Startup changes non-terminal `capturing`, `capture-complete`, `exporting`, and `cancelling` records to `interrupted`, preserves committed evidence, and removes incomplete chunks.

Lifecycle behavior is explicit:

| Event | Metadata | Temporary chunks | Committed private bodies |
| --- | --- | --- | --- |
| Successful download | Mission deleted | Deleted | Deleted from extension storage |
| User cancellation | Mission marked, then deleted | Deleted | Deleted |
| Extension/worker reload | Marked `interrupted` and recoverable | Deleted | Retained for recovery |
| Source tab close/debugger detach | Marked `interrupted` and recoverable | Deleted | Retained for recovery |
| Export failure/side-panel close | Marked `export-failed` or `interrupted` | Deleted | Retained for retry or explicit deletion |
| Quota exhaustion | Marked `partial` and recoverable | Aborted write deleted | Previously committed bodies retained |
| User deletes mission | Mission deleted | Deleted | Deleted unless another mission owns the hash |

Raw authenticated bodies never leave local extension/archive storage. Internal copies are removed when the mission is deleted or its archive download succeeds.

## Memory Measurement

`node tests/memory-amplification.mjs` measures a 16 MiB payload. The Session 03 run observed:

- Base64 representation: 22,369,624 characters, `1.3333x` payload size.
- Simultaneously retained raw bytes, Base64, and final ZIP: `3.3333x` payload bytes before transient decoder/JSZip workspace.
- Blob conversion added one 16 MiB `ArrayBuffer` in the Node measurement.
- JSZip STORE generation added about 50.3 MiB of external/ArrayBuffer allocation for the 16 MiB input.

The exact V8 allocation split depends on string encoding and garbage collection, but the result confirms that Base64 plus whole-archive generation cannot be treated as payload-sized memory.

The durable path bounds CDP body reads to four concurrent jobs and writes decoded bytes in chunks. The background-to-side-panel message contains graph metadata and storage keys, not site bodies. The side panel reads each unique body once as a Blob. JSZip receives Blob inputs with `streamFiles: true`; JSZip 3.10.1 and `chrome.downloads.download` still require one final archive Blob, so archive generation is not claimed to be fully streaming.

## Verification Limits

`tests/capture-storage.mjs` commits and cleans up a synthetic 201 MiB body, above the previous 200 MiB per-resource ceiling, and covers interruption, cancellation, quota exhaustion, incomplete-write cleanup, shared-body ownership, missing bodies, and invalid commit size. The real-browser corpus validates the IndexedDB extension path, archive output, report parity, and replay behavior across independent application architectures.
