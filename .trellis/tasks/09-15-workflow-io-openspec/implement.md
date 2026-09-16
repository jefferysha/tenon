# Implementation plan: `09-15-workflow-io-openspec`

Source of truth: `design.md` in this directory (section numbers below refer to it). Wave 1 of
`../09-15-tenon-next-capabilities/implement.md`; branch `feat/workflow-io-openspec` in its own worktree.

## Ground rules

- Every commit builds and its listed tests pass. Commit messages follow the repo style (`feat(kernel): …`).
- Generated files stay out of commits (parent rule): run `npm run generate:default-workflow` and
  `npm run generate:document-presentation` locally for validation, then
  `git checkout -- packages/kernel/src/workflow/default-workflow.generated.ts packages/kernel/src/documents/document-presentation.generated.ts`
  before staging. `dist/` is never committed.
- Before changing any value, grep for it (`.trellis/spec/guides/index.md` pre-modification rule).
- UI text: one word per concept, no sentences except errors, nothing wraps (`whitespace-nowrap`/truncate).

## Ordered checklist

### C1 `feat(kernel): openspec key, per-branch document_contract and slot roles`

Files:
- `packages/kernel/src/workflow/document-contract-model.ts`: add `design-md`, `DocumentScope`, `DocumentSlotRole`,
  `DOCUMENT_KIND_CATALOG`, `DOCUMENT_CHAIN_PAIRS`, optional `requiresByStep`; delete `OpenSpecContract`.
- `packages/kernel/src/workflow/types.ts`, `ir.ts`, `workflow-plan-snapshot-types.ts` (`LegacyWorkflowIR` keeps
  optional `openspecContract`).
- `packages/kernel/src/workflow/parse.ts` (header `openspec`, E1, E6; `parseTracksBlock` branch contract, E4 parse side).
- `packages/kernel/src/workflow/parse-document-contract.ts` (role, producers rules, E7, E8).
- `packages/kernel/src/workflow/serialize.ts` (indent-aware contract, branch contract, `openspec` line).
- `packages/kernel/src/workflow/compile.ts` (key sets, `compileDocumentContract(value, path)`, branch contract, E2).
- `packages/kernel/src/workflow/document-contract.ts`: new `documentGovernancePolicy(workflowId, workflow, track?)`;
  `default` still returns the legacy table in this commit (switched in C3).
- `packages/kernel/src/workflow/validate.ts` (`selectTrackBranch` lifts branch contract; pass branch contract into
  `validateBranchSteps`), `effective-plan.ts` (`selectTrackBranchIr` lifts; `planFromIr` passes `track?.id`;
  `documentGovernanceFingerprint` adds `requiresByStep` only when present), `effective-io.ts` caller signature.
- Callers of `openspecContract` on definitions: `effective-io.ts:40-46`, `document-contract-validation.ts:158-164,266-271`
  (legacy branch removed in C2), dashboard untouched until C6.
- Tests: `parse.test.ts`, `serialize.test.ts`, `compile.test.ts`, `track-branch.test.ts`, `effective-plan.test.ts`.

Validate:
```bash
npx vitest run packages/kernel/src/workflow/parse.test.ts packages/kernel/src/workflow/serialize.test.ts \
  packages/kernel/src/workflow/compile.test.ts packages/kernel/src/workflow/track-branch.test.ts \
  packages/kernel/src/workflow/effective-plan.test.ts packages/kernel/src/workflow/policy-snapshot.test.ts
npm run build:packages
```

### C2 `feat(kernel): validate document contracts per branch with roles`

Files:
- `packages/kernel/src/workflow/document-contract-validation.ts`: delete `validateLegacyContract`,
  `REQUIRED_SKILL_GROUPS`; `validateDeclarativeContract` → `validateDocumentContract(branch, { origin })` with E3,
  E4, E8-E13 and the default-origin exemption for E11; export name updated in `document-contract.ts:407`.
