# Design: 工作流输入输出与 OpenSpec 接入 (`09-15-workflow-io-openspec`)

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X3 you own the per-track tables; X4 `role: update` exists now, the implicit `tenon` producer is added later by data-driven-runner; X5 no `scope:` key; allow several slots of one kind with different roles and `role: require` without producers; X18.

Bound by `../09-15-tenon-next-capabilities/design.md` (terms §1, YAML §4, Dashboard §7). Deviations are listed as
contract change requests (CCR) at the end. All citations are against `main` at `2290233c`.

## 0. Current state (grounding)

| Fact | Evidence |
| --- | --- |
| Document governance is chosen by **name** (`default`) or the alias `openspec_contract: required`, which return fixed tables keyed by the seven canonical phase ids | `packages/kernel/src/workflow/document-contract.ts:32-131,133-143` |
| A custom workflow's only other option is a **top-level** `document_contract` (`slots {kind, owner_step, producers}` + `reads`) | `parse-document-contract.ts:85-124`, `types.ts:205-230`, `document-contract.ts:144-165` |
| Kinds are a closed list of 10, no DESIGN.md | `document-contract-model.ts:7-18` |
| Policy is computed from the **full** IR (`compiled`), whose top-level `steps` is empty for tracked workflows, and is not track-aware | `effective-plan.ts:103-106`, `validate.ts:61-70` |
| Top-level `document_contract` is validated per branch against that branch's steps | `validate.ts:83-90,182` |
| Default's five tracks therefore share one document table; chat declares only drivers yet is required to produce `superpower-design` by `brainstorming` | `templates/workflows/default.yaml:6-137`, `templates/manifest.yaml:84-106` |
| Producers must be declared in the owner step (custom only; default never runs it) | `document-contract-validation.ts:182-192`, `.trellis/spec/dashboard-app/frontend/component-guidelines.md:165-173` |
| Phase-keyed helpers are still used when no policy is passed: ledger record/read, evidence, Context Bundle, server bundle preview | `state/document-ledger.ts:260-334,451-453`, `state/document-evidence.ts:205-213,249`, `compress/ledger-context-bundle.ts:117-124`, `server/src/contextBundlePreview.ts:81-83,128` |
| `handoff --bundle` rejects any non-canonical target | `ledger-context-bundle.ts:117-119`, `cli/src/commands/handoff.ts:127-143` |
| Document paths must start with `openspec/` or `docs/` | `state/document-path.ts:267-269` |
| Document slots carry `locked` (default/required) and the editor has no IO mutators | `effective-io.ts:13-20,40-42`, `dashboard-app/src/workflow/IoTable.tsx:20-43`, `workflow/lint.ts:91-143` |
| New stages and blank workflows get empty IO; copy of default drops governance | `workbench/useStageDraftEditor.ts:78-80`, `workbenchDefinition.ts:336-368` |
| `step-no-output` blocks saving only for governed workflows | `workflow/lint.ts:27-49`, `workbench/useWorkflowEditor.ts:284-293` |
| 运行时产物 renders in the workspace (polls every 5 s) and in the workflow page (bound to a selected change through `runtimeContext`) | `workspace/TaskDetailPane.tsx:9,58,110`, `workflow/StageEditorPane.tsx:13,18,68,195-202`, `App.tsx:140-146,346`, `workflow/WorkflowView.tsx:14,79` |
| Only the Dashboard calls `/api/artifacts/*`; snapshot projects `artifactAttempts` only for it | `api/artifactClient.ts:54-69`, `server/src/serverGetRoutes.ts:129`, `server/src/snapshot.ts:91-122`, `server/src/snapshotProjectScan.ts:118,162` |
| Host-driven changes never have attempts, so the panel is always empty | `.trellis/spec/server/backend/artifact-catalog-route.md:5-9`, `research/io-and-runtime-artifacts.md` |
| Workspace IO: tab counts are totals; statuses 已登记/缺失/已过期/未读取; no gate row; stale has no reason | `TaskDetailPane.tsx:111-126`, `StageIoPanel.tsx:8-15,52`, `i18n/translations.ts:176-181`, `state/document-evidence.ts:106-115,246-299` |
| Last step is labelled 归档 in YAML; finished runs read 已归档 | `default.yaml:126,272,420,564,705`, `translations.ts:153,167,333,337`, `templates/documents/locales/zh-CN.yaml` `workflow_steps.archive` |

## 1. Boundaries

### Owned here

1. YAML key `openspec: true|false` (workflow level) replacing `openspec_contract: required`.
2. `document_contract` per branch (next to the `steps` it references), slot `role: produce|update|require`.
3. Document kind catalogue in the kernel model (producers, scope, path), including new kind `design-md`
   (project scope, path `DESIGN.md`) and the record/evidence/bundle machinery for project scope and `require`.
4. Deleting name-based and `openspec_contract` policy tables and every phase-keyed document helper; `default.yaml`
   declares the same contract explicitly per track.
5. `tenon handoff --bundle` and the server bundle preview driven by the change's policy.
6. `effectiveIo` slot shape (`role`, `scope`, no `locked`).
7. Dashboard 工作流: OpenSpec switch, `+ 输出`, `+ 输入` checklist, remove row, producer auto-add, copy pruning,
   document lint (errors vs warnings).
8. Dashboard 工作台: remove 运行时产物 (both pages) and the now-unused client, route, snapshot field; outputs `n/m`;
   one-word statuses; producer text on missing rows; stale hover reason; gate row count; hide empty IO.
9. Wording 完结 / 已完结 for the last step and finished runs.

### Not owned

| Topic | Owner |
| --- | --- |
| DESIGN.md sections, validators, hue integration, default frontend timing (which step produces/updates/requires it) | `09-15-design-resources` (writes the slots into `default.yaml` using this machinery) |
| Step keys `tests` / `agents`, `review_lanes` removal | `09-15-test-evidence`, `09-15-review-agents` |
| Removing `tenon-*` producers, manifest overlay and the default producer-membership exemption (§4.4) | `09-15-data-driven-runner` |
| Per-user 归档 / 已归档 view | `09-15-task-delete-archive` |
| Orchestration runtime artifact display (PRD out of scope); the artifact service itself stays for `tenon orchestration run` | — |

## 2. YAML schema

### 2.1 Single pipeline

