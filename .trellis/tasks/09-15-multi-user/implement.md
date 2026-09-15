# Multi-user implementation plan

- **Read first:** `design.md` (this task) and every entry in `implement.jsonl`.
- **Branch:** `feat/multi-user` in its own worktree. This follows `09-15-tenon-next-capabilities/implement.md`.
- **Generated files stay out of commits:** `packages/cli/dist/tenon.mjs`, `packages/server/dist/dashboard.mjs` and
  `packages/dashboard-app/dist/**` are rebuilt by the main session after merge.
- **Every commit must pass** `npm run build:packages` and its own targeted tests.
  - `pretest` runs `build:packages`.
  - Use `npx vitest run <paths>` for targeted runs.

## Commits

### C1 — kernel: identity core (additive)

- [ ] **Create** `packages/kernel/src/users/user.ts`:
  - types `TenonUser`, `TenonUserMissing`, `TenonUserResolution`, `RecordActor`, `UserRef`, `UserSource`;
  - functions `validateUserId`, `normalizeUserName`, `userSlug`, `actorOf`, `formatUserRef`, `parseUserRef`,
    `decodeRecordActor`, `isTenonUser`;
  - constant `USER_MISSING_HINT`;
  - no `node:` imports.
- [ ] **Create** `packages/kernel/src/users/resolve-user.ts`:
  - `resolveTenonUser`, `readUserConfig`, `writeUserConfig`;
  - uses `execFileSync('git', …, { cwd, env, timeout: 1500, maxBuffer: 4096 })`.
- [ ] **Create** `packages/kernel/src/users/index.ts`.
- [ ] **Modify** `packages/kernel/src/index.ts`: add `export * from './users/index.js'` near `:7`.
- [ ] **Modify** `packages/kernel/src/product-paths.ts:14-34,142-160`: add `userConfigPath`. Update `product-paths.test.ts`.
- [ ] **Tests:** `users/user.test.ts`, `users/resolve-user.test.ts` (design §12).
- **Validate:**
  ```bash
  npm run build:packages
  npx vitest run packages/kernel/src/users packages/kernel/src/product-paths.test.ts
  npm run check:architecture
  ```

### C2 — kernel: per-user layout, active change, fingerprint (additive)

- [ ] **Create** `packages/kernel/src/users/user-paths.ts` (`userProjectPaths`, `ensureUserLocalDir`, `.tenon/.gitignore`
  writer) and `packages/kernel/src/users/active-change.ts` (`readActiveChange`, `writeActiveChange`), plus tests.
- [ ] **Modify** `packages/kernel/src/workspace/fingerprint.ts:61`: add `'.tenon/users'` to `EXCLUDED_RELATIVE_ROOTS`.
  Keep the basenames at `:52-58`.
- [ ] **Modify** `fingerprint.test.ts`: replace the `:86` pointer case with a `.tenon/users/**` case.
- **Validate:**
  ```bash
  npx vitest run packages/kernel/src/users packages/kernel/src/workspace/fingerprint.test.ts
  npm run check:architecture
  ```

### C3 — identity plumbing: `tenon user`, `/api/user` (additive; sibling API frozen here)

- [ ] **Modify** `tools/vitest.isolate-runtime-home.mjs`: default `TENON_USER=tester@tenon.test` and
  `TENON_USER_NAME=Tester` when unset.
- [ ] **Modify CLI wiring:**
  - `packages/cli/src/deps.ts`: add `user: () => TenonUserResolution`.
  - `packages/cli/src/main.ts:176-236`: memoized `resolveTenonUser(process.cwd(), process.env)`.
  - `packages/cli/src/integration-harness.ts:330-365`: default resolver plus a per-run env override for a second user.
- [ ] **Create CLI files:**
  - `packages/cli/src/userIdentity.ts` (`requireUser`, `requireActor`);
  - `packages/cli/src/program-users.ts`;
  - `packages/cli/src/commands/user.ts` (`user`, `user set`) with `commands/user.test.ts`.
