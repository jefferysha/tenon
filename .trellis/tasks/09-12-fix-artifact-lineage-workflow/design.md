# Technical design

## Boundaries

The kernel owns artifact contracts and immutable identity types. Automation owns durable storage, observation, publication, catalog policy, consumption receipts, and V2 runtime integration. Server owns repository-scoped snapshot projection and HTTP query boundaries. Dashboard consumes server projections and catalog APIs; it never infers I/O by calling a model.

## Data flow

```text
executor/skill
  -> StageArtifactRuntime.observe/reconcile
  -> ArtifactService.observe (producer + immutable version + event)
  -> explicit publish(candidate|intermediate|deliverable)
  -> catalog(scope + dependency policy + budget)
  -> next-stage preparation (metadata first, fixed-version read on demand)
  -> ArtifactService.read (execution receipt)
  -> catalog consumed/affected projection + events(after)
  -> server snapshot/artifact routes -> Dashboard
```

`work_item_id` remains the ledger identity. `pipeline.stage_id` is the artifact stage identity. A resolver maps each work item to its containing pipeline stage, with a legacy fallback to work item id for old attempts. The mapping is persisted in the attempt and projected back to `artifactAttempts`.

## Runtime changes

1. Extend `StageArtifactRuntime` with producer-aware observation, explicit `consume()`/`consumeRef()` helpers, existing-version materialization for a new attempt, and a bounded `catalog()`/`events()` facade. Opening a runtime persists the attempt before any execution; `end()` reconciles and closes it.
2. Keep `origin: 'unknown'` only for attribution uncertainty. Stage-scoped observations always carry producer `{ workflowRunId, stageAttemptId, skillId? }`; external providers can explicitly pass `origin: 'external'` without a fabricated stage producer.
3. Make publish validate visibility and allow an existing immutable version to be adopted by the current attempt when the path/artifact is in scope. Adoption emits an idempotent observation/publication event for this attempt without creating a duplicate version.
4. Parse bounded `consumed` declarations from the executor envelope. Validate artifact URI/id/version and call `service.read(..., { consumer: 'execution', representation })` with max bytes. Invalid declarations are diagnostics and do not block unrelated valid outputs.
5. Update V2 runtime to pass pipeline stage identity and skill identity into StageArtifactRuntime. After executor completion, process consumption declarations before terminal reconciliation; catalog/evidence is then durable without driver-specific calls.

## Progressive disclosure

Add a catalog projection that returns bounded metadata, optional summaries/checks, and stable version refs. Add `events(after)` for reconnect. Input preparation receives dependency-stage catalog metadata and reads only selected exact versions within the existing input budget. Do not inject full files or build one tool schema per artifact. The executor may ask `artifact_runtime.catalog` and `artifact_runtime.consume` through the fixed boundary.

## Server/UI

Add an artifact service resolver to snapshot dependencies. During change projection, load latest attempts for the canonical workflow stage ids and emit `artifactAttempts`. The artifact route accepts a stage id and resolves the latest attempt only when the id is valid; it remains backward-compatible with explicit attempt ids. Dashboard displays the catalog's available stage, version, disposition, quality, consumed and affected fields, while existing configured Stage I/O remains a fallback/advanced contract view.

## Persistence and recovery

Artifact Service continues to use atomic state replacement and the existing lock. Add tests for restart, event cursor, duplicate observation/read, corrupt state diagnostics, and concurrent attempts. Catalog digest includes version, disposition, producer, and status fields so metadata changes trigger updates even when bytes are unchanged. Events are append-only and idempotent; consumers checkpoint `after` externally.

## Compatibility and rollout

- Accept old states where producer is missing; catalog marks `availableFromStage` unknown and does not invent a producer.
- Accept old attempts using work-item stage ids; new attempts use pipeline stage ids and include an identity mapping.
- Keep existing server route payloads additive and Dashboard optional fields backward-compatible.
- Keep explicit governed workflow artifact declarations separate from runtime artifacts.

## Rollback

The changes are additive. If runtime artifact integration fails, pass no artifact service to the executor and retain ledger execution. If catalog projection fails, omit the optional snapshot field and surface the artifact route error; do not block canonical workflow state reads. State schema remains version 1 with tolerant decoding; new fields are optional.