```yaml
name: feature-flow
openspec: true                     # optional; absent = false. Serializer writes the line only when true.
document_contract:                 # allowed only with openspec: true and top-level steps
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [openspec-propose]
    - kind: tasks
      owner_step: shape
      producers: [openspec-propose]
    - kind: tasks
      owner_step: build
      role: update                 # optional; absent = produce. Serializer never writes `role: produce`.
      producers: [openspec-propose]
    - kind: design-md
      owner_step: build
      role: require                # require: no producers line
  reads:
    - step: build
      kinds: [proposal, tasks]
steps:
  - id: shape
    ...
```

### 2.2 Tracks (CCR-1)

```yaml
name: default
openspec: true
review_budget: { ... }             # existing header keys unchanged, any order before tracks:
tracks:
  frontend:
    label: 前端
    document_contract:             # between label and steps; each branch owns its contract
      version: v1
      slots: [ ... ]
      reads: [ ... ]
    steps:
      - id: open
        ...
```

- A tracked workflow must not have a top-level `document_contract`; a branch without `document_contract` under
  `openspec: true` is governed with no documents (ledger exists, no document gates).
- `document_contract` block rules keep v1: `version: v1`, non-empty `slots`, `reads` present (`reads: []` allowed).
- Slot line order is fixed: `kind`, `owner_step`, `role` (omitted for produce), `producers` (omitted for require).
- No `scope:` key (CCR-2): scope and path come from the kind catalogue (§3.1).

### 2.3 Role semantics

| Role | Written at | Producers | Recording | Exit requirement |
| --- | --- | --- | --- | --- |
| `produce` | the step that first writes the kind in this branch; at most one per kind per branch | non-empty; each must be a skill of `owner_step` (custom) | allowed in `owner_step` by listed producers | required recorded + fresh at `owner_step` and every later step (existing accumulate rule, `document-contract.ts:186-196`) |
| `update` | a later step that may re-record | non-empty; each a skill of that step (custom) | allowed in that step by listed producers (existing `mutableByStep`) | none added |
| `require` | a step that needs the document present before leaving | none | not allowed | at that step only: change scope → recorded + fresh; project scope → ledger record fresh if one exists in this change, otherwise the catalogue path is a non-empty regular file |

`reads` keep v1 semantics (read receipt in the current StepVisit) and may name a kind only when this branch has a
`produce` or `update` slot for it at an earlier step. A project document produced outside the change is expressed
with `require`, not `reads` (§4.3).

## 3. TypeScript types and signatures

### 3.1 `packages/kernel/src/workflow/document-contract-model.ts` (pure, importable by the Dashboard)

```ts
export const DOCUMENT_KINDS = [
  'proposal', 'openspec-design', 'tasks', 'superpower-design', 'adr', 'delta-spec',
  'superpower-plan', 'plan', 'verification-report', 'applied-spec', 'design-md',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export type DocumentScope = 'change' | 'project'
export type DocumentSlotRole = 'produce' | 'update' | 'require'

export interface DocumentKindInfo {
  readonly scope: DocumentScope
  /** Upstream skills that write this kind; used for editor suggestions only, never for runtime authority. */
  readonly producers: readonly string[]
  /** Fixed repository path for project scope; change-scope paths come from the document registry. */
  readonly projectPath?: string
}
export const DOCUMENT_KIND_CATALOG: Readonly<Record<DocumentKind, DocumentKindInfo>> = {
  proposal: { scope: 'change', producers: ['openspec-propose'] },
  'openspec-design': { scope: 'change', producers: ['openspec-propose'] },
  tasks: { scope: 'change', producers: ['openspec-propose'] },
  'superpower-design': { scope: 'change', producers: ['brainstorming'] },
  adr: { scope: 'change', producers: ['brainstorming'] },
  'delta-spec': { scope: 'change', producers: ['openspec-propose'] },
  'superpower-plan': { scope: 'change', producers: ['writing-plans'] },
  plan: { scope: 'change', producers: ['writing-plans'] },
  'verification-report': { scope: 'change', producers: ['verification-before-completion'] },
  'applied-spec': { scope: 'change', producers: ['openspec-apply-change'] },
  'design-md': { scope: 'project', producers: ['hue'], projectPath: 'DESIGN.md' },
}
/** A branch declaring one kind of a pair without the other has a chain gap (editor warning only). */
export const DOCUMENT_CHAIN_PAIRS: readonly (readonly [DocumentKind, DocumentKind])[] = [
  ['proposal', 'tasks'],
  ['delta-spec', 'applied-spec'],
]

export interface DocumentGovernancePolicy {
  readonly id: 'openspec-v1' | 'document-v1'
  readonly steps: readonly string[]
  readonly outputsByStep: Readonly<Record<string, readonly DocumentOutputRequirement[]>>   // produce
  readonly mutableByStep: Readonly<Record<string, readonly DocumentOutputRequirement[]>>   // update
  readonly readsByStep: Readonly<Record<string, readonly DocumentKind[]>>
  /** require; omitted when the branch declares none, so existing policy fingerprints are unchanged. */
  readonly requiresByStep?: Readonly<Record<string, readonly DocumentKind[]>>
}
```

`DOCUMENT_CONTRACT_PHASES`, `isDocumentContractPhase`, `isDocumentKind`, `DocumentOutputRequirement` stay.
`OpenSpecContract` is deleted.

### 3.2 `packages/kernel/src/workflow/types.ts` / `ir.ts`

```ts
export interface WorkflowDocumentSlot {
  readonly kind: string
  readonly ownerStep: string
  readonly role?: 'update' | 'require'        // absent = produce; parse and compile normalize 'produce' to absent
  readonly producers: readonly string[]       // [] iff role === 'require'
}
export interface TrackBranchDef {
  readonly label?: string
  readonly documentContract?: WorkflowDocumentContractV1
  readonly steps: readonly StepDef[]
}
export interface WorkflowDef {
  readonly name: string
  readonly decomposition?: ...; readonly interaction?: ...; readonly reviewBudget?: ...   // unchanged
  readonly openspec?: boolean                 // parse yields true or absent; compile normalizes false to absent
  readonly documentContract?: WorkflowDocumentContractV1   // only with top-level steps
  readonly steps: readonly StepDef[]
  readonly tracks?: Readonly<Record<string, TrackBranchDef>>
}
// ir.ts WorkflowIR: `openspecContract` removed; `openspec?: true`; tracks[id].documentContract?
```

