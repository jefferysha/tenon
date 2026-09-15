# Implementation plan: task-level agents

Wave 3 of the parent plan (`09-15-tenon-next-capabilities/implement.md`). Branch `feat/review-agents` in its own worktree.
Every commit below builds (`npm run build`) and passes its listed checks on its own. Design references are to
`design.md` in this directory.

## 0. Preconditions (before C1)

- [ ] Rebase on `main` with multi-user, workflow-io-openspec, instruction-templates, upstream-skills, test-evidence merged.
- [ ] Confirm the consumed interfaces exist and note their real names in `cli/src/commands/agent.ts` adapter comments:
      multi-user `resolveTenonUser` (+ owner check helper); test-evidence `requiredTestsReady` / `currentTestResults`
      (design §6.3), its candidate helper (design §5.3) and `parseInlineMap` (CCR-6); instruction-templates
      `syncBuiltinDir` and the `library` view (CCR-4, CCR-5). Missing ones are created by this branch as designed.
- [ ] Parent CCR-1…CCR-7 answered; if CCR-2 is refused, rename `.pipeline-frozen/` to `.pipeline-agents/` (lock + files)
      and nothing else changes.

## 1. Commits

### C1 `feat(kernel): agent file format and library`

- [ ] `packages/kernel/src/agents/agent-file.ts`, `library.ts`, `index.ts`; export from `packages/kernel/src/index.ts`.
- [ ] `packages/kernel/src/library/builtin-sync.ts` (skip if instruction-templates added it; call theirs).
- [ ] `templates/agents/{builder,researcher,architecture,frontend-quality,backend-quality,code-size,security,spec-consistency,e2e}.md`
      (content ported from `agents/*.md` per design §3.4; `agents/` itself is removed in C8).
- [ ] `tools/check-agents.mjs` + `package.json` script `check:agents` (every builtin parses; every skill id exists under
      payload `skills/`).
- [ ] Tests `agents/agent-file.test.ts`, `agents/library.test.ts`, `library/builtin-sync.test.ts`.

```bash
npx vitest run packages/kernel/src/agents packages/kernel/src/library
node tools/check-agents.mjs
npm run build && npm run check:architecture && npm run check:comments
```

### C2 `feat(workflow): step agents schema`

- [ ] `packages/kernel/src/workflow/types.ts` (`AgentSeverity`, `StepExecutorRef`, `StepReviewerRef`, `StepAgentsDef`,
      `StepDef.agents`), `ir.ts`, `parse.ts` (step `agents:` block, `parseStep` `:217-291`), `parse-primitives.ts`
      (`parseInlineMap`, reuse if present), `serialize.ts` (`serializeStep` `:151-169`), `compile.ts` (`STEP_KEYS` `:49`,
      `compileStep` `:201-254`), `validate.ts` (`validateBranchSteps` `:94-150`), `effective-plan.ts` +
      `effective-plan-types.ts` (`capabilities.agents`).
- [ ] Tests `workflow/agents-schema.test.ts`; extend `parse.test.ts`, `serialize.test.ts`, `compile.test.ts`,
      `track-branch.test.ts` (branch error prefix).

```bash
npx vitest run packages/kernel/src/workflow
npm run build
```

### C3 `refactor(review): delete review attempts and the lane skill gate`

- [ ] Delete `packages/kernel/src/state/review-attempt-budget.ts`, `review-attempt-budget-model.ts`,
      `review-attempt-budget-io.ts`, `review-attempt-budget.test.ts`, `review-attempt-budget.crossprocess.integration.test.ts`;
      remove exports `packages/kernel/src/state/index.ts:19-34`.
- [ ] Delete `packages/cli/src/commands/review-attempt.ts`, `packages/cli/src/review-attempt.integration.test.ts`;
      `packages/cli/src/program-review.ts` drops `registerAutomatedReviewCommands` (`:24,27-48`).