- [ ] **Modify** `packages/cli/src/program.ts`: register the users commands (+2 lines; stay ≤ 400).
- [ ] **Server:**
  - Modify `packages/server/src/server.ts:91-198`: `resolveUser` option, passed into route deps.
  - Create `packages/server/src/serverUserRoutes.ts`: GET and POST `/api/user` (the owner route is added in C5), plus
    `serverUserRoutes.test.ts`.
  - Modify `packages/server/src/serverGetActivityRoutes.ts`: dispatch after `:44`.
  - Modify `packages/server/src/serverPostRoutes.ts:204`: insert before execution routes.
- **Validate:**
  ```bash
  npx vitest run packages/cli/src/commands/user.test.ts packages/server/src/serverUserRoutes.test.ts
  npm run check:architecture
  ```
- **Rollback point R1:** everything so far is additive.

### C4a — records: actor fields (kernel, automation; optional fields)

- [ ] **`packages/kernel/src/types.ts:404-425`:** add `actor?: RecordActor` to `HistoryEntry`, using `import type`.
  Keep `by` until C4b.
- [ ] **`packages/kernel/src/state/history.ts:13-36`:** writer `actor` stamping option; the transition projection parses
  the record actor.
- [ ] **`packages/kernel/src/workflow/run-types.ts:79-81,92`:** comment only. The value is `formatUserRef(actor)`.
- [ ] **`packages/kernel/src/state/document-ledger.ts:53-63,135-175,242-257,341-355`:** `actor?`, decoded with
  `decodeRecordActor`.
  - **Size risk:** this file is at 493/500. If it goes over, move `parseReceipt` / `parseRecord` into
    `state/document-ledger-record.ts`.
- [ ] **Document plumbing:**
  - `packages/kernel/src/documents/document-recording.ts:74-85`: `actor?`.
  - `packages/kernel/src/state/document-evidence.ts:114,152-160`: timeline `actor?`.
  - `packages/automation/src/submission/service.ts:9,37-38,98` and `adapters.ts:18`: pass `actor` through.
- [ ] **`packages/kernel/src/decision/review-application.ts:48-66,255-261`** and **`review-interaction.ts:108-122`:**
  `actor` port and history field.
- [ ] **Tests:** ledger round trip, history stamping, review history actor.
- **Validate:**
  ```bash
  npm run build:packages
  npx vitest run packages/kernel/src/state packages/kernel/src/decision packages/automation/src/submission
  ```

### C4b — records: required actors, creator/owner at init, removals

- [ ] **Kernel:**
  - `types.ts:207`: `InitOptions.user` → `creator: RecordActor`; delete `HistoryEntry.by`.
  - `state/store.ts:424-432`: `createdBy = formatUserRef(opts.creator)` (net fewer lines).
  - `state/state-init.ts:93-94`: `assignee = createdBy`.
  - `ReviewAcknowledgePorts.actor`: now required.
- [ ] **Automation:**
  - `packages/automation/src/triage/workflow-run-create-repository.ts:352`: `creator`. Trace the `trusted.user` origin
    in `packages/automation/src/triage/`.
  - `packages/automation/src/lifecycle/ports.ts:331`: sandbox env gets `TENON_USER` / `TENON_USER_NAME` from the host
    identity.
- [ ] **CLI:**
  - `program.ts:80`: delete `--user`.
  - `commands/init.ts:2,36-44,119,125,236,241-245`: no user prompt; `requireActor`; `creator`; history `actor`.
  - `main.ts:236`: `createHistoryWriter({ actor })`.
  - `commands/review.ts:264` and `commands/review-acknowledge.ts:56-84`: `actor`.
  - `commands/document.ts:222-278`: `requireActor` plus `actor` into submission and `recordDocument`
    (**size risk** 396/400; one-line calls only).
  - `commands/session.ts:169-176`: authority history row `actor`.
  - `commands/status.ts:112-136`: `owner` column and key.