`LegacyWorkflowIR` (`workflow-plan-snapshot-types.ts`) keeps an optional `openspecContract?: 'required'` so V1/V2
snapshots still type-check.

### 3.3 Parse / serialize / compile

| File | Change |
| --- | --- |
| `parse.ts:298-351` | header loop: `openspec: (true|false)` (dup → `openspec 重复声明`, other → `openspec 只支持 true 或 false`); `openspec_contract:` → error §6 E1; keep `document_contract:` header block |
| `parse.ts:402-442` `parseTracksBlock` | accept `document_contract:` (once) before/after `label`, before `steps`: `parseDocumentContract(cur, indentOf(inner))` |
| `parse-document-contract.ts:29-58` | slot child `role: (produce|update|require)`; `producers` required non-empty unless role require; require with producers → error |
| `serialize.ts:171-208` | `serializeDocumentContract(contract, indent = '')`; header writes `openspec: true` then top-level contract; `serializeTracks` writes branch contract after `label` with four-space prefix |
| `compile.ts:45-57` | `WORKFLOW_KEYS` swap `openspecContract` → `openspec`; `TRACK_BRANCH_KEYS` add `documentContract`; `DOCUMENT_SLOT_KEYS` add `role` |
| `compile.ts:260-288,301-349` | `compileDocumentContract(value, path)`; `compileTracks` compiles branch contract with path `tracks.<id>.documentContract`; explicit `openspecContract` key → hint error (§6 E2) before the closed-key check |

### 3.4 Policy selection (`document-contract.ts`)

```ts
/** undefined = not governed. Track selection follows selectTrackBranch: no track → first branch. */
export function documentGovernancePolicy(
  workflowId: string,
  workflow: {
    readonly openspec?: boolean
    readonly documentContract?: WorkflowDocumentContractV1
    readonly steps: readonly { readonly id: string }[]
    readonly tracks?: Readonly<Record<string, { readonly documentContract?: WorkflowDocumentContractV1; readonly steps: readonly { readonly id: string }[] }>>
  },
  track?: string,
): DocumentGovernancePolicy | undefined
```

- `openspec !== true` → `undefined`.
- Branch: tracks present → `tracks[track]` (missing → `WorkflowTrackBranchError`), no track → first branch;
  otherwise top level.
- `id = isDefaultWorkflowName(workflowId) ? 'openspec-v1' : 'document-v1'`. The id is the persisted document profile
  (`effective-plan.ts:40-42`, `state/run-metadata.ts:116`, `workflow-run-repository.ts:120-191`); content always
  comes from YAML.
- `outputsByStep` = produce slots, `mutableByStep` = update slots, both in declaration order;
  `readsByStep` from `reads`; `requiresByStep` only when a require slot exists. Every branch step id gets an entry.
- `SPEC_ADR_LIVING_DOCUMENT` fallback for frozen `openspec-v1` policies stays (`document-contract.ts:60-63,207-226`).

Deleted from `document-contract.ts`: `OUTPUTS_BY_PHASE`, `MUTABLE_RECORDS_BY_PHASE`, `READS_BY_PHASE`,
`LEGACY_DOCUMENT_GOVERNANCE_POLICY` (moved, below), `outputsRequiredForPhase`, `readsRequiredForPhase`,
`recordsRequiredForPhase`, `outputRequirementFor`, `recordRequirementFor`, `isAcceptedDocumentProducer`,
`producerCandidatesFor`, `documentOwnerPhase`, `isDocumentRecordAllowedInPhase`,
`isDocumentProducerAllowedInPhase`, `recordProducerCandidatesFor`, `isOutputAllowedInPhase`,
`isOpenSpecDocumentContractRequired`, `shouldEnforceDocumentEvidenceOnTransition` (lines 279-395), and their
re-exports in `packages/kernel/src/index.ts:144-157`. New helper:

```ts
export function requiresForPolicyStep(policy: DocumentGovernancePolicy, step: string): readonly DocumentKind[]
```

`packages/kernel/src/workflow/migrations/openspec-v1-document-policy.ts` (new) holds the moved table and the old
selection rule, used **only** by V1 snapshot restore:

```ts
export function legacyDocumentPolicyForSnapshot(
  workflowId: string,
  workflow: LegacyWorkflowIR & { readonly openspecContract?: 'required'; readonly documentContract?: WorkflowDocumentContractV1 },
): DocumentGovernancePolicy | undefined   // replaces the call at effective-plan-snapshot-compat.ts:145
```

### 3.5 Plan, branch selection, fingerprint (`effective-plan.ts`, `validate.ts`)

- `selectTrackBranch` (`validate.ts:61-70`) and `selectTrackBranchIr` (`effective-plan.ts:87-94`) lift the branch's
  `documentContract` to the top level of the returned single-pipeline definition (top-level one dropped when tracks
  exist).
- `planFromIr` (`effective-plan.ts:103-106`): `documentGovernancePolicy(id, compiled, track?.id)` when not frozen.
- The fingerprint JSON (`effective-plan.ts:116-133`) is unchanged in shape; `workflow: compiled` now contains
  `openspec` and branch contracts, and `documentPolicy` is the selected track's policy (CCR-3). Frozen snapshot
  restore passes the frozen policy, so stored V2/V3 fingerprints still verify (`effective-plan.ts:240-311`).
- `documentGovernanceFingerprint` (`effective-plan.ts:52-74`) adds `requiresByStep` to the canonical object only
  when present.

### 3.6 Ledger, evidence, bundle (policy becomes mandatory)

```ts
// state/document-path.ts
export function documentPathAllowed(kind: DocumentKind | undefined, relativePath: string): boolean
  // openspec/ or docs/ prefix; or kind scope project and relativePath === DOCUMENT_KIND_CATALOG[kind].projectPath
export async function resolveDocument(repoRoot: string, path: string, readSource?: BoundedFileHandleReader, kind?: DocumentKind): Promise<ResolvedDocument>

// state/document-ledger.ts
RecordDocumentLedgerInput.policy: DocumentGovernancePolicy      // was optional (:246)
ReadDocumentsInput.policy: DocumentGovernancePolicy             // was optional (:442)
// recordDocumentLedger: project-scope kind requires path === projectPath; ownerPhase lookup falls back to the
// first update step for a project kind that has no produce slot in the branch.

// state/document-evidence.ts
export type DocumentStaleReason = 'changed' | 'producer' | 'invocation' | 'legacy-path'
export interface DocumentEvidenceItem { ...; readonly reason?: DocumentStaleReason }   // only when status === 'stale'
export async function evaluateDocumentEvidence(
  repoRoot: string, changeDir: string, phase: string, scope: DocumentEvidenceScope, policy: DocumentGovernancePolicy,
): Promise<DocumentEvidenceReport>                               // policy was optional (:181)

// compress/ledger-context-bundle-contract.ts
CompileLedgerContextBundleInput.policy: DocumentGovernancePolicy
LedgerContextBundleReasonCode |= 'context-bundle.reason.design-md'
```

