# Implementation plan: `09-15-instruction-templates`

Branch `feat/instruction-templates` in its own worktree (parent `implement.md`). Wave 1. Every commit builds and passes its own
validation; no generated files (`dist`, `templates/skill-sources.yaml`) are committed. Design references are `design.md` sections.

Common validation after each commit:

```bash
npm run build:packages
git diff --check
```

## Ordered commits

### 1. `fix(kernel): recognize tagged Tenon managed blocks in AGENTS.md`

- Add `packages/kernel/src/instructions/managed-blocks.ts` (+ `managed-blocks.test.ts`), `instructions/index.ts`, export from
  `packages/kernel/src/index.ts`.
- `packages/kernel/src/state/ownership-manifest.ts`: remove `MANAGED_BLOCK_START/END`, `isManagedAgentsMd` uses `parseManagedBlocks`.
- `packages/kernel/src/state/ownership.test.ts`: regression reading `templates/generated/codex-agents-block.md` (design §11).
- `tools/check-architecture.mjs`: add `packages/kernel/src/instructions/` to `DOMAIN_DIRS` (line 254).
- `commands/tenon-uninstall.md:13,33`: tagged marker wording.
- Validate: `npx vitest run packages/kernel/src/instructions packages/kernel/src/state/ownership.test.ts packages/cli/src/sync-uninstall.integration.test.ts && npm run check:architecture && npm run check:comments`.

### 2. `fix(adapters): write Cursor rules as .mdc and Zed block into the file Zed reads`

- `adapters/cursor/install.sh` (`install_rules`, lines 46-67): `.cursor/rules/tenon.mdc` with frontmatter; legacy `pipeline.md` removal by
  hash. `adapters/cursor/README.md`, `adapters/registry.yaml` cursor comment.
- `adapters/zed/install.sh` (`install_rules`, lines 45-100): effective-file algorithm (design §10), `ZED_ORDER` array.
  `adapters/zed/README.md`, `adapters/registry.yaml` zed comment.
- `tools/test-adapters.sh`: replace assertions at 404-411 and 916-923 with design §11 adapter cases (order equality check lands in
  commit 3 once kernel exports `ZED_PROJECT_ORDER`; here assert the literal list).
- Validate: `bash tools/test-adapters.sh && bash adapters/lint-adapter.sh && npm run check:adapter-capabilities-freshness`.
- Rollback point: revert this commit alone; no kernel/server dependency.

### 3. `feat(kernel): instruction template blocks, composition and host table`

- New `packages/kernel/src/instructions/{categories,block,compose,hosts,digest,library-paths}.ts` + tests (design §3, §4.1).
- `tools/test-adapters.sh`: compare the Zed script order with `ZED_PROJECT_ORDER` from `packages/kernel/dist/index.js`.
- Validate: `npx vitest run packages/kernel/src/instructions && npm run check:architecture && bash tools/test-adapters.sh`.

### 4. `feat(kernel): sync builtin libraries into the global config root`

- `packages/kernel/src/infrastructure/builtin-library-sync.ts` + test; export.
- Validate: `npx vitest run packages/kernel/src/infrastructure && npm run check:architecture`.

### 5. `feat(templates): builtin instruction blocks — common and frontend`

- `templates/instructions/builtin/common/base.md`, `frontend/{typescript-react,typescript-vue3,typescript-angular}.md`,
  `state/{zustand,redux-toolkit,jotai,tanstack-query,pinia,angular-signals,ngrx-signals}.md`,
  `styling/{tailwind,css-modules,scss}.md` (design §8.1–8.4). Check versions against official docs on the authoring day.
- `tools/check-instruction-templates.mjs` + `tools/check-instruction-templates.node-test.mjs`; `package.json` script
  `check:instruction-templates` (inventory grows in 6 and 7).
- Validate: `npm run build:packages && npm run check:instruction-templates && npm run check:repository-hygiene`.

### 6. `feat(templates): builtin instruction blocks — backend`

- `templates/instructions/builtin/backend/*.md` (10 files, design §8.5).
- Validate: `npm run check:instruction-templates`.

### 7. `feat(templates): builtin instruction blocks — mobile, system, api, database`

- `mobile/*.md` (3), `system/*.md` (2), `api/rest-v1-unified-response.md`, `database/{postgresql,mysql}.md`; golden compose case in the
  check script and `packages/kernel/src/instructions/compose.test.ts` reading the repo files.
- Validate: `npm run check:instruction-templates && npx vitest run packages/kernel/src/instructions/compose.test.ts`.

### 8. `feat(runtime): sync builtin libraries after activation and at dashboard start`

