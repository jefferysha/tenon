# Implement: 任务删除与归档

Preconditions: `09-15-multi-user` merged (kernel `resolveTenonUser`, `.tenon/users/<slug>/local/` gitignored, per-user
`active-change` / `authority.json`, bash `pipeline_user_local_dir`, `owner` field). Work in worktree branch
`feat/task-delete-archive`. Do not commit `dist/`, generated TS or `packages/dashboard-app/dist/**`; the main session rebuilds.
Contract: `design.md` in this directory (section numbers below refer to it).

## Ordered commits

### C1 `feat(kernel): per-user task archive store`

- [ ] `packages/kernel/src/workspace/task-archive.ts` — §3.1, §4 (`taskArchivePath`, `readTaskArchive`, `serializeTaskArchive`,
      internal `writeTaskArchive` under `withLock(localDir)`, `isArchivedForUser`, `assertTaskNotArchived`, `TaskArchivedError`).
- [ ] `packages/kernel/src/workspace/task-archive.test.ts` — §17 row 1.
- [ ] `packages/kernel/src/index.ts` — export next to `workspace/terminal-activity.js` (`index.ts:18-26`).
- Verify: `npx vitest run packages/kernel/src/workspace/task-archive.test.ts && npx tsc -b packages/kernel`

### C2 `feat(kernel): count uncommitted task deletions`

- [ ] `packages/kernel/src/workspace/uncommitted-deletions.ts` — §11 (`execFile` like `workspace/build-revision-identity.ts:2-31`).
- [ ] `packages/kernel/src/workspace/uncommitted-deletions.test.ts` — real temp git repos, §17 row 3.
- [ ] `packages/kernel/src/index.ts` export.
- Verify: `npx vitest run packages/kernel/src/workspace/uncommitted-deletions.test.ts`

### C3 `feat(kernel): task lifecycle application`

- [ ] `packages/kernel/src/state/markers.ts` — `clearReviewMarkerOfChange` (reuse `parseReviewMarker`); test in `markers.test.ts`.
- [ ] `packages/kernel/src/workspace/task-lifecycle.ts` — §4 types, §5 assessment, §6 delete sequence, archive/unarchive, audit
      writers (§3.2), tombstone sweep (§3.3). Guard every removal path: resolved path must stay under `repoRoot`, never follow
      symlinks (`lstat` before `rm`), bindings ≤ 4096 B.
- [ ] `packages/kernel/src/workspace/task-lifecycle.test.ts` — §17 row 2 (include the lock-after-rename case).
- [ ] `packages/kernel/src/index.ts` export.
- [ ] `.trellis/spec/kernel/backend/task-lifecycle.md` (new, 7-section scenario format) + row in `.trellis/spec/kernel/backend/index.md`.
- Verify: `npx vitest run packages/kernel/src/workspace packages/kernel/src/state/markers.test.ts packages/kernel/src/state/lock.test.ts && npx tsc -b packages/kernel && npm run check:architecture`
- Rollback point R1: kernel-only, no consumer yet.

### C4 `feat(cli): tenon task delete|archive|unarchive and list --archived`

- [ ] `packages/cli/src/commands/task-lifecycle.ts` — `cmdTaskDelete`, `cmdTaskArchive`, `cmdTaskUnarchive`, `cmdListArchived`
      (§7 text, JSON, exit codes 0/1/2/3; reason hints from §5).
- [ ] `packages/cli/src/commands/task.ts` — dispatch `delete|archive|unarchive` (`task.ts:205-213`), usage line.
- [ ] `packages/cli/src/program.ts` — `task` `.option('--yes')` (`:202-206`), `list` `.option('--archived')` (`:253-256`).
- [ ] `packages/cli/src/deps.ts`, `packages/cli/src/main.ts`, `packages/cli/src/integration-harness.ts` — inject
      `taskLifecycle: TaskLifecycleApplication` built with `terminalActivityLive` = `readBoundedRegularFileSync`
      (`guardContext.ts`) + kernel `parseTerminalActivityRecord` / `liveTerminalActivity`.
- [ ] `packages/cli/src/commands/status.ts` (`collectActive`, `:22-36`) and `packages/cli/src/commands/inbox.ts` (`:114-122`) —
      skip archived-for-me; tests `status.test.ts`, `inbox.test.ts`.
- [ ] `packages/cli/src/task-lifecycle.integration.test.ts` — §17 CLI row.
- [ ] `docs/CONTRACT.md:245-258` — rows for the three subs and `list --archived`.
- Verify: `npx vitest run packages/cli/src/commands/status.test.ts packages/cli/src/commands/inbox.test.ts packages/cli/src/task-lifecycle.integration.test.ts && npx tsc -b packages/cli && npm run check:docs`

### C5 `feat(cli): refuse progress on archived tasks`

- [ ] `packages/cli/src/archivedGuard.ts` — `refuseArchived(deps, name)` (§7, §10).
- [ ] Call first in `commands/transition.ts` (`cmdTransition`, after name check `:71-74`), `commands/advance.ts`,
      `commands/review.ts` (`cmdReview` `:145`, request + acknowledge), `commands/document.ts` (`cmdDocumentRecord`),
      `commands/artifact.ts` (`cmdArtifactRegister`).
