# Implementation plan: `09-15-test-evidence`

Source of truth: `design.md` in this directory (section numbers below refer to it). Parent waves: wave 2
(`.trellis/tasks/09-15-tenon-next-capabilities/implement.md:9`).

Work happens in git worktree branch `feat/test-evidence` (parent `implement.md:16`).

Do not commit generated files. The main session regenerates them after merge (parent `implement.md:21-22`):
- `packages/*/dist`
- `packages/kernel/src/workflow/default-workflow.generated.ts`
- the dashboard dist

---

## 0. Preconditions (verify before C1)

| Check | Command | If missing |
| --- | --- | --- |
| `multi-user` merged: identity resolver | `grep -rn "export function resolveTenonUser" packages/kernel/src` | Stop. Wave 2 depends on it. |
| `multi-user` owner assertion for "advance" actions | `grep -rn "接手" packages/kernel/src packages/cli/src \| head` | Stop. `tenon test run` must call it (design §5.3 step 5). |
| `.tenon/` excluded from fingerprint | `grep -n "'.tenon'" packages/kernel/src/workspace/fingerprint.ts` | C1 adds it. |
| `.tenon/.gitignore` / ensure-dir helper | `grep -rn "users/\*/local" packages/kernel/src packages/cli/src .gitignore` | C6 adds `ensureTenonDir` in `test-evidence/paths.ts` and files CCR-3 again. |
| `workflow-io-openspec` merged (`SheetTabs.count` accepts strings) | `grep -n "count" packages/dashboard-app/src/shared/DetailSheets.tsx` | C20 widens `count` to `number \| string`. |
| Library page shell from `instruction-templates` | `ls packages/dashboard-app/src/library` | C22 waits; all other commits proceed. |

Before coding, read every file in `implement.jsonl` (`trellis-before-dev`).

---

## 1. Ordered commits

Each commit must build and pass its own validation. Shared gates run at the end (§3).

**Validation shorthand used below:**
- **K** = `npx tsc -b packages/kernel`
- **B** = `npm run build:packages`
- **V** `<paths>` = `npx vitest run <paths>`
- **W** `<names>` = `npm run test:web -- <names>`

### Kernel

- [ ] **C1 `feat(kernel): exclude .tenon from workspace fingerprint`**
  - Files:
    - `packages/kernel/src/workspace/fingerprint.ts`: add `.tenon` to `EXCLUDED_TOP_LEVEL` (`:22-37`) and export `TEST_OUTPUT_DIR_SEGMENTS`.
    - `packages/kernel/src/index.ts:18`: re-export it.
    - `fingerprint.test.ts`
  - Validate: K; V `packages/kernel/src/workspace/fingerprint.test.ts packages/kernel/src/workflow/build-revision.test.ts`.
  - Skip the `.tenon` line if `multi-user` already added it.

- [ ] **C2 `feat(kernel): step test definition types and YAML scalar codec`**
  - Files:
    - `packages/kernel/src/workflow/types.ts`: `TestInputDef`, `TestOutputKind`, `TestOutputDef`, `TestMetricCriterion`, `StepTestDef`, `StepDef.tests?`.
    - `packages/kernel/src/workflow/ir.ts`: `StepTestIR`, `StepIR.tests?`.
    - New `packages/kernel/src/workflow/yaml-scalar.ts` (`parseScalar`, `formatScalar`) + `yaml-scalar.test.ts`.
  - Validate: K; V `packages/kernel/src/workflow/yaml-scalar.test.ts`.

- [ ] **C3 `feat(kernel): parse and serialize step tests`**
  - Files:
    - New `workflow/parse-tests.ts` (`parseStepTests(cur, baseIndent)`, modelled on `parse-skill-refs.ts:17-58`).
    - New `workflow/serialize-tests.ts` (`serializeStepTests(tests)`).
    - `workflow/parse.ts`: branch next to `artifacts` (`:276-277`) and the return spread (`:285-290`).
    - `workflow/serialize.ts`: `serializeStep` (`:151-169`), `tests` written after `artifacts`.
    - New `parse-tests.test.ts`; extend `serialize.test.ts`.
  - Validate: K; V `packages/kernel/src/workflow/parse-tests.test.ts packages/kernel/src/workflow/serialize.test.ts packages/kernel/src/workflow/parse.test.ts`.