Evidence kinds at step S = accumulated produce kinds ∪ reads(S) ∪ requires(S). A require kind with no ledger record:
change scope → `missing`; project scope → resolve `projectPath` with `resolveDocument(..., kind)`; success →
`recorded` (no producer or invocation check, `paths: [projectPath]`, `producers: []`), failure → `missing` with
blocker `缺少项目文档 '<kind>'（<path>）`.

Bundle kinds for target T = reads(T) ∪ requires(T); a require project kind without a record is materialized from
`projectPath` with a digest computed from the file.

## 4. Data flow

```
YAML (global store / built-in default)
  └─ parseWorkflow → validateWorkflowForStorage → compileWorkflow            (kernel)
       └─ planFromIr(id, model, IR, track)
            ├─ selectTrackBranchIr → branch steps + branch documentContract
            ├─ documentGovernancePolicy(id, IR, track) → plan.capabilities.documents.policy
            └─ workflowPlanSnapshot (frozen policy + fingerprint at tenon init)
                 ├─ CLI: document record/read/scaffold/status, check, transition, review, handoff --bundle
                 ├─ server snapshot: evaluateDocumentEvidence → documents.items[{status, reason?}]
                 └─ server bundle preview
GET /api/workflows/:name → branches[track].effectiveIo = materializeWorkflowIo(selectTrackBranch(def, track))
  └─ Dashboard 工作流 editor draft → draftEffectiveIo (lint.ts) → POST definition (decodeWorkflowDef)
  └─ Dashboard 工作台 → StageIoPanel rows (effectiveIo slot × snapshot documents item)
```

### 4.1 `effectiveIo` slot (`effective-io.ts`)

```ts
export interface WorkflowDocumentSlotIo {
  readonly kind: 'document'
  readonly id: string
  readonly role: 'produce' | 'update' | 'read' | 'require'   // outputs: produce | update; inputs: read | require
  readonly scope: DocumentScope
  readonly producers: readonly string[]   // outputs: skill candidates; read: [producing step id]; require: []
  readonly consumers: readonly string[]
}
```

`locked` and `documentSlotsLocked` are deleted (`effective-io.ts:19,40-42`, `index.ts:176`).

### 4.2 Default workflow

- `templates/workflows/default.yaml` gains `openspec: true` and, in each of the five branches, a
  `document_contract` that reproduces `OUTPUTS_BY_PHASE` (produce), `MUTABLE_RECORDS_BY_PHASE` including
  `SPEC_ADR_LIVING_DOCUMENT` (update) and `READS_BY_PHASE` (reads) with identical producer candidate lists and the
  same per-step order. Result: every branch's `documentGovernanceFingerprint` equals the fingerprint of the moved
  legacy table, so `DEFAULT_PLAN_BINDING.documentGovernanceFingerprint` (`state/state-init.ts:14,52-57`) and
  bindings of running default changes still match.
- The five `label: 归档` lines become `label: 完结`.
- `validateWorkflowForStorage('default', …)` additionally requires `openspec: true`.

### 4.3 Project documents

- Path is fixed by the catalogue (`DESIGN.md`); `tenon document record <c> design-md DESIGN.md --producer hue` is
  accepted in a step with a produce/update slot; any other path → error.
- `templates/documents/registry.v1.yaml` gets template `design-md` (`path: "DESIGN.md"`, `sections: ["title"]`,
  `layout: ["h1:title"]`, `creation: missing-only`) plus `title` in both locale catalogues; design-resources replaces
  sections later. `tenon document scaffold <c> design-md` therefore never overwrites an existing file.
- `GET /api/documents/read` needs no change (`server/src/serverGetDocumentRoutes.ts:43-57` accepts any safe
  root-relative path).

### 4.4 Producer membership for default

`validateDocumentContract` skips the "producer declared in owner step" rule when `origin === 'default'`: default runs
`phase-manifest` with skills overlaid from `templates/manifest.yaml:84-106`, and chat is drivers-only. Removal of
the exemption belongs to data-driven-runner. Copying default in the Dashboard prunes contracts (§5.3) so the copy
satisfies the custom rule.

## 5. Dashboard

### 5.1 Types and decoders

| File | Change |
| --- | --- |
| `api/governanceTypes.ts:116-120,180-201,216-219` | `WbDocumentContract.slots[].role?: 'update' | 'require'`; `WbWorkflowDef.openspec?: boolean` (remove `openspecContract`); `WbTrackBranch.documentContract?`; `WbIoSlot` document variant `{ kind; id; role; scope; producers; consumers }` |
| `api/governanceSchema.ts:362-382,415-431,451-463,499-528` | decode `role` (closed set), `openspec` (boolean), branch `documentContract` (`allowedKeys` adds it), slot `role`/`scope`, drop `locked` |
| `types.ts:25-29,61-69` | `documents.items[].reason?: 'changed' | 'producer' | 'invocation' | 'legacy-path'`; delete `artifactAttempts` |
| `api/snapshotDecoder.ts:74-110,182-203` | decode optional `reason` (closed set); delete `artifactAttempts` decoding |

### 5.2 Branch view (`workbench/workbenchDefinition.ts:77-104`)

- `selectBranchDef` lifts `tracks[id].documentContract` into the view (`documentContract`), top-level otherwise.
- `writeBranchDef` writes `documentContract` back to `tracks[id]` for a track branch (top-level stays absent);
  `withContract` (`:196-202`) applies per branch.
- `addTrackBranch` deep-copies the source branch contract; `removeStageFromDef` (`:267-283`) prunes slots, reads and
  requires of the removed step in the branch contract.