- `packages/kernel/src/workflow/validate.ts:182,204-214` (call site; E5 is added in C3).
- Tests: `validate.test.ts` (existing cases at `:58-140` migrate to `openspec: true`), `document-contract.test.ts` (new).

Validate:
```bash
npx vitest run packages/kernel/src/workflow/validate.test.ts packages/kernel/src/workflow/document-contract.test.ts
```

### C3 `feat(workflow): default declares its document contract per track`

Files:
- `tools/generate-default-workflow.mjs:95-104`: skip a branch `document_contract:` block (lines deeper than it);
  `packages/kernel/src/workflow/generate-default-workflow.test.ts`.
- `templates/workflows/default.yaml`: `openspec: true`; five branch contracts reproducing the legacy table in legacy
  order; five `label: 归档` → `label: 完结` (`:126,272,420,564,705`).
- `packages/kernel/src/workflow/migrations/openspec-v1-document-policy.ts` (new): moved table + old selection rule,
  `legacyDocumentPolicyForSnapshot`; `effective-plan-snapshot-compat.ts:143-145` uses it.
- `packages/kernel/src/workflow/document-contract.ts`: remove the name-based branch and the phase tables (keep
  `SPEC_ADR_LIVING_DOCUMENT`).
- `packages/kernel/src/workflow/validate.ts` E5 in `validateWorkflowForStorage`.
- `packages/kernel/src/workflow/test-support.ts:28-43` `legacyDefaultWorkflow()` lifts the frontend branch contract.
- `tools/check-architecture.mjs:65-67`: drop the two `document-contract.ts` entries, add one for the migration module
  if its default-id check is flagged.
- Tests: `default-document-contract.test.ts` (new, fingerprint equality per branch), `effective-plan.test.ts`,
  `policy-snapshot.test.ts`, `default-artifacts.test.ts`, `governed-lifecycle-policy.test.ts`,
  `transition-application.test.ts`, `loadWorkflow.test.ts`.

Validate:
```bash
npm run generate:default-workflow
npx vitest run packages/kernel/src/workflow
npm run check:default-skill-matrix && npm run check:docs && npm run check:architecture
git checkout -- packages/kernel/src/workflow/default-workflow.generated.ts
```
Rollback point R1: revert C3 only; C1-C2 keep custom workflows working and default name-governed.

### C4 `refactor(kernel): document ledger, evidence and bundle require a policy`

Files:
- `packages/kernel/src/workflow/document-contract.ts`: delete phase-keyed helpers (design §3.4); add
  `requiresForPolicyStep`.
- `packages/kernel/src/index.ts:144-157,176` exports.
- `packages/kernel/src/state/document-ledger.ts:246,259-340,442-463` (policy required).
- `packages/kernel/src/state/document-evidence.ts:176-213,246-252` (policy required, drop `isAcceptedDocumentProducer`).
- `packages/kernel/src/documents/document-recording.ts:71-80` (policy required).
- `packages/kernel/src/compress/ledger-context-bundle.ts:1-5,110-124`, `ledger-context-bundle-contract.ts`,
  `ledger-context-bundle-node-adapter.ts:33-46` (policy input, E19).
- `packages/cli/src/commands/review.ts:107`, `packages/cli/src/test-support.ts:521,566-576`,
  `packages/cli/src/integration-harness.ts:267`, `packages/server/src/test-support.ts:275`.
- `packages/server/src/contextBundlePreview.ts:81-83,128-150` (resolve plan, pass policy, target check).
- Tests: `state/document-ledger.test.ts` (imports of `LEGACY_DOCUMENT_GOVERNANCE_POLICY` → migration table),
  `compress/ledger-context-bundle.test.ts`, `server/src/contextBundlePreview.test.ts`.

