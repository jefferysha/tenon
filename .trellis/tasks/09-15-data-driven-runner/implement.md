# Implement: single data-driven `tenon` skill

Wave 4 (parent `implement.md`): starts after review-agents, test-evidence, upstream-skills, workflow-io-openspec and
design-resources are merged on `main`. Branch `feat/data-driven-runner` in its own worktree. No generated files
(`dist`, `default-workflow.generated.ts`, `templates/skill-sources.yaml`) in branch commits except where a commit says
"regenerate"; the main session regenerates after merge.

Per-commit baseline: `npm run build:packages` plus the listed commands.

## Checklist (ordered, small verifiable commits)

### 0. Spike: upstream OpenSpec against a Tenon Change (research only)

- [ ] In a scratch copy of the E2E seed, `tenon init demo --track backend`, write a delta spec, then run
      `openspec status --change demo --json`, `openspec validate demo --strict`, `openspec archive demo --yes --json` in a
      temp copy; load upstream `openspec-propose` text and note every command it runs against an existing change.
- [ ] Write `.trellis/tasks/09-15-data-driven-runner/research/openspec-upstream-compat.md` (commands, outputs, whether
      `.openspec.yaml`/`openspec/config.yaml` is needed, adaptation rules for §3.8).
- Validation: file exists; findings either confirm design §4.2/§3.8 or open a design amendment before step 1.
- Rollback: none (docs only).

### 1. Kernel: retired-skill detection (additive)

- [ ] `packages/kernel/src/workflow/retired-skills.ts` + `retired-skills.test.ts`; export from `packages/kernel/src/index.ts`.
- Validation: `npx vitest run packages/kernel/src/workflow/retired-skills.test.ts`; `npm run check:architecture`.

### 2. CLI: `tenon spec apply` (additive)

- [ ] `packages/cli/src/commands/specApply.ts` (new), register in `packages/cli/src/commands/spec.ts` and
      `packages/cli/src/program.ts:216` family; receipt writer `.pipeline-spec-apply.json`; `applied-spec.md` via the
      document presentation renderer.
- [ ] `packages/cli/src/spec-apply.integration.test.ts` (dry-run, apply, no-op, exit 2/3/4).
- Validation: `npx vitest run packages/cli/src/spec-apply.integration.test.ts`; `npm run check:comments`.
- Risk: temp copy must preserve symlinks/modes; reuse ideas from `tools/spec-migration-cas.mjs` (not shipped, do not import).

### 3. CLI: structured exit report (refactor, no behavior change)

- [ ] Extract `evaluateStepExitReport` from `packages/cli/src/commands/check.ts:140-212` and verify-fail readiness from
      `packages/cli/src/commands/review.ts:79-118` into `packages/cli/src/commands/stepExitReport.ts`; `cmdCheck` renders it.
- Validation: `npx vitest run packages/cli/src/commands/check.test.ts packages/cli/src/commands/review.integration.test.ts`;
  `npm run oracle`.
- Rollback point A (tag `ddr-a`): additive/refactor only.

### 4. CLI: `status <change> --json` step block

- [ ] `packages/cli/src/commands/statusStep.ts` (pure builder: plan, state, history, ledger, exit report, agent/test status
      readers, env) + `statusStep.test.ts` covering every `next` rule of design §4.1.
- [ ] `packages/cli/src/commands/status.ts`: add `step` in single-change JSON only; `status.test.ts` anchors.
- [ ] `packages/cli/src/commands/field-values.ts`: `RECOMMENDED` + computed `direct_override`.
- Validation: `npx vitest run packages/cli/src/commands/status*.test.ts`; `npm run check:architecture`.
- Risk: status becomes slower in verify (build revision assessment); keep list mode untouched.

### 5. Kernel/CLI: retired refusal wiring + coverage hint

- [ ] `packages/kernel/src/workflow/transition-application.ts` + `transition-application-types.ts`: rejection
      `retired-skills`; `packages/cli/src/commands/transition.ts:277` mapping; `packages/server/src/transition.ts:195` mapping.