- [ ] **C4 `feat(kernel): compile and validate step tests`**
  - Files:
    - New `workflow/compile-tests.ts` (`compileStepTests(raw, path)`, fills defaults, fixed key order, §3.4 rules).
    - `workflow/compile.ts`: `STEP_KEYS` `:48-50` add `tests`; `compileStep` `:201-254` emits `tests` only when non-empty.
    - `workflow/validate.ts`: per-branch duplicate test id in `validateWorkflow` branch loop `:83-90`.
    - New `compile-tests.test.ts`.
    - Extend `track-branch.test.ts` and `effective-plan.test.ts` (golden fingerprint of a no-tests workflow unchanged; snapshot round trip keeps tests).
  - Validate: K; V `packages/kernel/src/workflow`.
  - **Rollback point R1:** reverting C2–C4 restores the schema.

- [ ] **C5 `feat(kernel): test direction files`**
  - Files:
    - New `packages/kernel/src/test-evidence/direction.ts` (`parseTestDirection`, `serializeTestDirection`, `testFromDirection`).
    - New `test-evidence/index.ts`; kernel `index.ts` re-export.
    - New `templates/test-directions/{unit,integration,regression,benchmark,playwright,e2e,code-size,typecheck}.yaml` (design §4.3).
    - New `direction.test.ts`: parses every template; id equals file stem.
  - Validate: K; V `packages/kernel/src/test-evidence/direction.test.ts`.