Validate:
```bash
npm run build:packages
npx vitest run packages/kernel/src/state packages/kernel/src/compress packages/server/src/contextBundlePreview.test.ts
npm run check:architecture
```
Rollback point R2: revert C4; C3 still runs because policies are always passed by production callers.

### C5 `feat(documents): project-scope design-md and require slots`

Files:
- `packages/kernel/src/state/document-path.ts:250-270` (`documentPathAllowed`, `resolveDocument(..., kind)`).
- `packages/kernel/src/state/document-ledger.ts` (project path E14, owner lookup for project update).
- `packages/kernel/src/state/document-evidence.ts` (require evaluation, E16, `reason` codes).
- `packages/kernel/src/compress/ledger-context-bundle.ts:25-50` (design-md reason, require materialization),
  `ledger-context-bundle-contract.ts:26-36`.
- `templates/documents/registry.v1.yaml`, `templates/documents/locales/zh-CN.yaml`, `templates/documents/locales/en.yaml`
  (template `design-md`; `workflow_steps.archive` → 完结 / Done).
- `packages/server/src/snapshot.ts:171-205`, `packages/server/src/types.ts:99-110` (`reason` passthrough).
- Tests: `state/document-path.test.ts`, `state/document-evidence.test.ts` (new), `state/document-ledger.test.ts`,
  `compress/ledger-context-bundle.test.ts`, `cli/src/document-record.integration.test.ts`,
  `documents/document-template-renderer.test.ts`, `server/src/snapshot.test.ts`.

Validate:
```bash
npm run generate:document-presentation
npm run check:document-templates
npx vitest run packages/kernel/src/state packages/kernel/src/documents packages/cli/src/document-record.integration.test.ts packages/server/src/snapshot.test.ts
bash tools/verify-skills.sh
git checkout -- packages/kernel/src/documents/document-presentation.generated.ts
```

### C6 `feat(cli): handoff --bundle follows the change's document contract`

Files: `packages/cli/src/commands/handoff.ts:100-143`, `packages/cli/src/program-workflows.ts:12-13`,
`packages/cli/src/commands/handoff.test.ts`, `packages/cli/src/track-branch.integration.test.ts`,
`packages/cli/src/init-workflow.integration.test.ts`.

Validate:
```bash
npx vitest run packages/cli/src/commands/handoff.test.ts packages/cli/src/track-branch.integration.test.ts packages/cli/src/init-workflow.integration.test.ts
```

### C7 `feat(workflow): effectiveIo slots carry role and scope`

Files: `packages/kernel/src/workflow/effective-io.ts` (§4.1; delete `documentSlotsLocked`),
`packages/kernel/src/index.ts:175-178`, `packages/server/src/workflows.ts:132-143` (shape only),
`packages/dashboard-app/src/api/governanceTypes.ts`, `packages/dashboard-app/src/api/governanceSchema.ts`,
tests `effective-io.test.ts`, `server/src/server.test.ts`, `dashboard-app/src/api/governanceSchema.test.tsx`.

Validate:
```bash
npx vitest run packages/kernel/src/workflow/effective-io.test.ts packages/server/src/server.test.ts
npm run test:web -- src/api/governanceSchema.test.tsx
npm run typecheck:web
```

### C8 `feat(dashboard): edit OpenSpec documents in the workflow editor`

Files:
- `packages/dashboard-app/src/workbench/workbenchDefinition.ts` (branch contract view/write, mutators §5.3, copy pruning).
- `packages/dashboard-app/src/workbench/useWorkflowEditor.ts` (expose mutators, `lintBlocked` errors only, create
  state `openspec`).
- `packages/dashboard-app/src/workflow/lint.ts` (severities, document lints, `draftEffectiveIo`).
- `packages/dashboard-app/src/workflow/producers.ts` (new; moved `producerSkills`).
- `packages/dashboard-app/src/workflow/StageEditorPane.tsx` (`+ 输入`, `+ 输出`, remove, lint line; delete runtime
  section and `runtimeContext`), `IoTable.tsx` (`onRemove`), `NewWorkflowDialog.tsx`, `WorkflowNav.tsx`,
  `WorkflowView.tsx:14,20,79`, `App.tsx:140-146,346`.
