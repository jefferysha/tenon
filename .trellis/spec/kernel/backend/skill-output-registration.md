# Skill Output Auto-Registration (`documents/auto-register.ts`)

## 1. Scope / Trigger

- Trigger: a native host `Skill` PostToolUse hook has sealed its receipt (`internal-native-skill-receipt`).
- Purpose: register the canonical documents that skill just wrote into the change's document ledger
  without a manual `tenon document record`, so the next stage's inputs become `recorded` on their own.
- Out of scope: guessing at files outside the canonical path templates; value (field) slots; new guards.

## 2. Signatures

```ts
// documents/document-paths.ts
documentPathTemplates(kind: DocumentKind | string): readonly string[]
canonicalDocumentPaths(repoRoot: string, changeName: string, kind: DocumentKind | string): Promise<string[]>

// documents/auto-register.ts
autoRegisterDocuments(
  input: { repoRoot; changeDir; changeName; phase; policy: DocumentGovernancePolicy; producer: string; recordedAt: string },
  deps: { record: typeof recordDocument } = { record: recordDocument },
): Promise<{ recorded: { kind; path }[]; skipped: { kind; path; reason }[] }>
```

## 3. Contracts

- Path templates come only from `DOCUMENT_PRESENTATION_REGISTRY.templates[*].path`. `{change}` is
  replaced by the change name; `{capability}` expands to every directory under its parent
  (`openspec/changes/<change>/specs/*/spec.md`). Only existing regular files are returned, repo-relative,
  posix separators, de-duplicated, stable order.
- Candidate kinds = `policy.outputsByStep[phase] ∪ policy.mutableByStep[phase]` whose
  `producerCandidates` contain the producer under `skillsEquivalent` (alias table, e.g. `opsx:propose`).
- Per canonical path: no ledger record, or the last record's `sha256` differs from the file digest →
  `deps.record(...)`; identical digest → `skipped(reason: 'up-to-date')`.
- `recordDocument` still enforces Skill evidence (`kind:'tool', raw:'Skill: <id>'`) and StepVisit
  confirmation. Auto-registration never bypasses that; it only saves the manual command.
- History line kinds: `tool` = completion evidence (PostToolUse `skill-tracker.sh`); `tool-start` =
  PreToolUse `skill-start.sh` marker. `tool-start` is never completion evidence.

## 4. Validation & Error Matrix

- Ledger unreadable → one `skipped` entry carrying the error text, nothing recorded, no throw.
- Any `record` failure (missing evidence, wrong phase, locked slot) → `skipped(reason=error message)`;
  the loop continues with the next path. The function never throws (hook fail-open contract).
- Producer not a candidate for the phase → `{ recorded: [], skipped: [] }`.

## 5. Good / Base / Bad Cases

- Good: `open` phase, producer `openspec-propose`, `proposal.md` + `tasks.md` exist → both recorded.
- Base: same file re-confirmed with unchanged content → `up-to-date`, ledger untouched.
- Bad: `brainstorming` confirmed in `open` → not a candidate → nothing recorded, nothing skipped.

## 6. Tests Required

- `documents/auto-register.test.ts`: template substitution + capability glob; register / re-register on
  digest change / skip up-to-date / alias producer / failure → skipped / `mutableByStep` living document.
- `packages/cli/src/document-record.integration.test.ts`: receipt after writing `proposal.md` → ledger has
  `proposal(producer=openspec-propose)`; stderr carries one `[auto-register] recorded=… skipped=…` line.

## 7. Wrong vs Correct

### Wrong

```ts
// Scanning the worktree for "anything that changed" and recording whatever matches a *.md glob.
for (const file of changedFiles) await recordDocument({ kind: guessKind(file), path: file, ... })
```

### Correct

```ts
// Only canonical paths of the slots the current phase owns and this skill is allowed to produce.
const outcome = await autoRegisterDocuments({ repoRoot, changeDir, changeName, phase, policy, producer: skillId, recordedAt })
deps.io.err(`[auto-register] recorded=${…} skipped=${…}`)   // WARN only; receipt exit code unaffected
```

## Runtime artifact lineage (additive protocol)

### 1. Scope / Trigger

Use this protocol for arbitrary skills whose concrete files cannot be declared during workflow authoring.
It observes actual stage changes at runtime and keeps publication explicit.

### 2. Signatures

```ts
const service = await openArtifactService({ rootDir, scopeId })
const runtime = await StageArtifactRuntime.open({ service, rootDir, workflowRunId, stageId, stageAttemptId })
await runtime.reconcile()                 // discover created/changed/deleted files
await runtime.publish('report.md', 'deliverable')
await runtime.end('completed')
```