- [ ] **Server:**
  - `serverPostChangesRoutes.ts:143-311`: 412 when missing, `creator`, init history `actor`.
  - `serverPostDecisionRoutes.ts:103-139`: `actor`, 412.
  - `transitionHistory.ts:17-39`: `actor` decode, drop `by`.
  - `types.ts:37-73,111`: `owner`, `creator`, timeline `actor`.
  - `snapshot.ts:194-201`.
  - `snapshotProjectScan.ts:138-164` and `changeSnapshot.ts:362-380`: `ownerOf` / `creatorOf`.
  - `test-support.ts:125-155`: `creator`.
- [ ] **Tests and fixtures:**
  - `packages/cli/src/program.test.ts:218`, `integration.test.ts:43,344`,
    `workflow-skill-orchestration.integration.test.ts:265`: drop `--user`.
  - `commands/init.test.ts`, `commands/status.test.ts`, `kernel/src/state/store.test.ts`,
    `automation/src/triage/workflow-run-create-repository.test.ts`, `server/src/server.test.ts` (snapshot owner,
    create 412, decisions actor).
  - `tools/test-bundle.sh:106`: drop `--user smoke`. Leave the N-1 CLI call at `:243` unchanged, because it runs the
    previous release.
- **Validate:**
  ```bash
  npm run build:packages
  npm test
  npm run check:architecture && npm run check:comments
  bash tools/test-bundle.sh   # after npm run bundle locally; do not commit dist
  ```
- **Risky files:** `kernel/src/state/store.ts`, `kernel/src/types.ts`, `cli/src/commands/document.ts`,
  `server/src/serverPostChangesRoutes.ts`.
- **Rollback point R2:** revert C4b and C4a together.

### C5 — owner rule and 接手

- [ ] **Create** `packages/kernel/src/users/owner.ts` (`ownerOf`, `creatorOf`, `ownerDecision`, `ownerRequiredMessage`,
  `OwnerRequiredError`, `assertOwner`) and `packages/kernel/src/users/owner-transfer.ts` (`transferOwner`), plus tests.
- [ ] **Transition application:**
  - `packages/kernel/src/workflow/transition-application-types.ts:47-54,70-122`: `actor` in the command;
    `owner-required` result.
  - `packages/kernel/src/workflow/transition-application.ts:270-272,383-385`: `ownerDecision` as the first statement in
    `transact`; commit draft `actor`.
  - **Size risk:** 439/450, so add at most 5 lines.
  - Tests.
- [ ] **CLI:**
  - `packages/cli/src/commands/transition.ts:70,173-185,187-295`: `requireActor`, command `actor`, `owner-required`
    → exit 1.
  - `packages/cli/src/commands/review.ts:181-183`: `assertOwner` after `store.read`; the catch prints the message and
    exits 1.
  - `packages/cli/src/commands/document.ts:224`: `assertOwner`.
  - `packages/cli/src/commands/fields.ts:220-226`: protect `created_by` / `assignee` with a same-line edit
    (**size 400/400**).
  - Create `packages/cli/src/commands/owner.ts` (`owner take`, `owner set`); register in `program-users.ts`.
- [ ] **Server:**
  - `packages/server/src/transition.ts:228-376`: `resolveUser`, 412, `actor`, 403 mapping.
  - `serverPostExecutionRoutes.ts:316-346`: pass deps.
  - `serverUserRoutes.ts`: add `POST /api/change/:name/owner`.
- [ ] **Tests:**
  - new `packages/cli/src/owner.integration.test.ts` (two users, design §12);
  - `packages/cli/src/advance.integration.test.ts` still green;
  - `server.test.ts` transition 403/412;
  - `serverUserRoutes.test.ts` owner route.
- **Validate:**
  ```bash
  npm run build:packages
  npx vitest run packages/kernel/src/users packages/kernel/src/workflow/transition-application.test.ts \
    packages/cli/src/owner.integration.test.ts packages/cli/src/advance.integration.test.ts \
    packages/cli/src/transition-custom-workflow.integration.test.ts packages/server/src
  npm run check:architecture
  ```
- **Risky files:** `transition-application.ts`, `fields.ts`.
- **Rollback point R3.**