- [ ] Extend `task-lifecycle.integration.test.ts` with refusal and unarchive-then-transition cases.
- Verify: `npx vitest run packages/cli/src/task-lifecycle.integration.test.ts packages/cli/src/integration.test.ts packages/cli/src/commands/review.integration.test.ts packages/cli/src/document-record.integration.test.ts`
- Rollback point R2: CLI feature complete, server/UI untouched.

### C6 `feat(server): partition snapshot by viewer archive`

- [ ] `packages/server/src/types.ts` (`ProjectSnapshot` `:191-203`) — `archived?`, `uncommittedDeletions?`, `ArchivedChangeSnapshot`.
- [ ] `packages/server/src/snapshotProjectScan.ts` — read viewer archive once, partition at the push (`:138-164`), count via kernel.
- [ ] `packages/server/src/snapshot.ts` — `SnapshotDeps.viewer?: (root: string) => TenonUser | { missing: true }`, `countDeletions?`.
- [ ] `packages/server/src/snapshotFingerprint.ts` — lstat viewer `archived.json` and `.git/logs/HEAD`.
- [ ] `packages/server/src/snapshot.test.ts`, `packages/server/src/afk.test.ts` — partition, counts, AFK exclusion, fingerprint.
- Verify: `npx vitest run packages/server/src/snapshot.test.ts packages/server/src/afk.test.ts && npx tsc -b packages/server`

### C7 `feat(server): task lifecycle routes and archived refusals`

- [ ] `packages/server/src/serverTaskLifecycleRoutes.ts` — §8.
- [ ] Wiring: `serverGetRoutes.ts:150-152`, `serverPostRoutes.ts` (`PostRouteDeps` `:87-134`, dispatch `:194-206`),
      `serverMutationRoutes.ts` (deps type + branch after `:143`), `server.ts` (build app, `viewer`, `evictChange` over
      `artifactServices` `:196-208`, add to `mutationRouteDeps` `:307-322` and post deps).
- [ ] `serverPostExecutionRoutes.ts:288` (transition) and `serverPostDecisionRoutes.ts:54` (decisions) — 409 `task-archived`.
- [ ] `packages/server/src/serverTaskLifecycleRoutes.test.ts` — §17 server row.
- Verify: `npx vitest run packages/server/src/serverTaskLifecycleRoutes.test.ts packages/server/src/serverDecisionRoutes.test.ts packages/server/src/server.test.ts && npm run check:architecture`
- Rollback point R3: backend complete.

### C8 `feat(hooks): skip tasks archived for the current user`

- [ ] `hooks/task-archive.sh` (source-only, §9).
- [ ] Source and apply in `hooks/active-change.sh:22`, `hooks/host-session-binding.sh:34`, `hooks/router.sh:106,157`,
      `hooks/breadcrumb.sh:65,94,145`, `hooks/session-start.sh:175,217`, `hooks/statusline.sh:76`; resolve local dir once.
- [ ] `tools/test-hooks.sh` — new §13 before the summary (`:2210`), §17 hooks row; keep the no-node/no-jq red lines.
- [ ] `.trellis/spec/cli/frontend/hook-guidelines.md` — scenario "Tasks archived for the current user".
- [ ] Confirm the plugin payload ships `hooks/task-archive.sh` (`bash tools/test-bundle.sh`).
- Verify: `bash tools/test-hooks.sh && bash tools/test-bundle.sh && bash tools/verify-skills.sh`

### C9 `feat(dashboard): archive snapshot decode, client and 已完结 wording`

- [ ] `packages/dashboard-app/src/types.ts` (`ProjectSnapshot` `:218-226`), `api/snapshotDecoder.ts` (`decodeProject` `:447-485`),
      `api/boundaryDecoders.test.tsx`.
- [ ] `api/taskLifecycleClient.ts` (+ decoders), `api/taskLifecycleClient.test.tsx`.
- [ ] `workspace/taskModel.ts` — `archivedRowsOf`, `includeCompleted`, summary kind `completed`; `taskModel.test.tsx`.
- [ ] `i18n/translations.ts` — §12 new keys, §13 renames (zh `:153,167,333,337,488,549,1793,1865`; en `:2106,2120,2286,2290,2431,2492,3699,3772`).
- [ ] Update consumers of renamed keys/kinds: `TaskCard.tsx:8-14`, `TaskDetailPane.tsx:17-23`, `TaskListPane.tsx:65-77`.
- Verify: `npm run test:web -- packages/dashboard-app/src/workspace packages/dashboard-app/src/api packages/dashboard-app/src/i18n`

### C10 `feat(dashboard): 归档 / 删除 actions and 已归档 view`

- [ ] `workspace/TaskActionDialog.tsx` (new), `workspace/TaskCard.tsx`, `workspace/TaskDetailPane.tsx`,
      `workspace/TaskListPane.tsx`, `workspace/WorkspaceView.tsx` — §12.