- `packages/dashboard-app/src/i18n/translations.ts` (workflow keys §5.7, delete `workflow.runtime_*`).
- Tests: `workbench/workbenchDefinition.test.tsx`, `workflow/lint.test.tsx`, `workflow/StageEditorPane.test.tsx`
  (delete `:76` case), `workflow/WorkflowNav.test.tsx`, `i18n/i18n.test.tsx`.

Validate:
```bash
npm run typecheck:web
npm run test:web -- src/workbench src/workflow src/i18n
npm run check:design-scale
```
Rollback point R3: C8 is Dashboard-only; revert without touching kernel.

### C9 `feat(dashboard): workspace IO counts, reasons and gate row; drop runtime artifacts`

Files:
- delete `packages/dashboard-app/src/workspace/ArtifactCatalogPanel.tsx`, `packages/dashboard-app/src/api/artifactClient.ts`.
- `packages/dashboard-app/src/workspace/TaskDetailPane.tsx`, `StageIoPanel.tsx`, `stageIo.ts`,
  `packages/dashboard-app/src/shared/DetailSheets.tsx:6`, `packages/dashboard-app/src/types.ts:25-29,61-69`,
  `packages/dashboard-app/src/api/snapshotDecoder.ts:74-110,182-203`, `packages/dashboard-app/src/i18n/translations.ts`
  (workspace keys, 已完结 / 含已完结 / phases / fields; delete `workspace.runtime_*`).
- Tests: `workspace/stageIo.test.tsx`, `workspace/TaskDetailPane.test.tsx` (new), `workspace/taskModel.test.tsx`,
  `api/boundaryDecoders.test.tsx`, `i18n/i18n.test.tsx`.

Validate:
```bash
npm run typecheck:web
npm run test:web
npm run check:design-scale
rg -n "ArtifactCatalogPanel|artifactClient|runtimeContext|artifactAttempts|runtime_artifacts" packages/dashboard-app/src && exit 1 || true
```

### C10 `refactor(server): remove the runtime artifact route and snapshot attempts`

Files: delete `packages/server/src/serverArtifactRoutes.ts`, `serverArtifactRoutes.test.ts`,
`workflowRuntime.browser.e2e.test.ts`, `runtimeWorkflowEditor.integration.test.ts`; edit
`packages/server/src/serverGetRoutes.ts:62-64,107-108,129`, `server.ts:291-292`, `snapshot.ts:55,81,91-122`
(`projectArtifactScopeIssue`), `snapshotProjectScan.ts:118,162`, `types.ts:5,66-67,316-318`,
`serverOrchestrationV2.integration.test.ts:133-135`, `snapshot.test.ts:68`.

Validate:
```bash
npm run build:packages
npx vitest run packages/server
rg -n "/api/artifacts" packages docs docs-site tools && exit 1 || true
```
Rollback point R4: independent of C1-C9 except the dashboard type removal in C9.

### C11 `docs: openspec key in skills, contract docs and oracle fixture`

Files: `skills/tenon/SKILL.md:110,165-171`, `skills/tenon-open/SKILL.md:199-203`, `skills/tenon-spec/SKILL.md:186`,
`skills/tenon-ship/SKILL.md:84`, `skills/tenon-explore/SKILL.md:76`, `docs/CONTRACT.md:280-284`,
`tools/oracle/run.sh:509-530` (emit `openspec: true`).

Validate:
```bash
bash tools/verify-skills.sh && npm run check:docs && npm run check:identity && npm run check:comments
rg -n "openspec_contract|openspecContract" packages templates skills tools docs --glob '!**/dist/**' --glob '!openspec/changes/archive/**'
```
The last command may list only `migrations/openspec-v1-document-policy.ts`, `LegacyWorkflowIR`, the E1/E2 hint
strings and their tests.

