# Task Delete and Archive (`kernel/src/workspace/task-{archive,delete,lifecycle}.ts`)

## 1. Scope / Trigger

- 归档 hides a task and its records **for the acting user only**; it is reversible (取消归档), moves no file and needs no
  commit. 删除 physically removes the task from the working tree; it never touches git history or the index, so the user
  commits the removal themselves (未提交删除 n).
- 完结 / 已完结 is a different concept: the workflow's last step. Its state field stays `archived` and `openspec archive`
  is unchanged. Never mix the two words.

## 2. Signatures

```ts
// task-archive.ts — per-user store <repo>/.tenon/users/<slug>/local/archived.json
isTaskLifecycleName(name) // /^[A-Za-z0-9_-]+$/ && name !== 'archive'
taskChangeDir(repoRoot, change) · taskArchivePath(repoRoot, user)
readTaskArchive(repoRoot, user) · readTaskArchiveOf(repoRoot, slug) // → { kind:'ok', archive } | { kind:'corrupt', path }
serializeTaskArchive(archive) · writeTaskArchiveOf(repoRoot, slug, archive) // → written?
withTaskArchiveLock(repoRoot, slug, fn) · updateTaskArchiveOf(repoRoot, slug, edit) · withoutTaskArchiveEntry(archive, change)
isArchivedForUser(repoRoot, userOrMissing, change) · assertTaskNotArchived(repoRoot, userOrMissing, change)
TaskArchivedError { code: 'task-archived', change } · taskArchivedMessage(change)

// task-lifecycle.ts — the one application CLI and server share
createTaskLifecycleApplication(deps): { assess, delete, archive, unarchive }
taskLifecycleUnlockHint(code, change) // afk-running / afk-queued only

// uncommitted-deletions.ts
countUncommittedTaskDeletions(repoRoot, git?) // → number | null
// state/markers.ts
clearReviewMarkerOfChange(root, change) // → removed?
```

## 3. Contracts

- **Store format** (`version: 1`): `changes["<name>"] = { archived_at, phase, actor }`, keys sorted,
  `JSON.stringify(value, null, 2) + '\n'`, temp + rename, mode 0600, under `withLock(localDir)`. A Change key therefore
  always sits on the line `^    "<name>": {$`, which is the ABI `hooks/task-archive.sh` greps — do not reformat it.
- **Fail-open reads, fail-closed writes:** an absent, non-regular, oversized (> 1 MiB) or malformed store reads as empty
  so no command is ever blocked by a display preference; a write reports `archive-store-corrupt` with the path and never
  overwrites it. Entries whose Change directory is gone are dropped on read and on the next write.
- **One implementation:** `createTaskLifecycleApplication` is the only place that decides reasons, writes the store, moves
  the directory and appends audit rows. CLI and server call it; no layer re-derives a reason.
- **Reasons, assessed twice** — once for display, again inside the lock immediately before any write:

  | Code | Detection | delete | archive | Unlock |
  | --- | --- | --- | --- | --- |
  | `afk-running` | `automation ∈ {scheduled, running}` | block | block | `tenon afk cancel <name>` |
  | `afk-queued` | `automation = queued` | confirm | block | `tenon cas <name> automation queued off` |
  | `review-pending` | `reviewGateStatus(state) = pending` | confirm | confirm | acknowledge |
  | `host-session-live` | activity sidecar within `TERMINAL_ACTIVITY_TTL_MS` | confirm | confirm | acknowledge |
  | `has-dependents` | `directChildren(tree, name)` not 完结 | confirm | — | acknowledge |
  | `owned-by-other` | `assignee` set and not the actor | confirm | — | acknowledge |

  A fresh blocker under the lock → `blocked`; a confirmation the caller did not acknowledge → `confirmation-required`
  with the fresh list. CLI `--yes` sends `'all'`; the Dashboard sends exactly the codes it displayed.
- **Delete sequence** under `withLock(changeDir)`: sweep own tombstones → re-assess → `rename` the Change into
  `local/deleting/<name>-<ms>` → clean external references → append the tracked audit row → remove the tombstone →
  count 未提交删除. Every removal is `path.relative`-contained inside the repository and `lstat`s before removing, never
  following a symlink; pointers and bindings are read bounded at 4096 bytes.
