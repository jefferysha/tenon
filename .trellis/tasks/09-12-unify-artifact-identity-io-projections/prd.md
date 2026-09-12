# 统一产物身份与 I/O 投影架构收敛

## Goal

让文档槽位、字段槽位和运行时产物共享一个可追踪的逻辑产物身份，同时保留三种视图各自的治理职责。开放 Skill 不需要在 workflow 编辑器中预先声明每一个文件，但运行前后必须能逐步得到稳定的输入引用、输出引用、版本和血缘。

## Confirmed repository facts

- Document registration is currently governed by canonical document kinds and paths in `packages/kernel/src/documents/` and `packages/kernel/src/state/document-ledger.ts`.
- Workflow fields are persisted in the legacy field state and projected by `packages/server/src/changeSnapshot.ts` and workflow modules.
- Runtime artifacts are persisted by `packages/automation/src/artifacts/service.ts`; the current identity helper is `artifactId = hash(path + mediaType)`.
- `StageArtifactRuntime` still discovers files with post-execution directory reconciliation. It now filters system directories and supports explicit observation/publication, but the declaration and reconciliation sources are not yet unified.
- The previous runtime follow-up task added pinning, visibility parity, pending updates, checker registration, and a shared production runtime factory. Those are compatibility constraints for this task, not a replacement for canonical identity.
- The dashboard currently consumes runtime catalog entries separately from document and workflow projections.

## Requirements

### R1. One canonical logical identity

Introduce a stable `ArtifactSubjectRef`/equivalent kernel contract with a namespace, logical subject id, projection kind, and exact version reference. A document slot, a field slot, and a runtime file may have different projections, but the same logical output must resolve to one subject and one version lineage.

The logical subject id must not be derived from the current path. Existing path-hash IDs remain readable through an explicit legacy mapping; new writes use the stable subject id.

### R2. Declaration-first submission

Create one host-owned artifact submission application boundary. It accepts model/executor declarations, governed document/field records, and runtime observations, then applies:

- declaration validation and producer authorization;
- subject/version resolution;
- immutable content storage;
- document/field/runtime projections;
- lineage and governance evidence;
- bounded diagnostics for rejected or undeclared outputs.

Explicit declarations and managed-tool observations are primary evidence. Reconciliation is a fallback and cross-check only.

### R3. Reconciliation semantics

Files discovered only by reconciliation are recorded as `intermediate` or `undeclared-candidate` and excluded from the default deliverable catalog. They remain inspectable for review and can be explicitly promoted after validation. Reconciliation must continue to ignore host/runtime state directories.

### R4. Rename and path independence

Rename or move must update source location metadata while retaining the logical subject id and version lineage. A path change alone must not create a new logical artifact. Ambiguous content matches fail closed and create a review diagnostic.

### R5. Workflow contract and progressive disclosure

Workflow definitions expose bounded logical input/output contracts and references, not a manually maintained list of every possible file. Before execution, the UI can show contract status (`declared`, `unknown`, `runtime-only`). During execution, the runtime publishes bounded catalog metadata, exact versions, checks, and event cursors. File bodies remain on-demand.

### R6. Backward compatibility

Old document ledgers, field state, artifact state, path-hash IDs, and existing read APIs remain readable. New projections are additive until a migration receipt proves equivalence. Canonical workflow state cannot be blocked by an optional runtime projection failure.

## Acceptance Criteria

- [ ] A document, field value, and runtime artifact representing the same logical output can be resolved to one subject id and version lineage; their projections do not render as three unrelated deliverables.
- [ ] New artifact registrations no longer derive identity from `path + mediaType`; a rename test preserves subject id, version, digest, and lineage while changing only source path metadata.
- [ ] Declaration-first execution records declared outputs as deliverable or candidate according to policy; reconcile-only files are intermediate/undeclared and absent from the default deliverable catalog.
- [ ] A declaration/reconcile mismatch produces bounded diagnostics and does not silently promote the undeclared file.
- [ ] Workflow creation and runtime execution expose the same logical refs; the UI can show bounded contract/status metadata without calling a model or enumerating all files.
- [ ] Existing path-hash state can be opened and read; a migration or compatibility receipt records any subject mapping and is idempotent across restart.
- [ ] Existing pinning, visibility, pending-update, affected, checker, CLI run, and server run behavior remains green.
- [ ] Targeted kernel/automation/server/dashboard tests, type checks, architecture checks, and a real multi-stage backend workflow pass; unrelated pre-existing repository failures are recorded separately.

## Out of scope

- Requiring every open-ecosystem Skill to provide a complete static file manifest.
- Building a Bazel/Nix-style sandbox for every provider.
- Replacing document governance or field-state reducers with the runtime artifact store.
- Making the workflow editor invoke a model to infer file contracts.
- Removing legacy IDs or rewriting historical ledgers in place without a migration receipt.

## Blocking open questions

None. The implementation should use an additive subject/ref contract and a compatibility adapter for current stores; exact names may follow existing Kernel naming conventions.
