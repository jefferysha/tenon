# Technical design

## Boundaries

```text
Codex JSONL
  -> codex-skill-executor-v2 event decoder
  -> StageArtifactRuntime observe/publish/reconcile
  -> durable ArtifactService state + blobs + events + receipts
  -> runtime catalog/consume/validator
  -> server snapshot/catalog/read/events
  -> dashboard catalog and preview
CLI/server run entry
  -> shared production runtime factory
```

The ArtifactService remains the source of truth. Runtime input receives bounded metadata and exact refs; it never receives an unbounded directory dump. UI reads use `consumer: ui` and never emit execution receipts.

## Scan policy

Move ignored system directories into one shared policy used by snapshot, reconcile and tool observations. Defaults include `.git`, `.pipeline-artifacts`, `.tenon-artifacts`, and `.orchestration-v2`; callers may extend the list for workspace-specific generated directories. A path is eligible for managed observation only after normalization under `change_dir`.

The Codex adapter will decode a small canonical event shape from all supported JSONL variants. It records event type counts and a bounded sample in diagnostics/evidence. A completion event with a validated path calls `observePath`; a completion event without a path does not claim managed provenance. End-of-stage reconcile remains the durable fallback for unclassified file changes.

## Durable pinning and visibility

Extend `ArtifactAttempt` with a persisted `pinnedVersions` map. `beginAttempt` snapshots visible deliverable versions before the stage runs. `catalog({ pinned: true })` filters against that map; legacy attempts without the map keep current behavior. Extract one `visibleToAttempt(state, attempt, version)` helper and use it in both catalog and read. Unknown-provenance versions use observed-event hints only for backward compatibility.

## Update state and checks

Extend catalog entries with `pendingUpdate`. `consumed && newer` is pending while an attempt is running and becomes `affected` only after the attempt completes. Register checkers through `openArtifactService` options and provide conservative built-ins: JSON parsing returns passed/failed; unsupported media returns `not-applicable`. Every result keeps exact artifact/version and checker/version.

## Production entry

Create one factory around `createExecutionRuntimeV2` and `createCodexRuntimeExecutor`. It resolves a change directory, creates the ledger and durable artifact service, supplies validator/checkers, and exposes a bounded run handle. Add a CLI `orchestration run` command and a protected server run route that call this factory. Existing `start` remains a ledger control command; it does not silently change semantics.

## Compatibility and rollback

- Existing artifact state without `pinnedVersions` or `pendingUpdate` remains readable.
- Unknown legacy versions remain visible only according to observed-event compatibility rules.
- If tool event decoding fails, reconcile still captures end-of-stage changes and emits a diagnostic.
- The run route can be disabled independently; CLI/server control and read-only artifact routes remain available.