### 5.3 Editor mutators (pure, `workbenchDefinition.ts`; exposed by `useWorkflowEditor.ts`)

```ts
export function setOpenspecInDef(def: WbWorkflowDef, on: boolean): WbWorkflowDef
  // off: delete openspec, top-level documentContract and every branch documentContract
export function documentKindsForOutput(view: WbWorkflowDef, stepId: string): DocumentKind[]
  // kinds whose catalogue producers intersect the skills of any step in this branch, minus kinds this step already
  // declares, minus kinds produced at a later step
export function addDocumentOutputInDef(view: WbWorkflowDef, stepId: string, kind: DocumentKind): WbWorkflowDef
  // role = produce when the branch has no produce slot for kind, else update (only allowed after it);
  // producers = catalogue producers ∩ step skills (bare-name match); if empty, append the first catalogue producer
  // that exists in the branch to this step via addSkillToDef and use it
export function removeDocumentSlotInDef(view: WbWorkflowDef, stepId: string, kind: string): WbWorkflowDef
export function documentInputCandidates(view: WbWorkflowDef, stepId: string): Array<{ kind: string; fromStep: string | null }>
  // produce/update slots at earlier steps (fromStep = nearest), plus project-scope kinds (fromStep null)
export function setDocumentInputsInDef(view: WbWorkflowDef, stepId: string, kinds: readonly string[]): WbWorkflowDef
  // kinds with an earlier produce/update → reads[stepId]; project kinds without → require slots at stepId
export function copyWorkflowDef(def: WbWorkflowDef, name: string): WbWorkflowDef
  // default source: existing producer-policy rewrite (:348-360) plus per branch: drop producers not in the owner
  // step's skills, drop produce/update slots left without producers, then drop updates/reads/requires whose
  // produce slot disappeared; delete the openspec_contract comment (:336-347)
```

`useStageDraftEditor.ts:78-80` is unchanged (new stages start without outputs; the warning dot shows).

### 5.4 Lint (`workflow/lint.ts`)

```ts
export type LintIssue = (
  | { kind: 'step-no-output'; stepId: string }                                           // warning (was blocking)
  | { kind: 'input-not-upstream'; stepId: string; field: string }                        // error
  | { kind: 'transition-…'; … }                                                          // unchanged, errors
  | { kind: 'document-producer-missing'; stepId: string; document: string; skill: string } // error (custom), warning (default)
  | { kind: 'document-order'; stepId: string; document: string }                         // error: update/read/require before produce
  | { kind: 'document-chain-gap'; stepId: string; document: string; missing: string }     // warning
) & { severity: 'error' | 'warning' }
```

- `governed(def)` (`:28-30`) becomes `def.openspec === true` and is used only for `transition-contract-required`
  when the workflow is default (canonical transitions remain a default-skeleton rule).
- `draftEffectiveIo` (`:95-143`) always derives document slots from the branch view's `documentContract`
  (no saved-IO fallback, no `lockedDocuments`).
- `lintBlocked` (`useWorkflowEditor.ts:286-293`) counts `severity === 'error'` only; `WorkflowNav.tsx:112,270`
  shows the amber dot for any issue of the step.

### 5.5 Workflow page UI

- `NewWorkflowDialog.tsx`: `role="switch"` button `OpenSpec` (`wb-new-openspec`) under the mode radios; copy
  mode starts from the source's value, blank starts off, hidden for import (YAML decides). `CreateState` gains
  `openspec` / `setOpenspec`; submit applies `setOpenspecInDef`.
- `WorkflowNav.tsx` `wb-wf-menu` gains `menuitemcheckbox` `OpenSpec` (`wb-wf-openspec`), disabled for `default`.
- `StageEditorPane.tsx`:
  - 输入 head action `+ 输入` (`wb-inputs-edit`, only when `openspec` and editable) opens a popover checklist
    (`wb-input-option-<kind>`, `aria-checked`), rows `kind · 来源阶段` (project kinds without source show `—`).
  - 输出 head action `+ 输出` (`wb-outputs-add`) opens a listbox (`wb-output-option-<kind>`, row
    `kind · producers`); empty list shows `没有可产出的文档`.
  - `IoTable` gains optional `onRemove(slot)`; document rows show `×` (`slot-remove-<id>`).
  - Output empty state text `没有输出` (`workflow.no_outputs`) replaces the sentence `runtime_outputs_empty`.
  - Row `title` YAML paths: `tracks.<id>.document_contract.slots[<kind>]` / `...reads[<step>]` for track branches.
  - The first document lint issue of the step renders once under 输出 (`stage-document-lint`, amber, `role=status`).
  - Section `workflow-runtime-artifacts` and prop `runtimeContext` are deleted (`:13,18,68,195-202`).

### 5.6 Workspace UI

- `TaskDetailPane.tsx`: delete `ArtifactCatalogPanel` import/usage and `artifactAttemptId` (`:9,58,110`).
- Gate row (`task-gate-row`) above the sheets: gate icon (review shield / auto bolt) + `评审 · k/n` or `自动 · k/n`.
  `gate = (row.rules ?? change.workflowRules).gateByStep[selectedStep]`; hidden when `gate === null` or `n === 0`.
- Outputs tab count is the string `k/n`; inputs tab count stays `n`. `SheetTabs` (`shared/DetailSheets.tsx:6`)
  `count?: number | string`.
- The `stage-io` block (tabs + panel) is not rendered when inputs and outputs are both empty.
- `StageIoPanel.tsx`: missing document row meta = producers (plain mono text, not a boxed chip); stale status pill
  gets `title` = reason word and `data-reason`.

```ts
// workspace/stageIo.ts
export interface IoRow { ...; reason: DocumentStaleReason | null; producers: readonly string[] }
export function ioRowOf(change: ChangeSnapshot, slot: WbIoSlot, stageSkills: readonly string[]): IoRow
  // producers = slot.producers ∩ stageSkills (bare-name), fallback slot.producers; [] for fields and inputs
export function gateProgress(
  gate: 'review' | 'auto' | null, outputs: readonly IoRow[], reviewSatisfied: boolean,
): { gate: 'review' | 'auto'; done: number; total: number } | null
  // auto: done = ready outputs, total = outputs; review: +1 condition satisfied by reviewSatisfied; null when gate null or total 0
// reviewSatisfied = stage status 'done' || (change.phase === step && change.reviewHandshake?.status === 'approved')
```