- [ ] `packages/cli/src/commands/init.ts`, `check.ts`: refuse retired references.
- [ ] `packages/kernel/src/flow/guard.ts:263` hint; `guard.test.ts`.
- Validation: `npx vitest run packages/kernel/src/flow/guard.test.ts packages/cli/src/commands/transition.test.ts packages/cli/src/commands/init.test.ts packages/server/src/server.test.ts`.

### 6. Kernel: document producers accept `tenon` (additive)

- [ ] `packages/kernel/src/workflow/document-contract.ts`: add `tenon` next to every `tenon-<phase>` candidate and to
      `applied-spec`.
- [ ] `document-ledger.test.ts`: `tenon` accepted at each mutable step.
- Validation: `npx vitest run packages/kernel/src/state/document-ledger.test.ts packages/cli/src/document-record.integration.test.ts`.

### 7. Data migration: default, simple, manifest (regenerate)

- [ ] `templates/workflows/default.yaml` per design §5.1–5.4 (block style; `review_lanes` already removed by review-agents).
- [ ] `npm run generate:default-workflow` → `packages/kernel/src/workflow/default-workflow.generated.ts`.
- [ ] `packages/kernel/src/workflow/builtin-workflows.ts` + `templates/workflows/simple.yaml` per §5.5.
- [ ] `templates/manifest.yaml` per §5.6; `packages/kernel/src/flow/manifest-derive.test.ts:190-197`;
      `tools/check-default-skill-matrix.mjs` header comment (no driver skills).
- [ ] `packages/kernel/src/workflow/document-contract-validation.ts:38-61`: drop `tenon-*` and apply groups.
- [ ] `packages/cli/src/commands/internalSkillGate.ts:243-266`: comments say "first declared skill" instead of phase entry.
- [ ] Fixture sweep for ids in kernel/cli/server/dashboard/automation tests listed in design §9.2; `tools/oracle/run.sh:422,569-571`
      (`tenon` producer + `Skill: tenon` evidence); `packages/cli/src/test-support.ts:458-465`.
- Validation: `npm run check:default-skill-matrix && npm run check:default-workflow-freshness && npm test && npm run test:web && npm run oracle`.
- Risky: `default.yaml` + generated file (hot overlap), `internalSkillGate.ts` (entry semantics), oracle parity.
- Rollback point B (tag `ddr-b`): revert this commit alone restores the old data with step 6 still additive.

### 8. Kernel: remove `tenon-<phase>` producers

- [ ] `document-contract.ts`: delete `tenon-*` candidates and `opsx:apply` aliases (`:40,51,55,62,80-101,316-317`),
      `document-contract-validation.ts:71-72`; `applied-spec` → `['tenon']`.
- [ ] Tests: rejections in `document-ledger.test.ts`, `skill-evidence.test.ts`, `transition-application.test.ts`.
- Validation: `npm test`; `npm run oracle`.

### 9. Skill: new `tenon`, delete the ten skills

- [ ] Rewrite `skills/tenon/SKILL.md` per design §3 (≤230 lines).
- [ ] Delete `skills/tenon-open`, `tenon-explore`, `tenon-spec`, `tenon-build`, `tenon-verify`, `tenon-ship`, `tenon-archive`,
      `simple-task`, `learn-record`, `tenon-researcher`.
- [ ] Delete `tools/generate-skill-interaction-contract.mjs`, `.node-test.mjs`, `templates/skill-interaction-contract.md`;
      edit `package.json` scripts `generate:interaction-contract`, `check:interaction-contract`, `check:identity`.
- [ ] `packages/cli/src/commands/doctor-skills.ts`: `checkWorkflowSkills`, derived Codex list, `integration:openspec-cli`;
      `doctor.ts` wiring; `doctor.test.ts`.