- [ ] `packages/cli/src/commands/internalSkillGate.ts`: delete `explicitReviewLane`, `requireActiveReviewAttempt`
      (`:91-153`) and the preflight call (`:192-197`); update `internalSkillGate.test.ts`.
- [ ] Delete manifest `review_skills`: `templates/manifest.yaml:62-65`, `packages/kernel/src/flow/manifest.ts:199-221,465-469,584-596`,
      `packages/kernel/src/workflow/effective-skill-resolver.ts:40,214` (+ tests `manifest-derive.test.ts`,
      `effective-skill-resolver.test.ts`).
- [ ] `skills/tenon-verify/SKILL.md`: remove Step 0.5 (`:74-102`) and the `review-attempt lane/complete` block
      (`:357-367`); no replacement text yet.

```bash
npx vitest run packages/kernel/src/flow packages/kernel/src/state packages/kernel/src/workflow packages/cli/src/commands/internalSkillGate.test.ts
npm run build && bash tools/verify-skills.sh && npm run check:default-skill-matrix
```

### C4 `refactor(workflow): delete review lanes, skill review kind and review budget`

- [ ] Kernel: `types.ts:50-54,61-69,177-178,202`; `parse.ts:228,258-269,288,302,337-341,372` (removed keys raise the
      design §4.3 error); `parse-skill-refs.ts:29-47`; `parse-policy.ts:33,72-73`; `policy.ts:140-147`;
      `serialize.ts:20-28,56-66,159-161,201`; `compile.ts:46,49,51,163-187,222-224,252,307,322`; `ir.ts:172,186`;
      `validate.ts:106-110`; `effective-plan.ts:111-113,116-133,143,158-159,172,189-239,266-290`;
      `effective-plan-types.ts:21,39-40,53-60`; `workflow-plan-snapshot-types.ts` (+ V4);
      `effective-plan-snapshot-compat.ts:80-141,215-281` (raw literal for history); `state/workflow-plan-snapshot.ts:53-110`
      (v4 key list); `builtin-workflows.ts:11,30-31`.
- [ ] Templates: `templates/workflows/default.yaml` per design §13.2 (remove `:2-4` and every `review_lanes`, add
      reviewers to frontend `:370-399` and backend `:519-544` verify); `templates/workflows/simple.yaml:2-4,24-28`.
      Do not commit `default-workflow.generated.ts` (main session regenerates).
- [ ] Dashboard: `api/governanceTypes.ts:45-46,107`; `api/governanceSchema.ts:108-118,389-405`;
      `workbench/workbenchDefinition.ts:301`; `workbench/skillWaves.ts:47` comment; `i18n/translations.ts:808-809,2740-2741`
      if unreferenced.
- [ ] Tests to update: `workflow/{effective-plan,policy,policy-codec,policy-snapshot,parse,serialize,compile,guard-handlers,transition-application,effective-skill-resolver}.test.ts`,
      `build-revision.acceptance.test.ts`, `state/store.test.ts`; CLI `init-workflow.integration.test.ts`,
      `integration.test.ts`, `track-registry.integration.test.ts`, `workflow-skill-orchestration.integration.test.ts`,
      `commands/{advance,check,transition}.test.ts`, `advance.integration.test.ts`; server `server.test.ts`,
      `snapshot.test.ts`; dashboard `api/governanceSchema.test.tsx`, `workflow/SkillFlow.test.tsx`,
      `workflow/workflowModel.test.tsx`, `App.test.tsx`, `inbox/evidence.test.ts`, `model/progressModel.test.tsx`.

```bash
npm run generate:default-workflow   # local check only; file not committed
npx vitest run packages/kernel packages/cli/src/init-workflow.integration.test.ts packages/cli/src/workflow-skill-orchestration.integration.test.ts
npm run test:web -- src/api/governanceSchema.test.tsx src/workflow
npm run build && npm run check:default-skill-matrix && npm run check:architecture
git checkout -- packages/kernel/src/workflow/default-workflow.generated.ts
```