### C12 `docs(spec): workflow documents per track, project documents, editor IO`

Files: `.trellis/spec/kernel/backend/workflow-track-branches.md` (openspec key, branch contract, roles, CCR-3
fingerprint note, validation matrix), `.trellis/spec/kernel/backend/skill-output-registration.md` (project path rule,
policy required), `.trellis/spec/server/backend/workflow-branches-and-skill-files.md` (slot shape, snapshot `reason`),
`.trellis/spec/dashboard-app/frontend/component-guidelines.md` (IO editing, lint severities, workspace gate row and
counts; remove the runtime-artifacts section `:243-258` and the `locked`/no-mutator statements `:18-19,107-108,
165-173,221-241`), delete `.trellis/spec/server/backend/artifact-catalog-route.md`, update
`.trellis/spec/server/backend/index.md` if it links it.

### C13 Full gates and real-host acceptance (no product code)

```bash
npm run build
npm run generate:default-workflow && npm run generate:document-presentation
npm run check:architecture && npm run check:comments && npm run check:identity
npm run check:docs && npm run check:document-templates && npm run check:default-skill-matrix && npm run check:design-scale
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
git checkout -- packages/kernel/src/workflow/default-workflow.generated.ts packages/kernel/src/documents/document-presentation.generated.ts
```
Then run design §9 “Real hosts” with a locally installed build in Claude Code and Codex and record commands, outputs
and screenshots in `research/acceptance.md`.

## Risky files

| File | Risk | Guard |
| --- | --- | --- |
| `packages/kernel/src/workflow/effective-plan.ts`, `effective-plan-snapshot-compat.ts` | fingerprint drift breaks frozen snapshot restore | C3 fingerprint-equality test; V1/V2/V3 fixtures in `effective-plan.test.ts`, `policy-snapshot.test.ts` unchanged |
| `templates/workflows/default.yaml` | ~400 added lines; any producer/order mismatch changes the default policy fingerprint and running bindings | `default-document-contract.test.ts` compares every branch with the moved table |
| `packages/kernel/src/state/document-ledger.ts`, `document-evidence.ts` | gate behaviour for every governed change | existing ledger suites + new evidence suite; `document-record.integration.test.ts` |
| `tools/generate-default-workflow.mjs` | narrow scanner fails loud on the new block | generator test; `check:default-workflow-freshness` locally |
| `packages/dashboard-app/src/workbench/workbenchDefinition.ts` | branch write-back could leak one track's contract into another | branch round-trip test |
| `packages/server/src/snapshot.ts`, `snapshotProjectScan.ts` | removing attempts must keep the legacy-scope compatibility issue | `snapshot.test.ts` legacy-scope case |

## Overlap and merge notes