`producerSkills` moves from `StageEditorPane.tsx:27-34` to `workflow/producers.ts` and is reused.

### 5.7 Wording

| Key | zh before → after | en after |
| --- | --- | --- |
| `workspace.status_stale` | 已过期 → 过期 | Stale |
| `workspace.status_unread` | 未读取 → 未读 | Unread |
| `workspace.stale_changed` / `stale_producer` / `stale_invocation` / `stale_legacy_path` (new) | 内容已变 / 技能不符 / 登记未完成 / 旧路径 | Changed / Wrong skill / Incomplete / Old path |
| `workspace.gate_review` / `gate_auto` (new) | 评审 / 自动 | Review / Auto |
| `workspace.summary_archived` | 已归档 → 已完结 | Done |
| `workspace.include_archived` | 含已归档 → 含已完结 | Done |
| `phases.archive` / `fields.archived` | 归档 → 完结 / 已归档 → 已完结 | Done |
| `workflow.add_input` / `add_output` / `openspec` / `no_outputs` / `outputs_none_available` / `remove_slot` (new) | 输入 / 输出 / OpenSpec / 没有输出 / 没有可产出的文档 / 移除 {id} | Input / Output / OpenSpec / No outputs / Nothing to produce / Remove {id} |
| `workflow.lint_document_producer_missing` / `lint_document_order` / `lint_document_gap` (new) | {document} 缺技能 {skill} / {document} 在产出之前 / 缺 {missing} | … |
| deleted | `workspace.runtime_artifacts_*` (`:187-191`), `workflow.runtime_outputs_empty`, `workflow.runtime_artifacts_*` (`:259-266`) and en mirrors | |

`templates/documents/locales/zh-CN.yaml` `workflow_steps.archive` 归档 → 完结 (en unchanged `Archive` → `Done`).
Internal field `archived`, event `archived`, `archive-run`, step id `archive`, `tenon-archive`, OpenSpec archive
commands are unchanged.

## 6. Server and CLI

### 6.1 HTTP

| Route | Change |
| --- | --- |
| `GET /api/workflows/:name` | definition carries `openspec`, branch `documentContract`, slot `role`; `effectiveIo`/`branches[*].effectiveIo` slots per §4.1 (`server/src/workflows.ts:132-143`) |
| `POST /api/workflows`, `PUT …/yaml` | new keys accepted through `decodeWorkflowDef`/`validateWorkflowForStorage`; `openspecContract` / `openspec_contract` rejected with E1/E2 |
| `GET /api/snapshot` | `documents.items[].reason?`; `artifactAttempts` removed (`server/src/types.ts:66-67`, `snapshotProjectScan.ts:162`); the legacy-scope compatibility issue from `projectArtifactAttempts` (`snapshot.ts:91-122`) stays, the function becomes `projectArtifactScopeIssue` returning only the issue |
| bundle preview (`server/src/contextBundlePreview.ts`) | resolve the change's bound plan (same resolver as the snapshot) and pass `policy`; `target` must be a policy step; ungoverned change → 400 `CONTEXT_BUNDLE_INVALID_REQUEST` `workflow 未开启 openspec` |
| `GET /api/artifacts/catalog|subjects|inspect|read|events` | deleted with `serverArtifactRoutes.ts`, its test, wiring `serverGetRoutes.ts:62-64,107-108,129` and `server.ts:291-292`; `artifactServiceForRoot` stays for the snapshot issue and orchestration (`server.ts:197-214`) |

### 6.2 CLI

- `tenon handoff <c> --bundle --target <step>`: load `effectiveWorkflowForState(deps, state)`
  (`cli/src/commands/effective-workflow.ts:16`), pass `plan.capabilities.documents.policy`; no policy → exit 1
  `ERROR: workflow '<w>' 未开启 openspec，--bundle 不适用`. Help text `--target <step>` “Context Bundle 的消费阶段”
  (`program-workflows.ts:12-13`).
- `review.ts:107` passes `documentPolicy` to `evaluateDocumentEvidence`.
- Internal init flags `openspecContract`/`documentContract` booleans derived from the policy id
  (`init.ts:223-224`, `serverPostChangesRoutes.ts:236-237`, `workflow-run-create-repository.ts:360-361`) are unchanged.

## 7. Compatibility, migration, removals

| Item | Handling |
| --- | --- |
| Global/project YAML with `openspec_contract: required` | load fails with E1 naming the replacement (precedent: `gate: confirm`, `.trellis/spec/kernel/backend/workflow-track-branches.md:60-63`). No automatic rewrite. |
| YAML with `document_contract` but no `openspec` | load fails with E3; fix is one line. |
| Tracked YAML with top-level `document_contract` | load fails with E4. |
| Global `default` override without `openspec: true` | storage validation fails (E5); 恢复内建 in the Dashboard still works. |
| Running changes with frozen V3/V2 snapshots | unaffected: frozen IR and policy, fingerprint shape unchanged. |
| Running V1 snapshots | restored through `legacyDocumentPolicyForSnapshot` (moved table), plus existing pre-Tenon path. |
| Default changes without snapshot but with a bound `workflowPlanFingerprint` | fail closed as they already do on any default template change (label edit included). |
| Ledgers | format unchanged (`contract: 'openspec-v1'`, `document-ledger.ts:185`); no new record fields. |
| Generated files | `default-workflow.generated.ts`, `document-presentation.generated.ts` regenerated by the main session after merge (parent `implement.md`). |
| Removed code | phase tables and helpers (§3.4), `validateLegacyContract` + `REQUIRED_SKILL_GROUPS` (`document-contract-validation.ts:21-62,105-156`), `documentSlotsLocked`, `ArtifactCatalogPanel.tsx`, `api/artifactClient.ts`, `runtimeContext` (App/WorkflowView/StageEditorPane), snapshot `artifactAttempts`, `serverArtifactRoutes.ts(+test)`, `workflowRuntime.browser.e2e.test.ts`, `runtimeWorkflowEditor.integration.test.ts`, `.trellis/spec/server/backend/artifact-catalog-route.md`, i18n keys §5.7 |
| Text references | `skills/tenon/SKILL.md:110,165-171`, `skills/tenon-open/SKILL.md:199-203`, `skills/tenon-spec/SKILL.md:186`, `skills/tenon-ship/SKILL.md:84`, `skills/tenon-explore/SKILL.md:76`, `docs/CONTRACT.md:280-284`, `tools/oracle/run.sh:509` (add `openspec: true`), `tools/check-architecture.mjs:65-67` allowlist |
| Narrow YAML scanners | `tools/generate-default-workflow.mjs:95-104` must skip a branch `document_contract:` block; `tools/check-default-skill-matrix.mjs` and `tools/check-docs.mjs:96-124` only match `- id:` lines and need no change (verify) |