Rollback point R1: C1–C3 are independent of snapshot changes; revert C4 alone if historical snapshot restore regresses.

### C5 `feat(state): freeze agents at change creation and the run ledger`

- [ ] `packages/kernel/src/state/agent-freeze.ts`, `packages/kernel/src/state/agent-runs.ts` (ledger, report parser);
      exports in `state/index.ts`.
- [ ] Creation sites call library load + `ensureAgentFreeze` before publishing the Change:
      `packages/cli/src/commands/init.ts` (near `:234`), `packages/server/src/serverPostChangesRoutes.ts` (near `:244`),
      `packages/automation/src/triage/workflow-run-create-repository.ts` (near `:350`),
      `packages/cli/src/commands/state-projection.ts:85-91`.
- [ ] Tests `state/agent-freeze.test.ts`, `state/agent-runs.test.ts`, crossprocess append test (pattern of the deleted
      review-attempt crossprocess test); `init-workflow.integration.test.ts` unknown agent → exit 1, no Change dir.

```bash
npx vitest run packages/kernel/src/state packages/cli/src/init-workflow.integration.test.ts packages/server/src/serverPostChangesRoutes
npm run build && npm run check:architecture
```

### C6 `feat(workflow): agent verdict and waves`

- [ ] `packages/kernel/src/workflow/agent-verdict.ts` (`projectStepAgents`, `evaluateStepAgents`, `nextAgentWave`,
      `isForwardExit`, `renderAgentBlocker`), pure, no fs.
- [ ] Test `workflow/agent-verdict.test.ts` covering every cell of design §5.5 and §6.2.

```bash
npx vitest run packages/kernel/src/workflow/agent-verdict.test.ts
npm run check:architecture
```

### C7 `feat(cli): tenon agent next, prompt, record`