- [ ] `tools/check-docs.mjs:144-208,619` + `tools/check-docs.node-test.mjs:339-350` removed.
- [ ] `tools/verify-skills.sh:342-360` removed.
- [ ] `tools/test-hooks.sh:1850-2027`, `tools/test-adapters.sh:314,416-874` fixtures → `tenon`.
- [ ] `tools/test-bundle.sh:47-60,150-156` updated.
- [ ] Skill registry rows (`templates/skill-sources.yaml:8-17`) via upstream-skills' sync command (regenerate).
- [ ] `tools/sandcastle/tenon-afk-run.sh` / `packages/automation/src/runner/runner.ts:6` comments.
- Validation: `npm run build && npm run check:identity && npm run check:docs && bash tools/verify-skills.sh && bash tools/test-hooks.sh && bash tools/test-adapters.sh && bash tools/test-bundle.sh && npm test`.
- Risky: `tools/verify-skills.sh` fails installs when wrong; `check:identity` chain.
- Rollback point C (tag `ddr-c`).

### 10. Agents migration

- [ ] Add builtin `builder.md`, `researcher.md`, `design-quality.md` under the builtin agent source dir fixed by CCR-5.
- [ ] Delete `agents/`; `tools/test-bundle.sh:65-68` points at the builtin files; `tools/check-legacy-identity.mjs:13` list.
- Validation: review-agents' builtin install test (agent library written on install), `bash tools/test-bundle.sh`,
  `node tools/check-legacy-identity.mjs`.

### 11. Hooks, constitution, adapters

- [ ] `hooks/router.sh:720,736,748` wording: no "阶段 skill"; the tenon skill drives from `tenon status --json`.
      If router text is generated, edit `hooks/router-gen.mjs` / `packages/cli/src/commands/gen-router.ts` instead and regenerate.
- [ ] `templates/workflow.md` → ≤25 lines (design §2 last row).
- [ ] `adapters/cursor/install.sh:64`, `adapters/zed/install.sh:64`, `adapters/devin/install.sh:71` examples.
- [ ] `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` descriptions/defaultPrompt without "7-phase packaged skills".
- Validation: `bash tools/test-hooks.sh && bash tools/test-adapters.sh && npx vitest run packages/cli/src/commands/gen-router.test.ts`.

### 12. Docs and main specs

- [ ] `docs/usage/default-workflow.md:9-53` and `zh-CN/default-workflow.md:5-20`: per-track tables from data, no phase skills.
- [ ] `docs/usage/routing-and-workflows.md:62-68` + zh-CN; `documents-skills-and-evidence.md:11,27,54` + zh-CN;
      `custom-workflows-and-tracks.md` + zh-CN (step `prompt`, agents, tests, `tenon status --json` step);
      `cli-reference.md` + zh-CN (`status` step, `spec apply`).
- [ ] Release notes entry (both locales).
- [ ] `openspec/specs/workflow-skill-enforcement/spec.md:13-75`, `simple-task-routing/spec.md:48-95`,
      `plugin-distribution/spec.md:505-516`, `open-source-documentation-experience/spec.md:671`.
- Validation: `npm run check:docs && npm run check:openspec && npm run docs:check`.

### 13. Trellis specs

- [ ] `.trellis/spec/kernel/backend/skill-output-registration.md`: producer `tenon`, reload per visit.
- [ ] New `.trellis/spec/cli/frontend/status-step.md` (design §4.1 signature, contracts, matrix, tests); index row.
- [ ] `.trellis/spec/server/backend/snapshot-skill-runs.md`: no phase driver nodes.
- Validation: manual read; `npm run check:docs` if it scans `.trellis`.