## 8. Validation and error matrix

| # | Condition | Layer | Result (message) |
| --- | --- | --- | --- |
| E1 | YAML line `openspec_contract:` | parse | `workflow 解析错误：openspec_contract 已移除——改为 openspec: true 并声明 document_contract` |
| E2 | structured key `openspecContract` | compile | `compileWorkflow: openspecContract: 已移除——改为 openspec: true` |
| E3 | `document_contract` (top or branch) without `openspec: true` | validate | `document_contract 需要 openspec: true` |
| E4 | top-level `document_contract` with `tracks` | parse + validate | `有 tracks 时 document_contract 写在 tracks.<id> 下` |
| E5 | storage key `default` without `openspec: true` | `validateWorkflowForStorage` | `default 必须保持 openspec: true` |
| E6 | `openspec:` value not `true`/`false`; duplicate | parse | `openspec 只支持 true 或 false` / `openspec 重复声明` |
| E7 | unknown `role` | parse / compile | `document slot '<k>' 的 role 只支持 produce | update | require` |
| E8 | produce/update without producers; require with producers | parse / validate | existing `缺非空 producers` / `role require 不声明 producers` |
| E9 | unknown kind; two produce slots of one kind in a branch; same kind twice at one step | validate | existing `不受支持` / `'<k>' 只能有一个 produce` / `'<k>' 在 step '<s>' 重复声明` |
| E10 | `owner_step` not in branch | validate | existing `owner_step '<s>' 不存在` (prefixed `tracks.<id>: `) |
| E11 | producer not a skill of the step (custom origin) | validate | existing `producer '<p>' 未在 owner_step '<s>' 声明` |
| E12 | change-scope update/require without an earlier produce | validate | `'<k>' 的 <role> 需要更早的 produce` |
| E13 | read of a kind without earlier produce/update in branch; owner reads itself; owner does not dominate reader | validate | `step '<s>' 读取了未声明的 document '<k>'` (project kinds add `，项目文档用 role: require`) / existing messages |
| E14 | record project kind at another path | ledger | `document '<k>' 的路径必须是 <projectPath>` |
| E15 | record path outside `openspec/`, `docs/` and not a project path | ledger | existing `document path 只能位于 openspec/ 或 docs/` |
| E16 | require project doc absent at exit | evidence → transition/check/review | blocker `缺少项目文档 '<k>'（<path>）` |
| E17 | stale record | evidence | existing blocker + `reason` code |
| E18 | `handoff --bundle` on ungoverned change | CLI | exit 1 `workflow '<w>' 未开启 openspec，--bundle 不适用` |
| E19 | `--target` not a policy step | kernel bundle | `CONTEXT_BUNDLE_INVALID_REQUEST` `Context Bundle target 必须是 workflow step: <t>` |
| W1 | step without outputs | Dashboard lint | warning dot, save allowed |
| W2 | chain pair incomplete | Dashboard lint | warning `缺 <missing>`, save allowed |
| L1 | editor producer missing (custom) / order violation | Dashboard lint | error, save blocked (mirrors E11/E12/E13) |

## 9. Tests required

### Kernel (`npm test`)

| File | Assertions |
| --- | --- |
| `workflow/parse.test.ts` | `openspec: true` parsed; `openspec: false` → absent; E1, E4 (parse side), E6, E7; branch `document_contract` parsed; `role: produce` normalized; require without producers |
| `workflow/serialize.test.ts` | round trip single + tracked form byte-stable; no `role: produce`, no `producers` for require, `openspec` line only when true |
| `workflow/compile.test.ts` | E2 hint; `TRACK_BRANCH_KEYS` accept `documentContract`; branch contract deep-frozen; closed keys still reject extras under `tracks.<id>.documentContract` |
| `workflow/validate.test.ts` | E3, E4, E5, E9-E13 each with branch prefix; default origin skips E11; default branches pass |
| `workflow/document-contract.test.ts` (new) | policy undefined without openspec; per-track selection differs; first branch without track; role maps; `requiresByStep` omitted when empty; id by workflow id |
| `workflow/default-document-contract.test.ts` (new) | for each default branch `documentGovernanceFingerprint(policy)` equals the fingerprint of `migrations/openspec-v1-document-policy` table; outputs order per step equals the legacy order |
| `workflow/effective-io.test.ts` | slots have `role`/`scope`, no `locked`; require appears in inputs; update in outputs |
| `workflow/effective-plan.test.ts`, `track-branch.test.ts`, `policy-snapshot.test.ts` | V1/V2/V3 fixtures restore unchanged; tracks with equal contracts share one fingerprint; tracks with different contracts get different policies; `legacyDefaultWorkflow()` (`test-support.ts:28-43`) lifts the frontend branch contract and keeps `openspec: true` |
| `state/document-path.test.ts` | `DESIGN.md` allowed only for `design-md`; E14/E15 |
| `state/document-ledger.test.ts` | record with policy required; update role replaces digest; project path rules; tests previously importing `LEGACY_DOCUMENT_GOVERNANCE_POLICY` import the migration table |
| `state/document-evidence.test.ts` (new) | `reason` per stale branch (`changed`, `producer`, `invocation`, `legacy-path`); require project present → recorded without producer checks; absent → missing + E16 blocker |
| `compress/ledger-context-bundle.test.ts` | custom step target accepted with a document-v1 policy; E19; require project doc materialized; open-with-no-reads still policy-empty |
| `workflow/generate-default-workflow.test.ts` | generator tolerates branch `document_contract`; labels 完结 |

### CLI

| File | Assertions |
| --- | --- |
| `commands/handoff.test.ts` | bundle compiler receives the plan policy; ungoverned change exit 1 E18 |
| `document-record.integration.test.ts` | `design-md` record at `DESIGN.md` gate-clean in a produce step; wrong path rejected |
| `init-workflow.integration.test.ts` | custom `openspec: true` workflow creates ledger; YAML with `openspec_contract` fails E1 |
| `track-branch.integration.test.ts` | per-track contract: frontend branch requires a document that backend does not |