### 3. Contracts

- `observe` stores immutable content-addressed versions with `candidate` disposition by default.
- A stage may publish only a version observed by its own attempt; publishing changes disposition and records publisher.
- `catalog` returns current deliverables by default; `includeHistory` returns bounded immutable versions.
- `origin: unknown` is valid and must not be replaced with a guessed producer.
- UI reads use `consumer: 'ui'` and never create execution consumption receipts.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Path escapes the scoped root | Reject with `artifact path outside scope`. |
| Attempt publishes an unobserved artifact | Reject with `artifact was not observed by this attempt`. |
| Dependency-chain catalog has no matching dependency | Hide the unrelated producer; keep own-attempt artifacts visible. |
| Same bytes observed again | Reuse the immutable version and event idempotency key. |

### 5. Good / Base / Bad Cases

- Good: stage observes `report.md`, explicitly publishes it, and downstream stage lists the upstream stage as a dependency.
- Base: a skill writes an unregistered file; reconciliation exposes it as an unknown-origin candidate for review.
- Bad: a stage claims another stage's path without an observation event; publication is rejected.

### 6. Tests Required

- Assert immutable v1/v2 history, content deduplication, path traversal rejection, dependency visibility, current-attempt publication, UI-read receipt exclusion, and registered checker execution.

### 7. Wrong vs Correct

#### Wrong

```ts
// Treat every changed file as a trusted deliverable.
await service.publish(stageAttemptId, { path: changedPath })
```

#### Correct

```ts
await runtime.reconcile()
await runtime.publish(changedPath, 'candidate') // explicit promotion after observation
```

### 8. Runtime follow-up contract

- The artifact service persists `pinnedVersions` when an attempt starts; downstream catalog and reads
  use the same visibility predicate and may request `pinned: true` for deterministic retries.
- A consumed older version is marked `pendingUpdate` while its consumer is running and `affected` after
  the consumer ends. These states are projections, not permission to silently switch versions.
- Default scans exclude `.git`, `.pipeline-artifacts`, `.tenon-artifacts`, and `.orchestration-v2`.
  Codex managed observations accept only allow-listed completion envelopes with explicit in-scope paths;
  unknown or path-less events fall back to bounded reconciliation diagnostics.
- Production entry points register conservative JSON and unsupported-media checkers and record exact
  checker identity/version. CLI and server must call the shared production runtime factory.
- CLI document recording, field registration, server/runtime execution, and UI artifact reads for one
  change must derive the same change-level namespace. They must enter through the shared submission
  service or the production runtime adapter; projection names are views over one logical subject.
- A workflow declaration supplies the logical key used to join projections. A source path may be used
  only as a lookup alias for an already registered subject; it is never an identity or an implicit
  cross-workflow merge key.
- Path-unresolved managed-tool events are coalesced to at most one fallback reconcile per execution
  turn. Structured path observations remain immediate, and stage end still performs the final reconcile.

## Canonical subject identity and declaration-first submission

- A logical artifact is identified by `ArtifactSubjectRef`, whose stable key is
  `subject_id` plus `namespace`. The `projection` (`document`, `field`, or
  `runtime`) describes the view, while `source.path` is locator metadata only.
- New writes must use a logical subject key or a host-issued subject id. They
  must never derive identity from `path + mediaType`. A rename updates source
  metadata and preserves the subject id and immutable version lineage.
- Legacy path-hash ids remain readable through an `ArtifactSubjectAlias` and a
  migration receipt. The canonical record and all newly written versions use
  the subject id after migration.
- Executor-declared outputs enter through `submitArtifactOutput`. Declaration
  and governance are the primary evidence; reconciliation is a bounded
  cross-check. Reconciled files default to `intermediate` with
  `undeclared-candidate` status and are absent from the default deliverable
  catalog until explicitly submitted.
- Workflow stages may carry bounded `input_subject_refs` and
  `output_subject_refs`. The UI groups runtime entries by `subject_id` and
  progressively reveals content only when a user opens a version; it does not
  invent an input/output contract from a path.
- Field subject metadata is stored in the change-local
  `.pipeline-field-subjects.json` sidecar. The canonical field value remains in
  the StateStore/YAML revision; the sidecar is an additive lineage projection
  and its failure must not roll back a successful field commit.
- Document records may carry the same subject ref directly in
  `.pipeline-documents.json`. Existing document policy, evidence, and lock
  checks remain authoritative; the submission adapter must call those checks
  rather than writing the ledger directly.