### 14. Shared gates

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm run check:docs && npm run check:openspec && npm run check:default-skill-matrix && npm run check:default-workflow-freshness
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/test-adapters.sh && bash tools/test-bundle.sh && bash tools/verify-skills.sh
npm run oracle
```

## Overlap files and merge notes

| File | Other children | Note |
| --- | --- | --- |
| `templates/workflows/default.yaml`, `default-workflow.generated.ts` | review-agents (agents, lanes), test-evidence (tests), workflow-io-openspec (`openspec`, per-track contract), design-resources (design-md), task-delete-archive (label) | land last; rebuild YAML from design §5 tables on top of merged schema; regenerate generated file on `main` |
| `packages/kernel/src/workflow/document-contract.ts`, `document-contract-validation.ts`, `parse-document-contract.ts` | workflow-io-openspec, design-resources | producer edits only; CCR-3/4 must be implemented by them |
| `packages/cli/src/commands/internalSkillGate.ts` | review-agents (agent skill gate replaces lane gate) | comments only here |
| `packages/cli/src/commands/doctor-skills.ts`, `tools/verify-skills.sh`, `templates/skill-sources.yaml`, `packages/cli/src/test-support.ts` | upstream-skills | take their registry and payload layout; derive lists from data |
| `packages/cli/src/commands/check.ts`, `review.ts`, `transition.ts`, `packages/server/src/transition.ts` | review-agents, test-evidence (new guards) | extract report after their guards land; keep their blocker codes |
| `packages/kernel/src/flow/guard.ts`, `default-event-policy.ts` | review-agents (drops agent/codex result guards) | only the coverage message line here |
| `templates/manifest.yaml` | review-agents (`review_skills`) | this child owns `mandatory_skills`, `recommended_skills`, `breadcrumb` |
| `agents/`, `tools/test-bundle.sh` | review-agents | delete after builtin library install exists |
| `hooks/router.sh`, `templates/workflow.md` | multi-user (`.pipeline-active` → per-user pointer) | wording only; no pointer paths in the skill |
| `packages/cli/src/program*.ts` | several | one `spec apply` subcommand registration |
| `docs/usage/*` release notes | version-reset | append entries, do not touch version text |

## Risky files and rollback

- `templates/workflows/default.yaml` + generated: every default Change; rollback `ddr-b`.
- `document-contract.ts`: ledger acceptance for all governed Changes; steps 6 → 8 split so step 8 can be reverted alone.
- `tools/verify-skills.sh`: runs at install/SessionStart; a false failure blocks users; run `bash tools/verify-skills.sh --root <payload>` on the built payload.
- `hooks/router.sh`: UserPromptSubmit hot path; `tools/test-hooks.sh` and installed hooks smoke.
- `tools/oracle/run.sh`: dual-run parity; must stay 0 mismatches.

## E2E acceptance

### Prerequisites

- Candidate build installed on both hosts from this branch's release candidate (`install.sh --claude`, `install.sh --codex`);
  `tenon doctor` green except known AFK credential; `openspec --version` present.
- Seeds (fresh copy per run, under the scratchpad):
  - `task-board` (Node 22 lib, `npm test`) for backend and free (seed from `research/e2e-default-workflow-and-codex.md:5`).
  - `task-board-web` (Vite + React + Vitest + Playwright, valid root `DESIGN.md`) for frontend and pm.
  - Project test commands configured through the test-evidence mechanism: unit `npm test`, regression `npm test`,
    integration `npm run test:integration` (backend seed), playwright `npx playwright test`, code-size builtin.
- Frontend/backend Ship needs a real PR: one disposable private GitHub repo per seed, created only after the user approves;
  deleted after acceptance.
- Codex runs in disposable sandboxes with `codex exec --sandbox danger-full-access` (workspace-write denied `.git/index.lock`,
  `research/e2e-default-workflow-and-codex.md:62`), approved by the user.
- Identity set (`git config user.email`) so agent/test records carry `actor`.

### Runs

| Id | Host | Workflow / track | Prompt |
| --- | --- | --- | --- |
| F-C / F-X | Claude Code / Codex | default / frontend | 「为任务看板页面增加按优先级筛选的下拉框，并添加测试」 |
| B-C / B-X | Claude Code / Codex | default / backend | 「为任务看板实现 renameTask(board, id, title)，并添加单元和集成测试」 |
| P-C / P-X | Claude Code / Codex | default / pm | 「调研并设计任务看板的批量归档功能，产出原型与 PRD」 |
| R-C / R-X | Claude Code / Codex | default / free | 「用 free 轨道为任务看板实现 countOverdue(board)，并添加单元测试」 |
| W-C / W-X | Claude Code / Codex | Dashboard-built `flow-e2e` / `main` | 「为任务看板实现 reopenTask(board, id)，并添加测试」 |

`flow-e2e` is built in the Dashboard UI with Playwright: OpenSpec on; steps 设计 (openspec-propose ∥ writing-plans; outputs
proposal, tasks, delta-spec; gate 评审), 实现 (test-driven-development; executors 2 × `builder` parallel; test unit required;
`updates: tasks`; gate 自动), 验证 (verification-before-completion; reviewers `spec-consistency` ∥ `backend-quality` then
`architecture` depending on both; tests regression required; gate 评审; completes 完结). Saved YAML is checked against the editor.

### Per-step checks (every run, every step)

```bash
tenon workflow plan <c> --json | jq '.plan.workflow.steps[] | {id, skills: [.skills[].id], agents, tests}'
tenon status <c> --json | jq '.step | {id, next, exits}'
jq -r 'select(.kind=="tool" or .kind=="transition") | [.ts, .kind, (.raw // .to)] | @tsv' openspec/changes/<c>/.pipeline-history.jsonl
tenon document status <c> --json
cat openspec/changes/<c>/.pipeline-agent-runs.jsonl
ls .tenon/users/<slug>/tests/<c>/
```

Pass when, for the step: skill evidence rows equal the declared skills in `depends_on` order and include one `tenon` load
after the entering transition; recorded documents and producers equal `step.documents` (living refresh by `tenon`,
`applied-spec` by `tenon`); every declared test has a record with a real exit code bound to the current candidate; every
declared agent has a run with role, result and findings; review receipts exist for review gates; the Dashboard 工作台 shows
输出 n/m, 测试, agent runs and 操作人 matching disk.

End state: `archived: true`, `phase_status: done`, `tenon list --json` empty, `openspec/changes/archive/<date>-<c>/`
exists for governed workflows, main spec contains the delta, PR URL real for frontend/backend.

### Required behaviors inside the runs

- AC3 (YAML edit): after F-C completes, in the Dashboard add `vercel-react-best-practices←frontend-design` to default
  frontend build and remove test `code-size` from verify; start F2-C: its plan and executed evidence show the change, no skill
  file changed (`git diff --stat skills/` empty); an in-flight Change started before the edit keeps its frozen plan.
- AC4 gates (one each, recorded in the report):
  - Skill order: in B-X explore, request `grill-with-docs` before `brainstorming` → gate refuses naming the missing skill.
  - Document evidence: edit `tasks.md` after recording in R-C build → `transition` refused as stale until re-recorded by `tenon`.
  - Tests: in F-X build, `tenon transition build-complete` before `unit` passes → refused `test`.
  - Reviewer: plant a high-severity defect in B-C verify → required reviewer blocks; `choose-exit` takes `verify-fail`; after the fix the old run shows 过期 and the rerun passes.
  - Review gate: explore approved once in the Dashboard console and once in the terminal.
  - Build token: edit code after `build-complete` in R-X verify → test and reviewer records show stale; revision blocker on `verify-pass`.
  - OpenSpec: a requirement without SHALL/MUST in P-C spec → `tenon spec apply --dry-run` exit 2, fixed before the spec review.
- Simple: one typo prompt per host routes to `simple`: `change → verify → done` without skill evidence at `change`.
- Retired refusal: integration test only (no pre-migration host state exists).

### Report

Write `.trellis/tasks/09-15-data-driven-runner/research/e2e-data-driven-runner.md` with one table per run (step, skills,
documents, tests, agents, gate, result), defects found and fix commits, installed versions, and doctor output.

## Deviations

- **§4.2 `openspec validate --specs --strict` → per-capability strict re-validation.** Strict mode fails on
  warnings, and an unrelated capability with a brief `## Purpose` would block every apply forever. `tenon spec
  apply` now re-validates only the capabilities whose main spec actually changed
  (`openspec validate <cap> --type spec --strict`). Verified in the spike (`research/openspec-upstream-compat.md`).
- **§4.2 idempotency is decided before the rehearsal.** `openspec archive` is not idempotent: rehearsing the same
  change twice merges its requirements twice. `alreadyApplied` therefore answers "already applied" from the previous
  receipt plus the on-disk bytes, and only then is the rehearsal skipped. The receipt's `deltas[].sha256` are the
  current file digests, not the ledger's frozen ones, because `step.next` asks "does this receipt still match the
  delta spec on disk".
- **§4.2 `SpecApplyHooks`.** A CAS conflict only happens concurrently, so `cmdSpecApply` takes an optional
  test-only `afterRehearsal` hook to make exit 4 reachable. Production passes nothing.
- **§3 CCR-1 shape.** The shipped agent CLI is `prompt` + `record` (parent X1), so the skill's `run-agent` action
  is `agent prompt … --json` → host run → write the report → `agent record <run_id>`; there is no `--result` flag.
- **§3.6 `configure-test` dropped.** Parent X2 makes a step test's `command` required, so `unconfigured` cannot
  happen and the action has nothing to do.
- **Step 3 keeps `cmdCheck`'s rendering.** `evaluateStepExitReport` is a sibling of `cmdCheck` rather than the
  thing `cmdCheck` renders: the default path's human output is anchored to `deps.flow.guardCheck` (phase-shaped),
  while per-exit readiness needs `evaluateDefaultEventPreconditions` (edge-shaped, the same source `transition`
  uses). Both read kernel evaluators; no guard logic is duplicated.
- **No `depends_on` in `default.yaml`.** `default` runs the manifest-overlay skill policy, where slot order comes
  from the declaration order in `skills:` (plus the manifest table), not from `depends_on`. Writing `depends_on`
  there would be inert. Order is expressed by the declaration order instead; frontend build lists
  `test-driven-development` before `frontend-design`.
- **Track skill sets kept as waves 1–3 left them.** design §5.1–5.4 listed a narrower set than
  design-resources/test-evidence actually shipped (extra visual and e2e skills, pm `prototype`). Only the phase
  skills, `writing-plans` at build (D24) and `openspec-apply-change` / `openspec-archive-change` at ship were
  removed. Tests and agents were not touched (parent X16).
- **`chat` declares no skills** (design §5.4 / D11 wanted it equal to `free`). `chat` is the branch
  `compileEffectiveWorkflowPlan('default')` selects when no track is given — AFK loop wiring and the
  execution coordinate port both do that. Giving it upstream skill ids makes those paths depend on bytes that
  only exist after `tenon setup/update` fetches them, which fails on a clean checkout and in CI. Its document
  contract is unchanged, so chat output is still governed.
- **`recommended_skills` kept as an empty block.** `router-gen`/`loadManifest` require the key to be a block
  section; deleting the key or writing `{}` breaks the router hot path. The table has no rows.
- **`hooks/router.sh` `ROUTER_CONTRACT_REV` regenerated.** The manifest change moves
  `routerContractRevision(manifest)`, and the digest is pinned in the hook; without updating it the router
  fail-closes to silence. `packages/cli/src/commands/gen-router.test.ts` pins the two together.
- **The migration document table now mirrors the new producers.** `migrations/openspec-v1-document-policy.ts`
  exists for fingerprint equality with the shipped branches, so its producers became `tenon` too, and the V2
  snapshot test's pinned fingerprint moved with it. Pre-migration Changes are refused anyway (D10).
- **Release notes entry deferred.** Parent §10 gives the v0.1.0 notes to the main session in wave 5; adding an
  entry here would collide with version-reset's version text.
- **Real-host E2E deferred to wave 5** (parent X18). Every local gate was run instead.