| File(s) | Other child | What each side touches | Merge note |
| --- | --- | --- | --- |
| `kernel/src/workflow/types.ts`, `ir.ts` | test-evidence, review-agents | they add `StepDef.tests` / `StepDef.agents` (+IR); here `WorkflowDef.openspec`, `TrackBranchDef.documentContract`, `WorkflowDocumentSlot.role` | disjoint interfaces; keep both |
| `kernel/src/workflow/parse.ts`, `serialize.ts` | test-evidence, review-agents | `parseStep`/`serializeStep` vs header loop, `parseTracksBlock`, `serializeTracks`, contract serializer | disjoint functions; re-run serialize round-trip tests after merge |
| `kernel/src/workflow/compile.ts` | test-evidence, review-agents | `STEP_KEYS`, `compileStep` vs `WORKFLOW_KEYS`, `TRACK_BRANCH_KEYS`, `DOCUMENT_SLOT_KEYS`, `compileTracks` | adjacent constant lines at `:45-57`; union the key sets |
| `kernel/src/workflow/validate.ts` | test-evidence, review-agents | step-level validation inside `validateBranchSteps` vs contract call site `:182` and storage rule `:204-214` | keep both; branch-prefix behaviour unchanged |
| `kernel/src/workflow/effective-plan.ts` | review-agents (agent digests in snapshot/fingerprint), test-evidence (test ids) | fingerprint JSON `:116-133` | smallest diff first; recompute pinned fingerprints once after both merge |
| `templates/workflows/default.yaml`, generated TS | test-evidence, review-agents, design-resources, data-driven-runner | here: `openspec`, branch contracts, 完结 labels; others: step `tests`/`agents`, `design-md` slots, producers | merge this child first (wave 1); later children edit the contract blocks in place; regenerate after every merge |
| `kernel/src/workflow/document-contract-validation.ts` | data-driven-runner | default E11 exemption | data-driven-runner deletes the exemption when manifest overlay goes |
| `kernel/src/workflow/document-contract-model.ts`, `templates/documents/*` | design-resources | here: `design-md` kind, catalogue, one-section template; there: full sections, validators | design-resources replaces the template sections only |
| `dashboard-app/src/api/governanceTypes.ts`, `governanceSchema.ts` | test-evidence, review-agents | `WbStepDef`/`decodeStep` vs `WbWorkflowDef`/`WbTrackBranch`/`WbIoSlot` decoders | disjoint |
| `dashboard-app/src/workflow/StageEditorPane.tsx` | test-evidence (测试 section), review-agents (执行者/评审者) | here: 输入/输出 sections, runtime section deleted, `runtimeContext` prop removed | they add sections after 门禁; rebase on the deletion |
| `dashboard-app/src/workspace/TaskDetailPane.tsx`, `shared/DetailSheets.tsx` | test-evidence (测试 sheet), review-agents (agent runs), multi-user (operators) | here: panel removal, gate row, `count: number | string`, hide empty IO | their sheet counts may use the widened type |
| `dashboard-app/src/i18n/translations.ts` | all UI children, task-delete-archive (`已归档` view) | here: keys in §5.7 | `include_archived` now means finished runs (含已完结); task-delete-archive adds its own 已归档 key |
| `dashboard-app/src/workspace/TaskListPane.tsx` | task-delete-archive, multi-user | not edited here (only the dictionary value changes) | — |
| `dashboard-app/src/types.ts`, `api/snapshotDecoder.ts`, `server/src/types.ts`, `snapshot*.ts` | test-evidence, review-agents, multi-user (snapshot records) | here: `documents.items[].reason`, `artifactAttempts` removed | disjoint fields |
| `cli/src/commands/review.ts`, `check.ts`, `kernel/src/workflow/transition-application.ts` | review-agents | here: one policy argument at `review.ts:107` | trivial |
| `skills/tenon-*/SKILL.md` | data-driven-runner (deletes phase skills) | here: key rename lines | deletion wins |

## Size

Roughly 14 commits: kernel ~1.4k lines changed (+~400 YAML), dashboard ~0.9k, server/cli ~0.3k, deletions ~1.5k,
tests ~1.2k. About 3–4 focused days plus real-host acceptance.

## Deviations

- **C4 instead of C6 for handoff policy.** Making the policy a required argument of `evaluateDocumentEvidence`
  forced every caller to resolve it at once, so the CLI handoff/bundle resolution landed in C4; C6 then only
  carried the bundle's own policy-step target rule.
- **OpenSpec switch test id.** Design §5 named `wb-wf-openspec`; the switch lives in the workflow menu, whose
  `MenuButton` convention prefixes items, so the real id is `wb-wf-menu-openspec`.
- **`workflow.runtime_artifacts_*` deleted in C9, not C8.** The keys belong to the panel; removing them with the
  panel kept every intermediate commit's dictionary consistent with its own UI.