- **Cleaned references:** every user's `local/active-change` naming it, every `local/authority` whose `change=` names it,
  the acting user's `.pipeline-pending-{confirm,interaction}` when the pointer was theirs, `.pipeline-pending-review` of
  that Change, `.pipeline/terminal-sessions/*.json` binding it, every user's `tests/<name>/` and
  `local/artifacts/<name>/`, and the entry in every existing `archived.json`. Never touched: git history and index,
  `openspec/changes/archive/**`, preserved AFK worktrees, docs.
- **Audit split:** `delete` → tracked `.tenon/users/<slug>/audit.jsonl` (a shared fact, committed with the removal);
  `archive` / `unarchive` → gitignored `local/audit.jsonl` (personal, never synced). One JSONL row per effective action;
  an idempotent archive or unarchive writes none.
- **Refusal:** `assertTaskNotArchived` is the single archived-Change guard. Every command acting on a Change calls it
  first (transition, advance, review request/acknowledge, document record, artifact register, `tenon test run`,
  `tenon agent`); `get` / `set` / `set-many` / `cas` stay open as the repair path.

## 4. Validation & Error Matrix

| Condition | Outcome | CLI | HTTP |
| --- | --- | --- | --- |
| Name fails the grammar or is `archive` | `invalid-name` | 1 | 400 |
| No state source | `not-found` | 1 | 404 |
| Identity missing | `identity-missing` | 1 + setup hint | 409 |
| Blocker | `blocked` | 3 + unlock hint | 409 `task-blocked` |
| Confirmation not acknowledged | `confirmation-required` | 2 + reasons | 409 `confirmation-required` |
| Store malformed on archive / unarchive | `archive-store-corrupt` | 1 | 409 |
| `rename` fails (EXDEV, EACCES) | `delete-failed`, zero writes | 1 | 500 fixed message |
| Tombstone or another user's store not cleaned | `deleted` + `warnings` | 0 + WARN | 200 |
| Archive already archived / unarchive not archived | `changed: false`, no audit row | 0 | 200 |
| Archived for the actor, progress attempted | `TaskArchivedError` | 1 + 取消归档 hint | 409 `task-archived` |
| Not a git repository | `uncommittedDeletions: null` | line omitted | field omitted |

Every outcome other than `deleted` / `archived` / `unarchived` writes nothing: no rename, no store write, no audit row,
no marker removal.

## 5. Good / Base / Bad Cases

- Good: A archives a task stopped at build; B still sees and advances it in the same repository, and A's 已归档 view
  shows it with 实现 · time · A.
- Base: delete an idle task — the directory is gone, `git status` shows the deletions, `git log` is unchanged, the
  workspace chip reads 未提交删除 1.
- Bad: removing the Change before re-assessing under the lock (an AFK run started meanwhile), `rm -rf` on the Change
  path itself instead of rename-then-remove (a half-deleted Change becomes visible to scans), committing the deletion
  on the user's behalf, or writing a partial store over a malformed one.

## 6. Tests Required

- Kernel: `workspace/task-archive.test.ts` (serializer bytes, corrupt matrix, symlink, 0600, per-user, fail-open),
  `workspace/task-lifecycle.test.ts` (every reason row for both actions, byte-identical refusals, full reference cleanup
  with a surviving second Change, tombstone sweep, audit split, lock-after-rename),
  `workspace/uncommitted-deletions.test.ts` (real repositories), `state/review-marker-clear.test.ts`.
- CLI: `task-lifecycle.integration.test.ts` (exit codes 0/1/2/3, `list --archived`, refusals, two identities),
  `commands/{status,inbox}.test.ts`.
- Server: `serverTaskLifecycleRoutes.test.ts`, `snapshot.test.ts`, `afk.test.ts`.
- Hooks: `tools/test-hooks.sh` archived-for-user section; Dashboard: `TaskActions.test.tsx`, `taskModel.test.tsx`.

## 7. Wrong vs Correct

### Wrong

```ts
// The reason list from the GET is trusted, and the directory is removed in place.
if (reasons.length === 0) await rm(changeDir, { recursive: true })
```

### Correct

```ts
return store.withLock(changeDir, async () => {
  const assessment = await assessKnown(repoRoot, change, 'delete', user) // re-assessed under the lock
  const refusal = refuse(assessment, command.acknowledged)
  if (refusal !== null) return refusal                                   // zero writes
  const tombstone = await stageTaskForDelete(changeDir, paths.deletingDir, change, nowMs())
  // … cleanup, audit, remove tombstone, count 未提交删除
})
```