### C6 — per-user session state: CLI, server activation, hooks

- [ ] **`packages/cli/src/continuousAuthority.ts`:** delete `ACTIVE_POINTER_FILE` and `INTERACTION_AUTHORITY_FILE`.
  `readDelegatedReviewAuthority(cwd, slug, name, hostSessionId)` reads `userProjectPaths`.
- [ ] **`packages/cli/src/commands/session.ts:48-53,72-81,147-198,252-337`:**
  - `SessionFs` gains `slug`;
  - `bindPointer` → `writeActiveChange`, then removes stale root files;
  - authority path is `local/authority`;
  - `requireUser`;
  - `[OK]` messages no longer mention `.pipeline-active`.
- [ ] **`packages/cli/src/commands/review-acknowledge.ts:44-50`:** pass `requireUser(deps).slug`.
- [ ] **`packages/server/src/changeLaunch.ts:107-140`:** `userSlug` input plus `readActiveChange`.
  **`serverPostChangesRoutes.ts:295-302`:** pass the slug.
- [ ] **Hooks:**
  - Create `hooks/tenon-user.sh` (chmod +x, shebang, source-only).
  - Modify `hooks/active-change.sh`, `hooks/interaction-authority.sh`, `hooks/router.sh:146-164`,
    `hooks/breadcrumb.sh:52-73`.
  - Comments only: `hooks/prompt-intent.sh:4,146`, `hooks/terminal-activity.sh:4`, `hooks/host-session-binding.sh:5`,
    `adapters/codex/hooks/prompt.sh:11`.
- [ ] **Tools:**
  - `tools/verify-skills.sh:195-203`: add `hooks/tenon-user.sh`.
  - `tools/test-hooks.sh`: `export TENON_USER` near `:23`; `set_active` helper; replace the 25 pointer writes;
    authority assertions `:1698-1739`; new two-user / missing / config / git section.
  - `tools/test-adapters.sh:156,166,230,252,765`: per-user pointer plus `TENON_USER`.
- [ ] **Tests:**
  - `packages/cli/src/session.integration.test.ts`
  - `packages/cli/src/integration.test.ts:284-299`
  - `packages/cli/src/commands/review.integration.test.ts:259-292`
  - `packages/cli/src/terminal-activity-hook.integration.test.ts:60`
  - `packages/cli/src/integration-phase-skill-test-support.ts:21`
  - `packages/server/src/test-support.ts:73`
  - `packages/server/src/server.test.ts:5527-5552`
  - new `packages/cli/src/user-hook-parity.integration.test.ts`
- [ ] **`.gitignore:21,40`:** delete `.pipeline-active` and `.pipeline-interaction-authority`.
- **Validate:**
  ```bash
  npm run build:packages
  bash tools/test-hooks.sh && bash tools/test-adapters.sh && bash tools/verify-skills.sh
  npx vitest run packages/cli/src/session.integration.test.ts packages/cli/src/commands/review.integration.test.ts \
    packages/cli/src/user-hook-parity.integration.test.ts packages/cli/src/terminal-activity-hook.integration.test.ts \
    packages/server/src/server.test.ts
  grep -rn "pipeline-active\|pipeline-interaction-authority\b" hooks packages/*/src adapters tools skills templates \
    | grep -v "pipeline-interaction-authority-v2\|fingerprint.ts"   # expect only docs handled in C8
  ```
- **Risky files:** `hooks/router.sh` (hot path, prompt routing), `hooks/active-change.sh` (8 consumers),
  `hooks/interaction-authority.sh`.
- **Rollback point R4:** revert C6 alone. C1–C5 keep working, because session state is independent of owner rules.

### C7 — Dashboard

- [ ] **Create:**
  - `packages/dashboard-app/src/api/userClient.ts`
  - `packages/dashboard-app/src/state/useCurrentUser.ts`
  - `packages/dashboard-app/src/shell/UserDialog.tsx`
  - `packages/dashboard-app/src/workspace/TaskRecords.tsx`