- **New files beyond the design's file list.** `workflow/track-branch-error.ts` (extracted to break a kernel import
  cycle), `workflow/migrations/openspec-v1-document-policy.ts` (moved fixed table, V1 snapshot restore only),
  `workflow/default-document-contract.test.ts`, `compress/ledger-context-bundle-policy.test.ts`,
  `dashboard-app/src/workbench/documentContractEdits.ts`, `workflow/lintMessages.ts`, `workflow/producers.ts`,
  `workspace/TaskDetailPane.test.tsx`.
- **C10 kept the orchestration integration case.** Deleting only the `artifactAttempts` assertion would have left a
  test with no subject, so it now asserts that a canonical artifact scope yields no compatibility issue — the
  behaviour that survives. The `ArtifactService` type is re-sourced from `@tenon/automation`, which owns it, since
  `serverArtifactRoutes.ts` is gone.
- **C11 oracle item was a no-op.** `tools/oracle/run.sh` contains no `openspec_contract` and no custom-workflow YAML
  fixture — `bootstrap_new_document_contract` only drives default-phase `document record` calls — so there was
  nothing to add `openspec: true` to. Left unchanged.
- **C11 extended past its file list.** `docs/usage/custom-workflows-and-tracks.md` (+ zh-CN mirror),
  `documents-skills-and-evidence.md` and `routing-and-workflows.md` documented `openspec_contract: required` as live
  behaviour and showed a `document_contract` example without `openspec: true`; leaving them would document a removed
  key. Also deleted the dead `workflow.openspec_contract` / `workflow.document_contract` dictionary entries
  (unreferenced after the switch rename) and fixed `kernel/src/types.ts:239`, whose comment still named the removed
  YAML key. Note: `09-15-data-driven-runner` also edits the two `docs/usage` files on different lines.
- **Historical records left alone.** `docs/adr/*`, `docs/superpowers/{plans,specs}/*` are dated records and still
  mention `openspec_contract`; the C11 grep therefore lists them in addition to the expected packages-side
  leftovers (E1/E2 hint strings and their tests, the moved migration table, the V1/V2 snapshot alias, and the
  internal `openspecContract` init flags design §6.2 keeps).
- **`server.test.ts` pre-read invalid-target case** uses `'bad target!'` (regex-rejected) because the previous
  fixture value resolved differently on macOS; the not-a-step 400 assertion is asserted on Linux only.
- **`tools/test-hooks.sh` router fixtures needed a new helper.** Two router selection fixtures build a custom
  workflow by copying `templates/workflows/default.yaml` and only renaming it (`:1243`, `:1259`). With governance
  now declared in that YAML, the renamed copy lost default's producer-membership exemption and `loadWorkflow`
  rejected it (`tracks.chat: document_contract document 'proposal' 的 producer 'openspec-propose' 未在 owner_step
  'open' 声明`), so the router cold path emitted nothing and 10 selection assertions failed. Added
  `strip_document_contract()`, which drops the `openspec` switch and every branch contract block — these fixtures
  verify Track/workflow selection, not document governance. Same root cause as the Dashboard copy pruning in C8.
- **`check:default-workflow-freshness` cannot pass in this branch by construction.** It is
  `generate:default-workflow && git diff --exit-code` on a generated file the ground rules keep uncommitted, so it
  reports the regenerated 完结 label as drift. C13's own script ends by `git checkout --`-ing both generated files;
  the main session regenerates and commits them after merge.
- **C13 deferred.** Real-host acceptance belongs to wave 5 (parent X18); all local gates were run here.
- **Generated files regenerated locally, left uncommitted** per the ground rules: `default-workflow.generated.ts`,
  `document-presentation.generated.ts`, `templates/skill-sources.yaml` and `packages/cli/dist/tenon.mjs` (the last
  two rewritten as a side effect of `npm run sync:skill-provenance`, needed to re-validate `verify-skills.sh`).
