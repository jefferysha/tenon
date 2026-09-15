# Document Recording Boundary

## 1. Scope / Trigger

- Trigger: a skill has written a governed document (`openspec/...` or `docs/...`) and runs
  `tenon document record <change> <kind> <path> --producer <skill>`.
- The native Skill PostToolUse receipt (`internal-native-skill-receipt`) only seals the host
  confirmation. It never writes the document ledger.
- Out of scope: guessing documents from changed files; field slots; new guards.

## 2. Signatures

```ts
// packages/cli/src/commands/document.ts — the only document recorder
cmdDocumentRecord(deps, change, kind, path, producer, backfill?)
// packages/automation/src/submission/service.ts
openArtifactSubmissionService({ changeDir, namespace, repoRoot?, document?, field?, runtime? })
// packages/kernel/src/skill-invocation/document-producer.ts (private producer bridge)
recordCanonicalDocumentSkillInvocation(changeDir, kind, recordedAt, { lock?, record? })
```

## 3. Contracts

- Skill PostToolUse fires when the host loads the skill, before it produces anything. Recording at
  that moment would claim `tenon init` scaffolds as the skill's output and close the invocation before
  its questions and answers, so the receipt never records documents (auto-registration was removed).
- `cmdDocumentRecord` runs under one `withSkillInvocationChangeLock`: current-StepVisit host
  confirmation → unified submission (`document` projection) → `recordDocument` → binding of that exact
  row via `recordCanonicalDocumentSkillInvocation`. A row without the binding fails
  `evaluateDocumentEvidence` with `producer invocation/artifact 尚未原子完成；执行 tenon document record …`.
- A binding is idempotent only for the exact row: path, digest, kind **and** `recorded_at`. Recording
  unchanged bytes again at a later time mints a new application binding for the new row.
- History line kinds: `tool` = confirmation evidence (PostToolUse `skill-tracker.sh`); `tool-start` =
  PreToolUse `skill-start.sh` marker. `tool-start` is never completion evidence.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| No host confirmation for the producer in the current StepVisit | Reject `current StepVisit lacks exact host confirmation …` |
| Document path escapes the repository | Reject `submission path outside repository` |
| Path outside `openspec/` or `docs/` | Kernel rejects `document path 只能位于 openspec/ 或 docs/` |
| Edited document recorded again | Commit; the subject keeps `subject_id` and carries the new digest |

## 5. Good / Base / Bad Cases

- Good: Explore writes `docs/superpowers/specs/<change>-design.md`, then records it with
  `--producer brainstorming` → gate clean.
- Base: the same unchanged document recorded twice → still gate clean.
- Bad: relying on the Skill receipt to register documents → ledger stays empty, gate reports missing.

## 6. Tests Required

- `packages/cli/src/document-record.integration.test.ts`: the receipt leaves the ledger empty; a `docs/`
  design stays gate-clean after record, identical re-record, and re-record of edited content.
- `skill-invocation/document-producer.test.ts`: unchanged bytes recorded again later still pass the gate.
- `automation/src/submission/service.test.ts`: repository-scoped document/field paths, change-scoped
  runtime paths, digest refresh on subject reuse.
- The CLI integration harness wires `artifactSubmission` exactly like `main.ts`; a harness without it
  silently skips the production submission path.

## 7. Wrong vs Correct

### Wrong

```ts
// Skill PostToolUse receipt: register whatever canonical files already exist.
await recordDocument({ kind: 'proposal', path: scaffoldPath, producer: skillId, recordedAt })
```

### Correct