- [ ] **C6 `feat(kernel): test run records, baselines and per-user paths`**
  - Files:
    - New `test-evidence/types.ts` (`TestRunRecordV1`, `TestBaselineV1`, reason codes).
    - New `test-evidence/paths.ts` (`testEvidencePaths`, `ensureTenonDir`; delegates to `multi-user`'s user root when exported).
    - New `test-evidence/record.ts` (`decodeTestRunRecord`, `decodeTestBaseline`, `publishTestRunRecord` via `atomicLinkPublish` `state/atomic-publish.ts:21-29`, `writeTestBaseline` via `atomicReplaceFile`, running marker create/read/reclaim, `selectArtifactDirsToPrune`).
    - New `record.test.ts`.
  - Validate: K; V `packages/kernel/src/test-evidence/record.test.ts`.

- [ ] **C7 `feat(kernel): test metrics and baseline comparison`**
  - Files: new `test-evidence/metrics.ts` (`readMetrics`, `flattenMetrics`, `evaluateMetricCriteria`) + `metrics.test.ts`.
  - Validate: K; V `packages/kernel/src/test-evidence/metrics.test.ts`.

- [ ] **C8 `feat(kernel): evaluate test evidence for a step`**
  - Files:
    - New `test-evidence/evaluate.ts` (`evaluateTestEvidence`, `listTestRuns`, `latestTestRun`, `testDigest`). It reads `runMetadata.runId` via `readCurrentRunRevision` (pattern `state/document-step-visit.ts:5-11`).
    - New `evaluate.test.ts`: all design §14 kernel/evaluate assertions.
  - Validate: K; V `packages/kernel/src/test-evidence`.

- [ ] **C9 `feat(kernel): block forward transitions on required test evidence`**
  - Files:
    - `workflow/transition-application-types.ts`: deps `testEvidence?` (`:14-45`); result `test-evidence-failed` (`:70-122`).
    - `workflow/transition-application.ts`: evaluate after documents (`:329-362`), before review (`:363-381`); backward-edge predicate over `plan.workflow.steps` order.
    - Extend `transition-application.test.ts`.
  - Validate: K; V `packages/kernel/src/workflow/transition-application.test.ts packages/kernel/src/workflow/implicit-completion.test.ts`.
  - **Rollback point R2:** reverting C9 removes enforcement; recording keeps working.

- [ ] **C10 `feat(kernel): render the verification report tests region`**
  - Files: new `test-evidence/report.ts` (`renderTestsRegion`, `replaceTestsRegion`) + `report.test.ts`.
  - Validate: K; V `packages/kernel/src/test-evidence/report.test.ts`.

### CLI

- [ ] **C11 `feat(cli): bounded test process runner`**
  - Files: new `packages/cli/src/test-runner/process.ts` (`runTestProcess`) + `process.test.ts` (real `/bin/sh`).
  - Reuse patterns: detached spawn + group kill `automation/src/triage/codex-provider.ts:74-127`; tail buffer `automation/src/runner/boundedTail.ts:10-41`. Copy the pattern; do not import automation into cli unless `check:architecture` allows it.
  - Validate: B; V `packages/cli/src/test-runner/process.test.ts`; `npm run check:architecture`.

- [ ] **C12 `feat(cli): collect test inputs, outputs and artifacts`**
  - Files: new `test-runner/collect.ts` (`collectTestInputs`, `collectTestOutputs`, env HMAC key under `local/env.key`) + `collect.test.ts`.
  - Validate: B; V `packages/cli/src/test-runner`.

- [ ] **C13 `feat(cli): tenon test run`**
  - Files:
    - New `packages/cli/src/program-tests.ts` (`registerTestCommands`).
    - `program.ts`: register next to `registerReviewCommands` `:172`.
    - New `commands/test-run.ts`, new `testEvidenceContext.ts`.
    - `deps.ts` (`testProcess?`) and `main.ts` wiring.
    - `integration-harness.ts`: identity env and `testProcess` passthrough.
    - New `test-evidence.integration.test.ts` (run pass/fail, record location, second user dir, concurrent marker, output-missing).
    - `docs/usage/cli-reference.md` and `docs/usage/zh-CN/cli-reference.md` (`tenon test run`).
  - Validate: B; V `packages/cli/src/test-evidence.integration.test.ts`; `npm run check:docs`.

- [ ] **C14 `feat(cli): tenon test status, baseline, report, code-size`**
  - Files:
    - New `commands/test-status.ts`, `commands/test-baseline.ts`, `commands/test-report.ts`, `commands/test-code-size.ts` + `test-code-size.test.ts`.
    - `program-tests.ts`.
    - Extend the integration test: status JSON, baseline regression, report `--write` idempotent, retention 5 of 7.
    - Both CLI reference docs.
  - Validate: B; V `packages/cli/src/test-evidence.integration.test.ts packages/cli/src/commands/test-code-size.test.ts`; `npm run check:docs`.

- [ ] **C15 `feat(cli): test evidence in tenon check and transition output`**
  - Files:
    - `commands/check.ts`: default path `:183-215`, graph path `:300-325`, `[FAIL] test:`.
    - `commands/transition.ts`: deps `testEvidence` near `:140`, render near `:281-284`.
    - Extend the integration test: transition blocked → fixed → stale after source edit → rerun → applied; `review request` blocked with no receipt.
  - Validate: B; V `packages/cli/src/test-evidence.integration.test.ts packages/cli/src/track-branch.integration.test.ts packages/cli/src/document-record.integration.test.ts`.
  - **Rollback point R3.**

- [ ] **C16 `feat(cli): sync builtin test directions on setup and update`**
  - Files:
    - New `packages/cli/src/runtime/builtin-test-directions.ts` (`syncBuiltinTestDirections(payloadRoot, configRoot)`: stage into a temp dir, then rename-swap `builtin/`; `custom/` untouched). Reuse a shared builtin-library helper if `instruction-templates` / `review-agents` already added one.
    - `runtime/installer.ts`: call after `stageAndActivate`, inside `activateWithinTransaction` `:41-72`.
    - New `builtin-test-directions.test.ts`; extend `release-store.integration.test.ts`.
  - Validate: B; V `packages/cli/src/runtime/builtin-test-directions.test.ts packages/cli/src/runtime/release-store.integration.test.ts`.
  - **Rollback point R4.**

### Server

- [ ] **C17 `feat(server): test evidence on transitions and in snapshots`**
  - Files:
    - `packages/server/src/transition.ts`: `testEvidence` context `:241-262` and status mapping.
    - New `testEvidenceSnapshot.ts` (`projectTestEvidence`) and new `testCandidateCache.ts`.
    - `snapshotProjectScan.ts` `:118-164`; `types.ts` `:37-80`; `snapshotFingerprint.ts` `:66-78`.
    - New `testEvidenceSnapshot.test.ts`; extend `server.test.ts` (transition blocked, SSE fingerprint).
  - Validate: B; V `packages/server/src/testEvidenceSnapshot.test.ts packages/server/src/server.test.ts`.

- [ ] **C18 `feat(server): test run, artifact and direction routes`**
  - Files:
    - New `serverGetTestRoutes.ts`, chained in `serverGetRoutes.ts` `:116-396`.
    - New `serverTestDirectionRoutes.ts`: GET in the GET chain, PUT/DELETE in `serverMutationRoutes.ts` `:124,303`.
    - Extend `server.test.ts`. Pass the token as `reqPost(port, path, body, { headers: { Authorization: … } })` (`.trellis/spec/server/backend/workflow-branches-and-skill-files.md` §6).
  - Validate: B; V `packages/server/src/server.test.ts`.

### Dashboard

- [ ] **C19 `feat(dashboard): test evidence types, decoders and clients`**
  - Files:
    - `packages/dashboard-app/src/types.ts`.
    - `api/snapshotDecoder.ts`: `decodeTests` (pattern `:56-72`).
    - New `api/testEvidenceClient.ts`, new `api/testDirectionsClient.ts`.
    - `api/governanceTypes.ts` `:102-114`; `api/governanceSchema.ts` `:384-413`.
    - New `workspace/stageTests.ts`.
    - Tests: `api/boundaryDecoders.test.tsx`, `api/governanceSchema.test.tsx`, new `workspace/stageTests.test.tsx`.
  - Validate: W `boundaryDecoders governanceSchema stageTests`.

- [ ] **C20 `feat(dashboard): 测试 sheet and run drawer in the workspace`**
  - Files:
    - New `workspace/StageTestsPanel.tsx`, `workspace/TestRunDrawer.tsx`.
    - `workspace/TaskDetailPane.tsx` `:54,111-126`.
    - `shared/DetailSheets.tsx` (`count: number | string` if not yet widened).
    - `i18n/translations.ts` (`workspace.*` keys).
    - New `StageTestsPanel.test.tsx`, `TestRunDrawer.test.tsx`.
  - Validate: W `StageTestsPanel TestRunDrawer i18n taskModel`; `npm run check:design-scale`.

- [ ] **C21 `feat(dashboard): edit step tests in the workflow page`**
  - Files:
    - New `workflow/TestsSection.tsx`, `workflow/TestEditorDrawer.tsx`.
    - `workflow/StageEditorPane.tsx`: section between 输出 `:162-165` and 门禁 `:167-193`.
    - `workbench/workbenchDefinition.ts` (`setStepTestsInDef`, `testFromDirection`).
    - `workbench/useWorkflowEditor.ts` (`setTests` near `:355-357`).
    - `workflow/lint.ts`; `i18n/translations.ts` (`workflow.*`).
    - New `TestsSection.test.tsx`, `TestEditorDrawer.test.tsx`; extend `StageEditorPane.test.tsx`.
  - Validate: W `TestsSection TestEditorDrawer StageEditorPane governanceSchema i18n`; `npm run check:design-scale`.

- [ ] **C22 `feat(dashboard): 测试方向 in the library page`**
  - Files: new `library/TestDirectionsPane.tsx` + test; library shell registration (owned by `instruction-templates`); `i18n/translations.ts` (`library.*`).
  - Validate: W `TestDirectionsPane i18n`.

### Hosts, templates, removal, spec

- [ ] **C23 `feat(hooks): nudge self-run test commands and guard record files`**
  - Files:
    - New `hooks/test-nudge.sh`.
    - `hooks/hooks.json` PostToolUse `*` block `:45-52`.
    - `hooks/gate.sh`: record/baseline write deny before marker logic (pure `case`).
    - `tools/test-hooks.sh`: new section after `10.` (`:1532`); no-interpreter assertion pattern `:500-517`; `hooks.json` id assertion pattern `:1986`.
  - Validate: `bash tools/test-hooks.sh`; `bash tools/verify-skills.sh`.
  - **Rollback point R5.**

- [ ] **C24 `feat(templates,skills): default tests for frontend and backend`**
  - Files:
    - `templates/workflows/default.yaml`: frontend build `:344-369` + verify `:370-399`; backend build `:493-518` + verify `:519-544`; design §10.
    - `skills/tenon/SKILL.md`: new `## 测试（硬规则）` after `:198-204`.
    - `skills/tenon-build/SKILL.md` `:285-293`; `skills/tenon-verify/SKILL.md` `:104-111`.
  - Validate:
    - `npm run generate:default-workflow` locally, **do not stage the generated file**.
    - V `packages/kernel/src/workflow/generate-default-workflow.test.ts packages/kernel/src/workflow/default-artifacts.test.ts packages/kernel/src/workflow/track-branch.test.ts`.
    - `npm run check:default-skill-matrix`; `bash tools/verify-skills.sh`; `npm run check:identity`.
  - **Rollback point R6.**

- [ ] **C25 `refactor: remove the unused verification evidence composer`**
  - Files:
    - kernel: `packages/kernel/src/verification/evidence-composer.ts`, `evidence-composer.test.ts`, re-exports `verification/index.ts:16-18,28`.
    - server: `packages/server/src/serverPostVerificationRoutes.ts`, `serverPostRoutes.ts:78,196`, `server.test.ts:2121-2270`.
    - dashboard: `api/verificationEvidenceClient.ts`, `api/verificationEvidenceTypes.ts`, `api/verificationEvidenceDecoders.ts`, `api/verificationEvidenceClient.test.tsx`, `api/client.ts:101-104,180-187`, `i18n/i18n.test.tsx:192`.
  - Validate:
    - `grep -rn "evidence-composer\|VerificationEvidenceCompos\|verification-evidence/compose\|verificationEvidence" packages --include='*.ts' --include='*.tsx' | grep -v /dist/` → empty.
    - B; `npm test`; `npm run test:web`; `npm run check:architecture`.
  - **Rollback point R7.**

- [ ] **C26 `docs(spec): test evidence contract`**
  - Files:
    - New `.trellis/spec/kernel/backend/test-evidence.md` (7-section format like `state-lock.md`: schema, runner, freshness, guard, error matrix, tests, wrong/correct) + row in `.trellis/spec/kernel/backend/index.md`.
    - `.trellis/spec/dashboard-app/frontend/component-guidelines.md`: 测试 section and sheet rules.
    - `.trellis/spec/guides/index.md`: host checklist line for test commands under the Codex sandbox.
  - Validate: `npm run check:docs`.

- [ ] **C27 Real host acceptance (no product code)**
  - Scenario per `prd.md` acceptance.
  - In Claude Code and in Codex, one real task each on a custom workflow:
    - build step: `unit`;
    - verify step: `regression` + `playwright` + `benchmark` + a new direction.
    - Codex runs Playwright escalated.
  - Also cover: a second identity; a failed Playwright run with screenshot and trace opened in the drawer; the report region generated.
  - Record commands, run ids and screenshots in `research/real-host-acceptance.md` of this task.

---

## 2. Risky files and rollback points

| Risk | Files | Why risky | Rollback |
| --- | --- | --- | --- |
| Build revision trust | `kernel/src/workspace/fingerprint.ts` | Every in-place build token depends on it | Revert C1; tokens return to the current value; records written after revert go stale (acceptable) |
| Workflow fingerprint stability | `kernel/src/workflow/compile.ts`, `parse.ts`, `serialize.ts` | A key emitted for workflows without tests would break every bound change (`effective-plan.ts:394-406`) | Golden fingerprint test in C4; revert C2–C4 (R1) |
| Every transition | `kernel/src/workflow/transition-application.ts` | Blocking bug stops all tasks | Revert C9 (R2); `tenon check` still reports via C15 unless C15 is reverted too (R3) |
| Installer transaction | `cli/src/runtime/installer.ts` | Activation failure rolls back a release | Sync runs after `stageAndActivate` and inside the existing try/revert; revert C16 (R4) |
| Hook hot path | `hooks/gate.sh`, `hooks/hooks.json` | Every tool call in both hosts | Pure bash only; revert C23 (R5) |
| Default workflow | `templates/workflows/default.yaml` | Non-npm projects on frontend/backend tracks get blocked | Isolated commit C24 (R6); users edit the global default override |
| Removal | C25 file set | Hidden importer | Grep gate in C25 validation; revert C25 (R7) |
| Process runner | `cli/src/test-runner/process.ts` | Orphaned processes, huge logs | Group kill + caps tested with real shell in C11 |

---

## 3. Shared gates before handing the branch to the main session

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity && npm run check:docs
npm run check:design-scale && npm run check:default-skill-matrix
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
```

(Parent `implement.md:24-30`. `check:default-workflow-freshness` and `check:dashboard-dist-freshness` are run by the main
session after regenerating.)

---

## 4. Overlap files with other children and merge notes

| File(s) | Also changed by | Merge note |
| --- | --- | --- |
| `kernel/src/workflow/types.ts`, `ir.ts` | `review-agents` (`agents`, removes `reviewLanes`), `workflow-io-openspec` (`openspec`, per-track `document_contract`, slot `scope`/`role`) | Additive: `tests?` after `artifacts` in `StepDef` / `StepIR`. Keep types in separate interfaces. |
| `kernel/src/workflow/parse.ts` (`parseStep` `:217-291`) | `review-agents` (drops `review_lanes` `:258-269`, adds `agents:`), `workflow-io-openspec` (top-level `openspec`, branch `document_contract` in `parseTracksBlock` `:402-442`) | Each child adds its own `if (/^\s*<key>:/)` branch. Keep all branches; order inside the loop is irrelevant. |
| `kernel/src/workflow/serialize.ts` (`serializeStep` `:151-169`) | same | Canonical step order: `id, label, gate, prompt, skills, agents, inputs, outputs, artifacts, tests, guards, transitions` (with `review_lanes` gone after `review-agents`). |
| `kernel/src/workflow/compile.ts` (`STEP_KEYS` `:48-50`, `compileStep` return `:249-253`) | `review-agents`, `workflow-io-openspec` | Union of keys. Each optional key is spread only when present, so fingerprints stay byte-identical. If another child makes a key always present, update the C4 golden value in the same merge. |
| `kernel/src/workflow/validate.ts` | `review-agents` (agent reference checks), `workflow-io-openspec` (per-track contract) | Independent function calls inside the branch loop. |
| `kernel/src/workflow/transition-application.ts`, `-types.ts` | `review-agents` (reviewer guard), `multi-user` (owner / actor) | Evaluation order: document evidence → **test evidence** → reviewer results → review receipt. Reviewers run after required tests (`review-agents/prd.md:47`). One new result kind per child. |
| `kernel/src/workspace/fingerprint.ts` | `multi-user` | Whoever lands first adds `.tenon`; the other drops the duplicate line. |
| `cli/src/program.ts`, `deps.ts`, `main.ts`, `integration-harness.ts` | `multi-user`, `review-agents`, `task-delete-archive` | Registration lines are additive. The harness identity env comes from `multi-user`; reuse it. |
| `cli/src/commands/check.ts`, `commands/transition.ts` | `review-agents` (`[FAIL] agent:`), `workflow-io-openspec` (document lines) | Keep one `total` sum including every blocker family. |
| `cli/src/runtime/installer.ts` | `review-agents` (builtin agents), `instruction-templates` (builtin templates), `design-resources` (builtin catalog) | Prefer one shared `syncBuiltinLibrary(kind)` helper. If a sibling merged one, C16 calls it instead of adding `builtin-test-directions.ts`. |
| `server/src/snapshotProjectScan.ts`, `types.ts`, `snapshotFingerprint.ts` | `review-agents` (agent runs), `multi-user` (owner, actor), `task-delete-archive` (archived view) | Additive `Promise.all` members and optional fields. |
| `server/src/serverGetRoutes.ts`, `serverMutationRoutes.ts`, `serverPostRoutes.ts` | `review-agents`, `instruction-templates`, `design-resources` (library routes); C25 removes the composer import and mount | Chain order is irrelevant. Resolve C25 deletions against sibling additions by hand. |
| `server/src/transition.ts` | `multi-user`, `review-agents` | Additive deps on `createTransitionApplication`. |
| `dashboard-app/src/workspace/TaskDetailPane.tsx` | `workflow-io-openspec` (removes `ArtifactCatalogPanel` `:110`, output counts), `review-agents` (agent status), `multi-user` (operators) | Take their removal. The sheet union gains `tests`. |
| `dashboard-app/src/shared/DetailSheets.tsx` | `workflow-io-openspec` (`输出 n/m`) | One `count: number \| string` change. Do not duplicate. |
| `dashboard-app/src/workflow/StageEditorPane.tsx`, `workbench/useWorkflowEditor.ts`, `workbench/workbenchDefinition.ts`, `workflow/lint.ts`, `api/governanceTypes.ts`, `api/governanceSchema.ts` | `workflow-io-openspec` (+ 输出, OpenSpec toggle), `review-agents` (executors, reviewers) | 测试 stays between 输出 and 门禁. Other children place their own sections. Mutators and decoders are additive. |
| `dashboard-app/src/types.ts`, `api/snapshotDecoder.ts`, `api/client.ts` | `review-agents`, `multi-user`; C25 removes composer re-exports | Additive decoders; resolve deletions by hand. |
| `dashboard-app/src/i18n/translations.ts` | all UI children | Keep namespaces; no `*_note/_desc/_lead/_hint` keys in `workspace` / `workflow`. |
| Library page shell (`dashboard-app/src/library/*`) | `instruction-templates` (owner), `review-agents`, `design-resources` | C22 only adds `TestDirectionsPane` and one registration entry. |
| `templates/workflows/default.yaml` | `data-driven-runner` (wave 4 rewrite), `review-agents` (verify reviewers), `design-resources` (DESIGN.md slots) | C24 touches only `tests:` blocks in frontend and backend build/verify. `data-driven-runner` rebases onto it and keeps the blocks. |
| `hooks/gate.sh`, `hooks/hooks.json`, `tools/test-hooks.sh`, `hooks/active-change.sh` | `review-agents` (per-reviewer skill gate `gate.sh:411-435`), `multi-user` (per-user active change) | The C23 deny rule is a self-contained `case` block near the top. `test-nudge.sh` uses whichever active-change resolver `multi-user` ships. |
| `skills/tenon/SKILL.md`, `skills/tenon-build/SKILL.md`, `skills/tenon-verify/SKILL.md` | `data-driven-runner` (deletes phase skills, rewrites `tenon`), `review-agents` (verify reviewer prose) | Keep the `## 测试（硬规则）` section when `data-driven-runner` rewrites `tenon`; phase-skill edits disappear with those files. |
| `docs/usage/cli-reference.md`, `docs/usage/zh-CN/cli-reference.md` | `multi-user`, `task-delete-archive`, `review-agents` | Additive command sections. |
| `.gitignore` / `.tenon/.gitignore` | `multi-user` | See CCR-3 in design. |
| (behavior) task deletion | `task-delete-archive` | Delete must remove `.tenon/users/*/tests/<change>/` and `.tenon/users/*/local/{artifacts,running}/<change>/` (design §10). |

---

## 5. Size

| Area | Production (LOC) | Tests (LOC) | Commits |
| --- | --- | --- | --- |
| Kernel | ~1,450 | ~1,300 | C1–C10 |
| CLI | ~1,150 | ~950 | C11–C16 |
| Server | ~650 | ~500 | C17–C18 |
| Dashboard | ~1,350 | ~750 | C19–C22 |
| Hooks | ~130 | ~90 | C23 |
| Templates / skills / docs / spec | ~450 | — | C24, C26 |
| Removal | −~1,100 | −~450 | C25 |

Net ≈ +5,200 production / +3,600 test lines, 26 code commits plus real-host acceptance. This is a large child; plan roughly
3 parallelizable streams after C10: CLI (C11–C16), server (C17–C18), dashboard (C19–C22), then C23–C27.

---

## Deviations

| # | Design says | Implemented | Why |
| --- | --- | --- | --- |
| D-1 | §5.1 `testEvidencePaths(repoRoot, slug)` as this child's own per-user helper | Path fields (`runningDir`, `envKey`) were added to `multi-user`'s `userProjectPaths`; `test-evidence/paths.ts` only derives per-change paths from it | Parent X10: children add their own fields to `userProjectPaths` instead of parallel helpers |
| D-2 | §5.8 run ids "sort by time", so the newest record is the greatest run id | `listTestRuns` orders by `finished_at` and uses the run id only as a stable tie-break | Within one second, run ids differ only by their random suffix, so id order is arbitrary; a rerun in the same second must still win. `selectArtifactDirsToPrune` now takes an already time-ordered list instead of re-sorting by id |
| D-3 | §9.2 the nudge scans `.pipeline-workflow-plan.json` for a command match | Same, plus: every variable next to a full-width punctuation mark is `${}`-delimited | In this locale bash accepts the leading byte of `；` as part of an identifier, so `$IDS；` resolved to an unbound variable |
| D-4 | §7.2 the test routes are chained individually into `serverGetRoutes.ts` | One `handleTestGetRoutes` entry point covers runs / run / artifact / directions | `serverGetRoutes.ts` sits at the 400-line HTTP limit; one entry point keeps it inside the limit |
| D-5 | §11.2 the library page mounts `TestDirectionsPane` into an existing rail shell | The rail gained its `section` state here (模板 / 测试方向) because `instruction-templates` shipped a single-section rail | The pane cannot be reached without a section switch; the shell change is 20 lines and the rail card contract is unchanged |
| D-6 | Parent implement.md: generated files stay out of the branch | `templates/skill-sources.yaml` **is** committed (C24) | Editing a `SKILL.md` without re-syncing provenance makes `tools/verify-skills.sh` fail with a content-hash mismatch, so the sync belongs in the same commit |
| D-7 | C27 real-host acceptance | Not run | Parent X18: wave 5 runs real Claude Code / Codex acceptance on `main` |

### Post-merge wiring

| Item | Action |
| --- | --- |
| Archived Change refusal (parent §7) | Replace `archivedForUser` in `packages/cli/src/commands/test-context.ts` with `refuseArchived(deps, name)` from `packages/cli/src/archivedGuard.ts`. It is the only archive call site in the `tenon test` family; the branch was cut before task-delete-archive merged, so it is a constant `false` here. The server test routes are read-only and need no refusal |
| Generated default workflow | `npm run generate:default-workflow` (see below) |
| Task deletion | Physical delete must also remove `.tenon/users/*/tests/<change>/` and `.tenon/users/*/local/{artifacts,running}/<change>/` (design §10) |

### Known red on this branch (by instruction)

`packages/kernel/src/workflow/generate-default-workflow.test.ts` fails because C24 changed
`templates/workflows/default.yaml` while its instruction says not to stage
`packages/kernel/src/workflow/default-workflow.generated.ts`. One command after merge makes it green:

```bash
npm run generate:default-workflow
```