- [ ] **Modify:**
  - `types.ts`, `api/snapshotDecoder.ts:86-98,158-224`
  - `api/governanceTypes.ts:17-25`, `api/governanceDecoders.ts:64-87`
  - `shell/TopBar.tsx:15-28,173-182`, `App.tsx:114,240-252`
  - `workspace/WorkspaceView.tsx:40-48,131`, `workspace/taskModel.ts:25-34,159-232`
  - `workspace/TaskListPane.tsx:25-84`, `workspace/TaskCard.tsx:27-47`
  - `workspace/TaskDetailPane.tsx:76-101`
  - `workspace/stageIo.ts:43-44`, `workspace/StageIoPanel.tsx:40`
  - `i18n/translations.ts`: zh `shell` `:131-143` and `workspace` `:144-192`, plus the matching en sections
- [ ] **Tests:**
  - `workspace/taskModel.test.tsx`, `App.test.tsx` (top bar user and dialog)
  - new `workspace/TaskDetailPane.test.tsx` (take, records)
  - `api/boundaryDecoders.test.tsx` or the snapshot decoder test (owner shape)
  - `i18n/i18n.test.tsx`
- **Validate:**
  ```bash
  npm run typecheck:web && npm run test:web && npm run check:design-scale
  npm run build:web   # local only; dist not committed
  ```
- **Manual:** run the Dashboard (`run` skill) and check with Playwright: top bar user, 未设置 → dialog → saved, owner
  chips and 我的, 接手 on another user's task, 记录 operators. Nothing wraps at 1280px width.

### C8 — docs, skills, spec

- [ ] **Docs:**
  - `docs/CONTRACT.md:224-233`
  - `docs/usage/routing-and-workflows.md:110,113`, `docs/usage/troubleshooting.md:74`
  - `docs/usage/zh-CN/routing-and-workflows.md:7,45,88,90`, `docs/usage/zh-CN/troubleshooting.md:32,34`,
    `docs/usage/zh-CN/index.md:61`
  - `docs/TEST-REALITY.md:204`
  - `adapters/codex/README.md:44`
- [ ] **Templates, skills, specs:**
  - `templates/workflow.md:22,38,48`
  - `skills/tenon/SKILL.md:86,101,128-146` (pointer wording; state that identity is required)
  - `skills/openspec-propose/SKILL.md:65`
  - `skills/tenon-open/SKILL.md:169,175-177` (drop `--user`)
  - `openspec/specs/plugin-runtime/spec.md:113`
- [ ] **New spec:** `.trellis/spec/kernel/backend/user-identity.md` (resolution order, slug, layout, owner rule, error
  matrix). Add an index row in `.trellis/spec/kernel/backend/index.md`.
- [ ] **Hook guidelines:** add a scenario to `.trellis/spec/cli/frontend/hook-guidelines.md` for the per-user pointer
  and the bash identity mirror.
- **Validate:**
  ```bash
  npm run check:docs && npm run check:openspec && npm run check:interaction-contract && bash tools/verify-skills.sh
  ```