```sh
# In the skill, after the document is written:
tenon document record "$TENON_CHANGE_NAME" superpower-design "$DESIGN_DOC" --producer brainstorming
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
- A change-scoped migration receipt records the retained legacy store path and
  `preserved-awaiting-confirmation` status. If canonical and legacy stores both
  contain records that do not match by content digest and source path, opening
  the canonical scope persists a conflict receipt and fails with the stable
  `legacy-scope-unmerged` error; it never silently drops or deletes the legacy
  store. Equivalent dual stores still receive one idempotent checked receipt.
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
- Submission path scope: `document` and `field` locators are repository paths,
  checked against `repoRoot` (a design lives at
  `docs/superpowers/specs/<change>-design.md`; the Kernel ledger still owns the
  `openspec/`/`docs/` rule). `runtime` locators stay inside the Change. Escapes
  fail with `submission path outside repository` / `... outside change scope`.
- Reusing a registered subject keeps `subject_id` but always carries the digest
  of the bytes or value being committed now. Returning the stale registered
  digest made every re-record of an edited document fail with
  `subjectRef 与当前内容不匹配`.

## Native Skill receipt identity

### 1. Scope / Trigger

- Claude Code reports plugin skills with their namespace (`Skill: tenon:openspec-propose`). The v1.1.0 receipt
  command rejected `:`, sealed no host confirmation, and every later `tenon document record` failed with
  `current StepVisit lacks exact host confirmation for document producer '<skill>'` — the default workflow could not
  leave `open` in Claude Code.

### 2. Signatures

```bash
# hidden; called only by the Skill PostToolUse hook (skill-tracker.sh)
tenon internal-native-skill-receipt <change> <skillId> <sessionId> <toolUseId> <observedAt>
```

### 3. Contracts

- `skillId` must match `^(?:[A-Za-z0-9_-]{1,64}:)?[A-Za-z0-9_-]{1,160}$` (one optional host namespace).
- `tenon:` is stripped before `recordNativeDocumentSkillConfirmation`; other namespaces
  (`superpowers:brainstorming`) stay verbatim — producer matching aliases them through `skillsEquivalent`.
- The receipt only seals the confirmation; it never records documents (see Contracts above).
- Codex has no Skill tool: its confirmation is reconciled from a completed read of the producer's `SKILL.md`, so the
  first `document record` after writing a document fails until the agent reads that skill again.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Invalid change name or skill id (`tenon:bad id`) | exit 1 `internal-native-skill-receipt: invalid change or skill identity` |
| Missing WorkflowRun StepVisit identity | exit 1 `canonical WorkflowRun StepVisit identity is missing` |
| No matching `Skill:` history row for the current visit | exit 1 `native Skill receipt does not match the canonical current StepVisit` |

### 5. Good / Base / Bad Cases

- Good: `tenon:openspec-propose` receipt → `document record … --producer openspec-propose` exit 0, gate clean.
- Base: bare `openspec-propose` receipt behaves the same.
- Bad: rejecting namespaced ids — no host confirmation, documents unrecordable.

### 6. Tests Required

- `cli/src/document-record.integration.test.ts`: history `Skill: tenon:openspec-propose` + receipt with the
  namespaced id → record exit 0 and `evaluateDocumentEvidence` blockers `[]`; receipt `tenon:bad id` → exit 1.

### 7. Wrong vs Correct

#### Wrong

```ts
const SAFE_SKILL_ID = /^[A-Za-z0-9_-]{1,160}$/u
```

#### Correct

```ts
const SAFE_SKILL_ID = /^(?:[A-Za-z0-9_-]{1,64}:)?[A-Za-z0-9_-]{1,160}$/u
await recordNativeDocumentSkillConfirmation(dir, skillId.startsWith('tenon:') ? skillId.slice(6) : skillId, phase, receipt)
```

## Codex transcript skill read proof

### 1. Scope / Trigger

- Codex has no Skill tool. A producer confirmation is reconciled at `tenon document record` time from a completed
  `SKILL.md` read in the host transcript (`packages/cli/src/codexTranscriptEvidence.ts`).
- Trigger (v1.1.3 real Codex task): two reads never became evidence, so the following record failed and the agent
  searched the bundled source for the cause: a complete read written as `text(await tools.exec_command({...}));`
  (the parser accepted only the bound form), and reads of the 20 KB `tenon-explore` skill with
  `max_output_tokens` 1000/2000 (correctly rejected as truncated, but the error did not say so).

### 2. Signatures

```ts
// packages/cli/src/codexToolProgram.ts
transcriptExecInvocations(input: string): readonly TranscriptExecInvocation[]   // [] or exactly one
// packages/cli/src/codexTrustedSkillRead.ts
transcriptInputTrustedSkillInvocation(input: string, skillPath: string): TranscriptExecInvocation | undefined
outputMatchesTrustedSkillReads(output: unknown, abi: 'custom' | 'function', readPaths: readonly string[]): Promise<boolean>
```

### 3. Contracts

- Accepted `custom_tool_call(exec)` programs (whole input anchored, optional leading `// @exec: {json}` pragma):
  - `const|let|var <name> = await tools.exec_command({literal}); text(<name>);`
  - `text(await tools.exec_command({literal}));`