### Server

| File | Assertions |
| --- | --- |
| `server.test.ts` | GET default: every branch slot has `role`, no `locked`; POST with `openspecContract` → 400 E2; global round trip keeps branch contract |
| `snapshot.test.ts` | stale item carries `reason`; no `artifactAttempts` key |
| `contextBundlePreview.test.ts` | custom target accepted; ungoverned 400 |
| `serverOrchestrationV2.integration.test.ts:133-135` | assertion on `artifactAttempts` removed |

### Dashboard (`npm run test:web`)

| File | Assertions |
| --- | --- |
| `workbench/workbenchDefinition.test.tsx` | `setOpenspecInDef(false)` removes all contracts; `addDocumentOutputInDef` role derivation and producer auto-add; `setDocumentInputsInDef` reads vs require; branch write-back keeps other branches' contracts; copying default passes kernel `validateWorkflowForStorage` for all five branches |
| `workflow/lint.test.tsx` | severities; W1 no longer blocks; W2 pair gap; L1 errors; default producer-missing is a warning |
| `workflow/StageEditorPane.test.tsx` | `wb-outputs-add` lists only producible kinds; choosing adds row + skill; `slot-remove-*`; `wb-inputs-edit` toggles reads; no `workflow-runtime-artifacts`; the test at `:76` is deleted |
| `workflow/WorkflowNav.test.tsx` | `wb-wf-openspec` toggles, disabled for default |
| `api/governanceSchema.test.tsx` | decode `openspec`, branch contract, `role`, slot `scope`; reject `locked`-only legacy slot shape |
| `workspace/stageIo.test.tsx` | `ioRowOf` producers ∩ stage skills; `gateProgress` for review/auto/null/zero |
| `workspace/TaskDetailPane.test.tsx` (new) | outputs tab text `输出2/3` (label + count); `task-gate-row` `评审 · 2/3`; stale pill `title` 内容已变; empty IO renders no `stage-io`; no request to `/api/artifacts` |
| `workspace/taskModel.test.tsx` | summary 已完结 |
| `api/boundaryDecoders.test.tsx`, `api/snapshotDecoder` | `reason` closed set; `artifactAttempts` ignored |
| `i18n/i18n.test.tsx` | zh/en parity after additions and deletions |

### Tools and gates

`npm run check:architecture`, `check:comments`, `check:identity`, `check:docs`, `check:document-templates`,
`check:default-skill-matrix`, `check:design-scale`, `bash tools/test-hooks.sh`, `bash tools/verify-skills.sh`.

### Real hosts (PRD acceptance)

Dashboard: new workflow with OpenSpec on, two custom stages declaring proposal/tasks and delta-spec; saved YAML and
reopened editor match. Claude Code and Codex each run one task: missing document blocks the transition naming the
document and producer; record unblocks; workspace shows `输出 k/n` and statuses; OpenSpec-off workflow shows no document
gate; `tenon handoff --bundle --target <custom step>` lists the declared reads. Evidence recorded in
`research/acceptance.md`.

## 10. Decisions made during design (按推荐确定)

1. Default becomes data: `default.yaml` declares `openspec: true` and a per-track contract identical to today's
   table; the name-based and `openspec_contract` tables and all phase-keyed helpers are deleted. Reason: one source
   of truth, and R10 needs per-track contracts on default without a second merge layer.
2. `openspec: true` is the only switch; old key and contract-without-switch fail loudly with the fix in the message;
   no automatic file rewrite.
3. `document_contract` lives next to the steps it references (CCR-1).
4. Scope and project path are properties of the kind (CCR-2).
5. Roles: produce / update / require as in §2.3. The editor derives the role when adding (first declaration =
   produce, later = update; checked project input without upstream = require); existing roles are preserved.
6. Policy id stays derived from the workflow id (`default` → `openspec-v1`) because it is a persisted profile.
7. The fingerprint uses the selected track's policy (CCR-3).
8. Producer membership is not checked for default (manifest overlay); copying default prunes the contract to
   declared skills so the copy validates as custom.
9. The producer catalogue is a kernel constant used only for editor suggestions; `+ 输出` lists kinds producible by
   some skill of the branch, and picking a kind whose producer is missing in the step adds that skill to the step
   (removable in the composer).
10. Inputs are edited only as a checklist over upstream document outputs and project documents; field IO stays
    YAML-derived.
11. Chain gaps and stages without outputs are warnings; structural contract problems are errors mirroring the kernel.
12. 运行时产物 is removed from both pages together with `runtimeContext`, the client, `/api/artifacts/*` and snapshot
    `artifactAttempts`; the artifact service and its legacy-scope compatibility issue stay.
13. Reads of a project document require an in-branch produce/update; otherwise `require`, which the bundle also
    materializes.
14. Stale reasons are four codes on evidence items, shown as a one-word hover.
15. Gate row counts outputs plus one review condition; hidden for no gate or zero conditions.
16. Producer names on missing rows are plain mono text (boxed source chips were rejected, memory item 9).
17. OpenSpec cannot be turned off for default.
18. Status words 过期 / 未读 replace 已过期 / 未读取 to satisfy one word per status.

## 11. Contract change requests (parent `design.md`, not edited here)

- **CCR-1 (§4)**: with `tracks`, `document_contract` is declared only under `tracks.<id>` (no top-level contract, no
  override/merge); top-level contract exists only with top-level `steps`. The example should move the top-level block
  into the branch.
- **CCR-2 (§4)**: remove `scope: project` from YAML slots; scope and path (`design-md` → `DESIGN.md`) come from the
  document kind. Example slot: `{ kind: design-md, owner_step: design, producers: [hue] }`. `role: produce | update |
  require` stays; `require` slots have no `producers`.
- **CCR-3 (§4 / kernel spec)**: workflow fingerprints include the selected track's document policy, so branches with
  different contracts have different fingerprints (identical contracts still share one).
- **CCR-4 (§4 Removed keys)**: add `openspec_contract` (replaced by `openspec: true`).
- **CCR-5 (§7)**: 运行时产物 is also removed from the workflow page; `/api/artifacts/*` and snapshot `artifactAttempts`
  are deleted.