### C9 — full gates (no commit unless fixes)

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh && bash tools/test-adapters.sh
```

**Real acceptance** (prd; recorded in the task, not committed as dist):
- Two shells on one repo, `TENON_USER=a@x.io` and `TENON_USER=b@x.io`, in Claude Code and in Codex:
  - each creates and activates its own task;
  - `.tenon/users/a-at-x.io/local/active-change` and `.tenon/users/b-at-x.io/local/active-change` differ;
  - B's `tenon transition` on A's task exits 1; `tenon owner take` then succeeds; A is refused.
- Unset identity (`HOME` and `GIT_CONFIG_GLOBAL` pointed at temp): CLI hint; Dashboard `top-bar-user-missing` → set →
  create works.
- A second clone after `git pull`: the Dashboard 记录 shows both operators.

## Risky files summary

| File | Risk | Mitigation |
| --- | --- | --- |
| `packages/cli/src/commands/fields.ts` | at the 400-line limit | same-line protected-field edit only |
| `packages/kernel/src/state/store.ts` | 498/500 | the `created_by` block shrinks |
| `packages/kernel/src/state/document-ledger.ts` | 493/500 | extract the record codec if needed |
| `packages/cli/src/commands/document.ts` | 396/400 | one-line `requireActor` and `assertOwner` |
| `packages/kernel/src/workflow/transition-application.ts` | 439/450; shared by CLI and server | ≤ 5 lines; test zero writes on refusal |
| `hooks/router.sh`, `hooks/breadcrumb.sh`, `hooks/active-change.sh` | UserPromptSubmit routing and 8 consumers | test-hooks sections 9a (HOT PATH red line), 10a'' authority, plus the new two-user section |
| `packages/server/src/serverPostChangesRoutes.ts` | create flow and activation | server.test create and activation cases |

## Overlap with other children

| File(s) | Other child | Merge note |
| --- | --- | --- |
| `packages/kernel/src/users/user-paths.ts`, `fingerprint.ts` | test-evidence, task-delete-archive | Land C1–C3 first. Those children import the paths; they do not redefine them. |
| `packages/dashboard-app/src/workspace/TaskListPane.tsx`, `TaskCard.tsx`, `taskModel.ts`, `WorkspaceView.tsx` | task-delete-archive (归档/删除, 已归档 view) | Owner facet is the first row; archive controls stay on the workflow row. Rebase keeps both `TaskFilterState` keys. |
| `packages/dashboard-app/src/workspace/TaskDetailPane.tsx` | task-delete-archive (footer actions), test-evidence (测试 section), review-agents (agent runs), workflow-io-openspec (removes `ArtifactCatalogPanel`, 输出 n/m) | Footer order: 接手 · 归档 · 删除 · 复制链接. `TaskRecords` goes last in the body. Resolve by keeping every section. |
| `packages/dashboard-app/src/workspace/stageIo.ts`, `StageIoPanel.tsx` | workflow-io-openspec | Actor meta is a one-token addition; re-apply on top of their row format. |
| `packages/dashboard-app/src/i18n/translations.ts` | all UI children | Append keys at section ends; keep zh/en parity. |
| `packages/server/src/serverPostRoutes.ts`, `server.ts` options, `serverGetActivityRoutes.ts` | task-delete-archive, instruction-templates, test-evidence | Router chain insertions are independent lines; keep the user router before execution routes. |
| `packages/cli/src/program.ts`, `program-*.ts` | task-delete-archive, test-evidence, review-agents, instruction-templates | Each child adds its own registrar; `program.ts` gets only import and call lines (limit 400). |
| `packages/cli/src/commands/document.ts`, `commands/review.ts`, `transition-application.ts` | review-agents (review flow), test-evidence (guards before transition) | Owner check stays first in each lock; their guards follow it. |
| `packages/kernel/src/types.ts` (`HistoryEntry`) | task-delete-archive (audit rows) | They write rows with `actor` from this API; no new `by`. |
| `skills/tenon/SKILL.md`, `skills/tenon-open/SKILL.md`, `skills/openspec-propose/SKILL.md`, `templates/workflow.md` | data-driven-runner (deletes tenon-open, rewrites tenon), upstream-skills (replaces openspec-propose) | If those land first, drop C8's edits to deleted or replaced files and apply only the pointer/identity wording to the new `tenon` skill. |
| `.gitignore` | task-delete-archive, upstream-skills | Line deletions only. |
| `packages/automation/src/lifecycle/ports.ts` | data-driven-runner (AFK execution) | Sandbox env addition is two keys. |

## Rough size

- **Files:** about 95 in total.
  - Created: 17 (kernel 7, CLI 5, server 2, dashboard 4, hooks 1, specs 1; tests included).
  - Modified: about 78, of which about 30 are tests and fixtures and about 14 are docs, skills or specs.
- **Lines of code:** about 1,400 of product code (kernel 450, CLI 300, server 250, Dashboard 300, hooks 120) and about
  1,700 of tests, for roughly 3,100 lines in the diff.