- The literal object may contain only `cmd|command, justification, login, max_output_tokens (positive safe integer
  literal), prefix_rule, sandbox_permissions, tty, workdir, yield_time_ms`.
- The command must be `cat [--] <absolute path>` segments (joined by `&&` or newlines) of trusted
  `skills/<id>/SKILL.md` files, including the receipt's path.
- The matching `custom_tool_call_output` must be a complete result envelope with `exit_code` 0 whose `output`
  equals the concatenated file bytes exactly. Truncated output is never evidence.
- Failure message (CLI and kernel): `current StepVisit lacks exact host confirmation for document producer '<p>'；在当前阶段重新调用该技能后重试登记（Claude Code 用 Skill 工具；Codex 用单独一条 cat 读取其 SKILL.md，max_output_tokens 要足够大，输出被截断不算读取）`.
- `skills/tenon/SKILL.md` (Codex hard rule) states both program forms and the output-budget rule.

### 4. Validation & Error Matrix

| Program / output | Result |
| --- | --- |
| Bound form, complete output | confirmed |
| `text(await …)` form, complete output | confirmed |
| `text(await …).output)`, `text(r.output)` | rejected (exit code not forwarded) |
| `text(tools.exec_command(…))` (not awaited), wrapped `text(JSON.stringify(await …))`, extra statements, `Promise.allSettled` batches | rejected |
| Output shorter than the file (budget too small) | rejected; record fails with the hint |

### 5. Good / Base / Bad Cases

- Good: `text(await tools.exec_command({cmd:"cat '<cache>/skills/openspec-propose/SKILL.md'",max_output_tokens:6500}));`
  → first record succeeds.
- Base: bound form with `max_output_tokens:8000` on the 20 KB skill → confirmed.
- Bad: `max_output_tokens:1000` on the same skill → output truncated → record fails; re-read with a larger budget.

### 6. Tests Required

- `codexToolProgram.test.ts`: the single-expression form is accepted (compact, and pretty-printed with pragma and
  workdir); stdout-only, unawaited, extra/leading statement, wrapped result and bound `.output` programs return `[]`.
- `codexSkillReceipt.test.ts`: `eventLines(..., { inlineText: true, execArgs: { max_output_tokens: 6500 } })` with a
  complete result envelope → `confirmedSkillIds` `['openspec-propose']`; existing truncated-output cases still reject.
- `runtime/stable-hook.integration.test.ts` keeps matching the error by prefix (`toContain`).

### 7. Wrong vs Correct

#### Wrong

```ts
const prefix = /^\s*(?:const|let|var)\s+(\w+)\s*=\s*await\s+tools\.exec_command\s*\(/.exec(input)
if (!prefix) return []   // Codex's text(await …) reads silently produce no evidence
```

#### Correct

```ts
const bound = /^…(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*await\s+tools\.exec_command\s*\(/.exec(input)
const inline = bound === null ? /^…text\s*\(\s*await\s+tools\.exec_command\s*\(/.exec(input) : null
// …same literal-object decoding…
const suffix = resultName === undefined ? /^\s*\)\s*\)\s*;?\s*$/ : /* ); text(<name>); */ boundSuffix
```

### Host attribution boundary

`managed-tool` source is reserved for a host completion event carrying an allow-listed path. Pathless Codex `command_execution` payloads remain `unknown`/`reconcile` observations and may be coalesced into one bounded reconcile per execution turn; consumers must not infer artifact ownership from command text.