- [ ] `packages/cli/src/program-agents.ts`, registration in `packages/cli/src/program.ts` (next to `:172`).
- [ ] `packages/cli/src/commands/agent.ts`, `agent-prompt.ts`; `candidate.ts` (rename of `review-candidate.ts` +
      `review-candidate.test.ts`, or switch to test-evidence's helper and delete).
- [ ] Tests `commands/agent.test.ts`, `packages/cli/src/agent.integration.test.ts` (design §15 CLI list, without
      guard assertions).

```bash
npx vitest run packages/cli/src/commands/agent.test.ts packages/cli/src/agent.integration.test.ts
npm run build && node packages/cli/dist/tenon.mjs agent next --help
```

### C8 `feat(guards): required agents before leaving a step; retire review fields`

- [ ] `packages/kernel/src/workflow/transition-application-types.ts` (`stepAgentBlockers`, `step-agents-incomplete`),
      `transition-application.ts` (after `:303-317`), `transition-readiness.ts` (`agents-incomplete`, context).
- [ ] `packages/cli/src/commands/transition.ts` (dep wiring near `:142-160`, render near `:277-280`, header comment `:41`),
      `packages/cli/src/commands/check.ts` (`:84-86`, `:88-222`, `:246-326`).
- [ ] `packages/server/src/workflowSnapshot.ts:285-296` passes `stepAgents`; `packages/dashboard-app/src/api/snapshotDecoder.ts`
      accepts `agents-incomplete` (same commit, CCR-7).
- [ ] Retire fields: `packages/kernel/src/flow/default-event-policy.ts:86-99,193-201`, `packages/kernel/src/flow/guard.ts:96-105`,
      `packages/kernel/src/flow/GUARD-RULES.md`, `packages/kernel/src/state/state-init.ts:103-104`,
      `packages/cli/src/commands/field-values.ts:21-22` (reject with `已删除`), `packages/server/src/orchestrationGraph.ts:206-210`,
      `packages/dashboard-app/src/i18n/translations.ts:490-491,2433-2434`, `tools/oracle/fixtures/default-guard-errors.sh`
      (+ `tools/oracle/tests/stub-cli.mjs` cases), `docs/CONTRACT.md` review-field lines.
- [ ] `skills/tenon-verify/SKILL.md`: replace lanes and field steps (`:143-248`, `:339-356`, `:406-420`) with the short
      loop `tenon agent next` → `prompt` per wave (host delivery design §8) → `record`; keep report/document steps.
- [ ] Move plugin agents: delete `agents/*.md` (ported in C1); `tools/test-bundle.sh:65-68` asserts
      `templates/agents/*.md` instead and that no root `agents/` exists.
- [ ] Tests: `review.integration.test.ts` (request refused), `agent.integration.test.ts` guard cases,
      `commands/{check,transition}.test.ts`, `transition-effects.integration.test.ts`, `flow/{default-event-policy,guard,flow}.test.ts`,
      `fields.test.ts`, `orchestrationGraph.test.ts`, `workflow/transition-application.test.ts`, dashboard decoder test.

```bash
npx vitest run packages/kernel/src/flow packages/kernel/src/workflow packages/cli packages/server/src/orchestrationGraph.test.ts packages/server/src/snapshot.test.ts
npm run test:web -- src/api
bash tools/oracle/run.sh && bash tools/test-bundle.sh && bash tools/verify-skills.sh
npm run build && npm run check:comments
```

Rollback point R2: revert C8 to remove all agent guards while keeping records, CLI and library (C1–C7).

### C9 `feat(gate): unlock agent skills only while the agent runs`

- [ ] `packages/cli/src/commands/internalSkillGate.ts` per design §9 (before `:218`).
- [ ] Tests `commands/internalSkillGate.test.ts`, `packages/cli/src/internal-skill-gate-hook.integration.test.ts`;
      `tools/test-hooks.sh` new section (agent skill blocked, then allowed with a running row). No change to `hooks/gate.sh`.

```bash
npx vitest run packages/cli/src/commands/internalSkillGate.test.ts packages/cli/src/internal-skill-gate-hook.integration.test.ts
npm run build && bash tools/test-hooks.sh
```

Rollback point R3: revert C9 alone; gate returns to plain step DAG.

### C10 `feat(server): agent library routes and agent runs snapshot`

- [ ] `packages/server/src/serverAgentRoutes.ts` (GET/POST/PUT/DELETE, references scan); dispatch in
      `serverGetRoutes.ts` (near `:253`), `serverMutationRoutes.ts`, `serverPostRoutes.ts`, `server.ts:330-343` unchanged
      shape.
- [ ] Agent existence check in `packages/server/src/workflows.ts:251` and `serverWorkflowYamlRoutes.ts:98`.
- [ ] `packages/server/src/agentRuns.ts`; call where `projectSkillRuns` is used (`snapshot.ts:33`), field on change in
      `changeSnapshot.ts:362-380` / `snapshotTasks.ts` as applicable.
- [ ] Tests `serverAgentRoutes.test.ts`, `agentRuns.test.ts`, `workflows.test.ts`, `runtimeWorkflowEditor.integration.test.ts`,
      `snapshot.test.ts`.

```bash
npx vitest run packages/server
npm run build
```

### C11 `feat(dashboard): step executors and reviewers`

- [ ] `api/governanceTypes.ts`, `api/governanceSchema.ts` (`agents`), `api/agentClient.ts`, `api/agentSchema.ts`.
- [ ] `workbench/workbenchDefinition.ts` (`setStepAgentsInDef`, `cloneSteps`), `workbench/useWorkflowEditor.ts`
      (`setAgents`), `workflow/lint.ts` (`agent-missing`).
- [ ] `workflow/StageEditorPane.tsx` sections, `workflow/SkillFlow.tsx` (`captionOf`), `workflow/skillFlowNodes.tsx`,
      `workflow/AgentComposer.tsx`, `i18n/translations.ts` workflow keys.
- [ ] Tests `workflow/StageEditorPane.test.tsx`, `workflow/AgentComposer.test.tsx`, `workflow/lint.test.tsx`,
      `api/governanceSchema.test.tsx`, workbench definition tests.

```bash
npm run test:web -- src/workflow src/workbench src/api
npm run check:design-scale && npm run build
```

### C12 `feat(dashboard): agent library`

- [ ] `library/AgentList.tsx`, `library/AgentDetail.tsx`, `library/useAgentLibrary.ts`, `library/AgentLibrary.test.tsx`;
      register the `agent` rail kind in the library view (or add `library` to `shell/views.ts:6` and `App.tsx` if absent);
      `i18n/translations.ts` library keys.

```bash
npm run test:web -- src/library src/App.test.tsx
npm run check:design-scale && npm run build
```

### C13 `feat(dashboard): workspace agent runs`

- [ ] `api/snapshotDecoder.ts` (`agentRuns`), snapshot types, `workspace/TaskDetailPane.tsx` (`stage-agents` after
      `:104-109`), `workspace/AgentRunDrawer.tsx`, i18n workspace keys; tests.

```bash
npm run test:web -- src/workspace src/api
npm run check:design-scale && npm run build
```

### C14 `docs(spec): agent library, runs, guards`

- [ ] New `.trellis/spec/kernel/backend/agent-runs.md` (freeze, ledger, verdict, CLI, errors, tests).
- [ ] Update `.trellis/spec/kernel/backend/workflow-track-branches.md:18` (`SkillRef { id; depends_on? }`, `agents`),
      `.trellis/spec/kernel/backend/index.md`, `.trellis/spec/cli/frontend/hook-guidelines.md` (agent skill gate scenario),
      `.trellis/spec/dashboard-app/frontend/component-guidelines.md` (section order, AgentComposer, library, workspace
      agents), `.trellis/spec/server/backend/index.md` + new `agent-library-routes.md`.

```bash
npm run check:docs
```

## 2. Final verification on the branch

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
bash tools/test-bundle.sh && node tools/check-agents.mjs && npm run check:design-scale
```

Real hosts (after data-driven-runner's `tenon` skill, or manually with the CLI in both hosts): custom workflow with
build executors ×2, build and verify reviewers 2 + 1 dependent, `code-size` with `reads_tests`; walk the prd acceptance
list in Claude Code and Codex from the officially installed build; record evidence under `research/e2e-*.md`.

## 3. Risky files and rollback points

| File | Risk | Guard / rollback |
| --- | --- | --- |
| `kernel/src/workflow/effective-plan.ts`, `effective-plan-snapshot-compat.ts`, `state/workflow-plan-snapshot.ts` | historical fingerprint restore of every existing Change (incl. 59 archived OpenSpec changes shown in the Dashboard) | snapshot tests + load every `openspec/changes/archive/*` in `snapshot.test.ts` style locally; R1 = revert C4 |
| `kernel/src/workflow/transition-application.ts`, `cli/src/commands/check.ts` | every transition and review request | integration tests for default + custom; R2 = revert C8 |
| `cli/src/commands/internalSkillGate.ts` | fail-open vs fail-closed; host lockout | hook tests; R3 = revert C9 |
| `dashboard-app/src/api/snapshotDecoder.ts` | strict decode drops whole Changes | full `npm run test:web`; ship with server change in one commit |
| `templates/workflows/default.yaml` | default governance, generated TS drift | `check:default-skill-matrix`; regenerate in main session |
| Change creation sites (`init.ts`, `serverPostChangesRoutes.ts`, automation triage) | creation aborted by library errors | unknown-agent tests; revert C5 requires reverting C6–C9 too |
| `tools/oracle/*` | legacy parity suite | run `tools/oracle/run.sh` in C8 |
| `kernel/src/types.ts` `FIELD_ORDER` | must **not** change (design §13.4) | grep review in C8 diff |

## 4. Overlap with sibling tasks and merge notes

| Sibling | Shared files | Merge note |
| --- | --- | --- |
| workflow-io-openspec (merged earlier) | `kernel/src/workflow/{types,parse,serialize,compile,validate,effective-plan,effective-plan-types}.ts`, `templates/workflows/default.yaml`, `dashboard-app/src/workflow/StageEditorPane.tsx`, `workspace/TaskDetailPane.tsx`, `workflow/lint.ts`, `api/governanceTypes.ts`, `api/governanceSchema.ts`, `workbench/workbenchDefinition.ts`, `kernel/src/workflow/transition-readiness.ts`, `api/snapshotDecoder.ts`, `server/src/workflows.ts`, `server/src/serverWorkflowYamlRoutes.ts`, `i18n/translations.ts` | Rebase C2/C4 on their per-track `document_contract` and `openspec` fields; insert 执行者/评审者 sections around their 输出 action; `stage-agents` goes after `stage-skills` where they removed the artifact block; readiness blocker union keeps both kinds |
| test-evidence (merged earlier) | same kernel workflow files (`tests:`), `workflow/parse-primitives.ts`, `cli/src/commands/review-candidate.ts`, `kernel/src/workflow/transition-application(-types).ts`, `cli/src/commands/{check,review,transition}.ts`, `flow/default-event-policy.ts`, `.pipeline-frozen/lock.json`, `server/src/{changeSnapshot,snapshot,workflowSnapshot}.ts`, `api/snapshotDecoder.ts`, `workspace/TaskDetailPane.tsx`, `workflow/StageEditorPane.tsx`, `skills/tenon-verify/SKILL.md`, `cli/src/program.ts` | Reuse their inline map parser and candidate helper; add `step-agents-incomplete` next to their test rejection; lock sections `agents` + `test_directions` in one file; section order 输入 → 技能 → 执行者 → 输出 → 测试 → 评审者 → 门禁 → 退回; `reads_tests` validation switches on only when their `tests` type exists |
| data-driven-runner (after) | `skills/tenon-verify/SKILL.md`, `skills/tenon-build/SKILL.md`, `skills/tenon/SKILL.md`, `templates/workflows/default.yaml`, `templates/workflows/simple.yaml`, `kernel/src/workflow/builtin-workflows.ts`, `templates/manifest.yaml`, `cli/src/commands/internalSkillGate.ts` (`:78-84`), `tools/test-bundle.sh`, `cli/src/commands/doctor-skills.ts` | They delete the phase skill text edited in C3/C8 and consume design §7–§8; they add default executors, `code-size`, tests; R5 (`agents/` into the library) is already done here |
| multi-user (merged earlier) | actor on records, owner checks in `cli/src/commands/agent.ts`, `.gitignore`, `i18n/translations.ts`, server route auth | Use `resolveTenonUser` and their owner helper; no own identity code |
| instruction-templates (merged earlier) | `kernel/src/library/builtin-sync.ts`, `shell/views.ts`, `App.tsx`, `library/*`, `cli/src/commands/setup.ts`, update success path | Reuse sync helper and view; add only the `agent` rail kind |
| upstream-skills (merged earlier) | skill ids in `templates/agents/*.md`, payload `skills/`, `tools/verify-skills.sh` | `check:agents` fails fast if a builtin agent names a skill without upstream; adjust the agent file, not the checker |
| version-reset | `kernel/src/types.ts` `FIELD_ORDER`, `tracks` `review_seed`, `tools/oracle/run.sh:120-124` | CCR-3: they remove the retired slots in their wire bump |

## 5. Size

About 14 commits. Additions ≈ kernel 1.4k + tests 1.2k, CLI 0.7k + tests 0.7k, server 0.5k + tests 0.4k, dashboard 1.6k +
tests 0.7k, templates/agents 0.5k; deletions ≈ 2.5–3k (review attempt store and CLI, lanes, budget, field guards, skill
prose). Net roughly +5k.