- `packages/cli/src/runtime/release-store.ts` (after line 310, before `prune` at 322).
- `packages/server/src/main.ts` (after `mkdirSync(paths.stateRoot …)`), keep last result for GET.
- `packages/cli/src/runtime/release-store.integration.test.ts` cases (design §11).
- Validate: `npx vitest run packages/cli/src/runtime/release-store.integration.test.ts && npm run check:npx-package && bash tools/verify-skills.sh`.
- Risky file: `release-store.ts` (activation transaction). Rollback point: revert this commit; library stays empty, nothing else breaks.

### 9. `feat(server): instruction template library routes`

- `packages/server/src/instructionLibrary.ts`, `instructionRoutes.ts` (template part), wiring lines in `serverGetRoutes.ts`,
  `serverPostRoutes.ts`, `serverMutationRoutes.ts` (PUT/DELETE); `instructionRoutes.test.ts`.
- Validate: `npx vitest run packages/server/src/instructionRoutes.test.ts packages/server/src/server.test.ts && npm run check:architecture`.

### 10. `feat(server): project and user instruction files with managed-block preservation`

- `packages/server/src/instructionTrustedFs.ts`, `instructionFiles.ts`, routes in `instructionRoutes.ts`; `instructionFiles.test.ts`.
- Validate: `npx vitest run packages/server/src/instructionFiles.test.ts packages/server/src/instructionRoutes.test.ts`.

### 11. `feat(server): create projects from an existing or new directory`

- `packages/server/src/projects.ts` `registerProjectAnchored` (moved from `serverPostChangesRoutes.ts:95-135`, which now calls it);
  `projectCreate.ts`; route in `instructionRoutes.ts`; `projectCreate.test.ts`; characterization of `POST /api/projects`.
- Validate: `npx vitest run packages/server/src/projectCreate.test.ts packages/server/src/projects.test.ts packages/server/src/server.test.ts`.
- Risky file: `serverPostChangesRoutes.ts` (registration anchors). Rollback point: revert 11 only.

### 12. `feat(dashboard): instruction API client, line diff, projects and library views`

- `api/instructionsClient.ts`, `api/instructionsDecoders.ts` (+ test), `shared/lineDiff.ts` (+ test), `shell/views.ts`, `App.tsx`
  (lazy views, generalized dirty guard), `i18n/translations.ts` (`nav.library`, `projects.*`, `library.*` zh/en), remove
  `registerProject` from `api/governanceClient.ts`.
- Validate: `npm run typecheck:web && npx vitest run --config packages/dashboard-app/vitest.config.ts packages/dashboard-app/src/api packages/dashboard-app/src/shared packages/dashboard-app/src/App.test.tsx packages/dashboard-app/src/i18n`.
- Risky file: `App.tsx` navigation guard. Rollback point: revert 12–15 together.

### 13. `feat(dashboard): 库 page with template section`

- `library/{LibraryView,TemplateDetail,NewTemplateDialog}.tsx`, `library/useTemplateLibrary.ts`, `library/LibraryView.test.tsx`.
- Validate: `npm run typecheck:web && npx vitest run --config packages/dashboard-app/vitest.config.ts packages/dashboard-app/src/library && npm run check:design-scale`.

### 14. `feat(dashboard): 项目 page with project and user instruction editors`

- `projects/{ProjectsView,HostTargetList,InstructionEditor,DiffDrawer}.tsx`, `projects/useInstructionFiles.ts`,
  `projects/instructionModel.ts`, `projects/ProjectsView.test.tsx`.
- Validate: same as 13 for `src/projects`.

### 15. `feat(dashboard): 新建项目 dialog and onboarding action`

- `projects/{NewProjectDialog,TemplatePicker}.tsx` + test; `shell/Onboarding.tsx` + `Onboarding.test.tsx`.
- Validate: `npm run typecheck:web && npm run test:web && npm run check:design-scale && npm run build:web`; browser check at 375/768/1440
  (dashboard `quality-guidelines.md`).

### 16. `feat(server): record template and instruction writers` (after `feat/multi-user` is merged to main)

- Wire `resolveTenonUser` into `InstructionRouteDeps.resolveActor`; `author` on custom save; append `audit.jsonl` (design §3.1);
  409 `identity-missing` tests.
- Validate: `npx vitest run packages/server/src/instruction*.test.ts packages/server/src/projectCreate.test.ts`.

### 17. `docs(spec): instruction files, templates and project creation contracts`