- [ ] `workspace/TaskActions.test.tsx` (new) — §17 dashboard row; update `App.test.tsx` snapshot fixtures if they assert the toggle.
- [ ] `.trellis/spec/dashboard-app/frontend/component-guidelines.md:45-58` — writes allowed in 工作台, 已归档 view, 已完结 wording.
- Verify: `npm run test:web && npm run check:design-scale`
- Rollback point R4: UI only; reverting C10 leaves CLI/server working.

### C11 `test: end-to-end check`

- [ ] `npm run build` in the worktree (not committed), start Dashboard, Playwright script under `.playwright-tmp/`:
      delete an in-progress task (dir gone, `git status` shows deletions, `git log` unchanged, chip `未提交删除 1`),
      archive a build task (list hides, 已归档 shows 实现 · time · actor, files unchanged), unarchive (back, transition works),
      `TENON_USER=b` server still shows it.
- [ ] Record results in this task directory (`research/e2e.md` is allowed; no report files elsewhere).

## Validation (before handing to the main session)

```bash
npx tsc -b packages/kernel packages/automation packages/cli packages/server
npm run check:architecture && npm run check:comments && npm run check:identity && npm run check:docs && npm run check:design-scale
npm test && npm run test:web && bash tools/test-hooks.sh && bash tools/verify-skills.sh
```

## Risky files and mitigations

| File | Risk | Mitigation |
| --- | --- | --- |
| `kernel/src/workspace/task-lifecycle.ts` | recursive removal outside the Change | name grammar + `archive` refusal, `path.relative` containment check, `lstat` no-follow, rename-then-remove only inside `.tenon/users/<slug>/local/deleting/` |
| `kernel/src/state/lock.ts` (read, not edited) | lock held inside a renamed dir | tests for release after rename and waiter failure; do not change lock semantics |
| `server/src/snapshotProjectScan.ts`, `api/snapshotDecoder.ts` | closed decoder rejects a new field → blank Dashboard | ship server + decoder tests in adjacent commits; decoder accepts absence |
| hooks (`router.sh`, `breadcrumb.sh`, `session-start.sh`) | hot-path regression, wrong resume | pure bash, one grep per Change, §13 red-line assertions |
| `i18n/translations.ts` | key rename breaks literal-key test | rename keys and consumers in one commit (C9) |
| `workspace/TaskCard.tsx` | nested interactive elements | menu is a sibling of the card button, never inside |

## Overlap files and merge notes

| File | Also touched by | Note |
| --- | --- | --- |
| `packages/cli/src/program.ts` | multi-user (`user`, `take-over`, `list --mine`), test-evidence (`test run`), review-agents | keep `task`/`list` option additions minimal; `list --archived` and `--mine` combine (archived view ignores `--mine`) |
| `packages/cli/src/commands/status.ts` | multi-user (`--mine`) | one `collectActive` filter chain |
| `commands/transition.ts`, `review.ts`, `document.ts`, `artifact.ts`, `advance.ts` | multi-user owner guard, test-evidence guard | put `refuseArchived` and owner check in one preamble call if multi-user introduced one |
| `packages/server/src/server.ts`, `serverPostRoutes.ts`, `serverMutationRoutes.ts`, `serverGetRoutes.ts` | parent hot list; multi-user (user endpoint), instruction-templates, review-agents | add deps fields at the end of objects; resolve by union |
| `packages/server/src/types.ts`, `snapshotProjectScan.ts`, `dashboard-app/src/types.ts`, `snapshotDecoder.ts` | multi-user (owner/creator), test-evidence (tests), review-agents (agent runs), workflow-io-openspec (output counts) | additive optional fields; rebase decoder changes carefully |
| `hooks/active-change.sh`, `router.sh`, `breadcrumb.sh`, `session-start.sh`, `host-session-binding.sh` | multi-user (pointer path) | apply after multi-user's pointer change; the archived check sits beside the `archived=true` check |
| `tools/test-hooks.sh` | multi-user, data-driven-runner | append §13; renumber on conflict |
| `packages/dashboard-app/src/i18n/translations.ts` | parent hot list; multi-user, workflow-io-openspec, test-evidence, review-agents | only `workspace`/`fields`/`phases`/inbox keys listed in design §12–§13 |
| `workspace/TaskListPane.tsx`, `TaskCard.tsx`, `TaskDetailPane.tsx`, `taskModel.ts`, `WorkspaceView.tsx` | multi-user (owner, user facet), workflow-io-openspec (输出 n/m, no 运行时产物), test-evidence (测试 tab), review-agents | multi-user's user facet sits in the facet grid; our toggles stay in the first row |
| `templates/workflows/default.yaml`, `kernel/src/workflow/default-workflow.generated.ts` | workflow-io-openspec | not edited here; label `完结` comes from that child |
| `.trellis/spec/dashboard-app/frontend/component-guidelines.md`, `docs/CONTRACT.md` | several | edit only the named sections |

## Size

~3.5k lines including tests: kernel ≈ 450 + 550 tests, CLI ≈ 250 + 350, server ≈ 300 + 350, hooks ≈ 60 + 120,
dashboard ≈ 450 + 300, docs/spec ≈ 120. 11 commits.
