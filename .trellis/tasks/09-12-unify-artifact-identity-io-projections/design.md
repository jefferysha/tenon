# Technical design

## Canonical model

Add a Kernel-owned logical subject layer:

```ts
type ArtifactProjectionKind = 'document' | 'field' | 'runtime'
interface ArtifactSubjectRef {
  subject_id: string
  namespace: string
  version: string
  projection: ArtifactProjectionKind
  content_digest: `sha256:${string}`
  source?: { path?: string; document_kind?: string; field?: string }
}
```

`subject_id` is generated once by the host from an explicit logical key or a persisted first-seen identity. It is never recomputed from the current path. `version` is immutable and content-addressed; path, document kind, and field name are projection metadata.

The runtime `ArtifactVersion` remains the durable content record for compatibility, but gains an optional subject reference. Document ledger records and field output records gain the same optional reference. A resolver joins the three stores without making any store depend on another store's reducer.

## Submission boundary

Add an automation application service, for example `submitArtifactOutput(input)`, above document recording and `ArtifactService`:

1. Normalize and bound declarations from the executor envelope.
2. Resolve the subject using explicit logical key, existing projection mapping, or a new host-issued id.
3. Verify producer, stage, permissions, path scope, and content digest.
4. Persist the immutable version and append one lineage event.
5. Materialize document, field, and runtime projections through their existing repositories.
6. Mark declaration status and reconcile mismatches as bounded diagnostics.

The service is the only place allowed to turn a declaration into a deliverable. Existing direct APIs remain compatibility adapters and delegate to this boundary where possible.

## Declaration and reconciliation flow

```text
workflow contract refs
        ↓ (bounded metadata)
executor envelope / managed-tool event
        ↓
submitArtifactOutput ──→ subject + immutable version + projections
        ↑
reconcile fallback ─────→ intermediate / undeclared candidate + diagnostic
```

Explicit publish remains a promotion operation. A declared output that is missing on disk is rejected or left pending; a file found only by reconciliation never becomes a deliverable implicitly. Cross-checks compare digest/path/version and produce an event without overwriting declared provenance.

## Identity migration

- Add a persisted subject mapping table/section to artifact state.
- For legacy `artifact:<path-hash>` records, lazily assign a stable subject id on first access and emit a migration receipt containing old id, subject id, and digest.
- Preserve old ids as aliases for `inspect`, `read`, `catalog`, and existing receipts.
- `rename` changes only source metadata and emits `artifact.renamed`; it does not create a new subject.
- If two records could match after a rename, keep both and emit `identity-ambiguous`; require an explicit mapping rather than guessing.

## Workflow and UI projection

Workflow stages carry `input_subjects` and `output_subjects` as bounded refs or contract patterns. The editor shows contract/status badges and does not ask a model to infer files. Runtime catalog responses add subject id, projection kind, declaration status, and exact version while preserving current fields. Dashboard groups document, field, and runtime projections by subject id and keeps detailed history in the existing drawer/read surface.

## Compatibility and rollback

All new fields are optional. If the subject resolver or projection service fails, the existing runtime artifact operation can persist a legacy record and emit a diagnostic; canonical workflow state continues. A feature flag can keep legacy path-based identity for reads while new writes are disabled. Rollback removes the new projection materialization but retains immutable versions and migration receipts.

## Risks

- Ambiguous identity matching is more dangerous than duplicate display; fail closed and expose a repair action.
- Making reconciliation invisible would hide real unregistered outputs; keep an explicit review catalog.
- Joining document and field projections may reveal governance state to runtime consumers; enforce projection-specific read policies.