- New `.trellis/spec/server/backend/instruction-files-and-templates.md` (routes, error matrix, tests); update
  `.trellis/spec/server/backend/index.md`, `.trellis/spec/dashboard-app/frontend/component-guidelines.md` (项目 / 库 rules),
  `.trellis/spec/dashboard-app/frontend/directory-structure.md` (views list, new dirs).
- Validate: `npm run check:docs`.

### 18. `test(task): real host evidence`

- Run PRD acceptance on the installed build in Claude Code and Codex; Zed live check; Cursor docs evidence; record in
  `.trellis/tasks/09-15-instruction-templates/verification.md`.

## Shared gates before handing the branch to the main session

```bash
npm run build
npm run check:architecture && npm run check:comments && npm run check:identity
npm run check:instruction-templates && npm run check:design-scale && npm run check:docs
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/test-adapters.sh && bash tools/verify-skills.sh
```

## Risky files

| File | Risk | Mitigation |
| --- | --- | --- |
| `packages/cli/src/runtime/release-store.ts` | activation transaction | post-commit only, `.catch(() => [])`, integration test proves activation still succeeds on sync failure |
| `packages/kernel/src/state/ownership-manifest.ts` | uninstall keep/delete decisions | regression tests with the real generated block; sync-uninstall integration test |
| `adapters/zed/install.sh`, `adapters/cursor/install.sh` | user files in installed projects | only Tenon-generated content is deleted (exact block / exact hash) |
| `packages/server/src/serverPostChangesRoutes.ts` | project registration anchors | pure extraction + characterization test |
| `packages/dashboard-app/src/App.tsx` | navigation and unsaved-draft guard | existing App tests plus new dirty-view cases |
| `packages/server/src/serverGetRoutes.ts` (396 lines) | size gate 400 | one dispatch line; if another child lands first and the gate trips, extract the skills/hook GET block into its own module in the merge |

## Overlap with other children and merge notes

| File | Other children | Note |
| --- | --- | --- |
| `packages/dashboard-app/src/i18n/translations.ts` | all dashboard children | append-only namespaces `projects`, `library`; resolve by keeping both blocks, re-run `i18n.test.tsx` |
| `packages/dashboard-app/src/shell/views.ts`, `App.tsx` | task-delete-archive (已归档 view), multi-user (top bar user) | `VIEWS` order `progress, workbench, projects, library`; the generalized dirty guard is the version to keep |
| `packages/dashboard-app/src/library/LibraryView.tsx` | review-agents, design-resources, test-evidence | they add rail sections + detail components; keep section array data-driven |
| `packages/dashboard-app/src/projects/NewProjectDialog.tsx`, `TemplatePicker.tsx` | design-resources | catalog selects and `design_md` (CCR-4) |
| `packages/dashboard-app/src/shell/Onboarding.tsx` | multi-user (identity setup entry) | keep both actions if multi-user adds one |
| `packages/server/src/serverGetRoutes.ts`, `serverPostRoutes.ts`, `serverMutationRoutes.ts`, `server.ts` | review-agents, test-evidence, design-resources, task-delete-archive, multi-user | one-line dispatches; merge by keeping every dispatch line; watch the 400-line gate |
| `packages/server/src/serverPostChangesRoutes.ts` | multi-user (actor on `POST /api/changes`), task-delete-archive | this branch only moves lines 95-135 out |
| `packages/server/src/main.ts` | upstream-skills, version-reset | single sync call after state root creation |
| `packages/kernel/src/index.ts` | all kernel children | append export lines |
| `packages/kernel/src/infrastructure/builtin-library-sync.ts` | review-agents, design-resources, test-evidence | they add `BUILTIN_LIBRARIES` rows only (CCR-1) |
| `packages/cli/src/runtime/release-store.ts` | upstream-skills (fetch into payload), version-reset | our call sits after selection commit; upstream fetch happens before candidate staging, so order is independent |
| `tools/check-architecture.mjs` | any child adding kernel domain dirs | append to `DOMAIN_DIRS` |
| `package.json` scripts | children adding checks | append |
| `adapters/*`, `tools/test-adapters.sh`, `tools/generate-product-identity.mjs` | data-driven-runner (Codex block text) | marker grammar is content-independent; tests read the generated block file, so text changes stay green |
| `templates/` | upstream-skills, data-driven-runner | new subtree `templates/instructions/` only |

## Rough size

- Kernel: ~900 lines + ~700 test lines. Server: ~1 100 + ~900. Dashboard: ~1 800 + ~900. Adapters/tools: ~250 + ~150.
- Builtin Markdown: 32 files, ~3 000 lines.
- 18 commits; the three template-authoring commits are the longest.
