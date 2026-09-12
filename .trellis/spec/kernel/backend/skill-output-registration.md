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
