# Design: 任务删除与归档 (`09-15-task-delete-archive`)

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X10 use multi-user `userProjectPaths` / `ensureUserLocalDir` and add your audit / deleting fields there; parent §7: test, agent and owner commands refuse archived Changes; X18.

Binding inputs: parent `09-15-tenon-next-capabilities/design.md` (terms §1, identity §2, per-user layout §3, surfaces §7),
this child's `prd.md` (R1–R7) and `research/current-lifecycle.md`. Wave 2: `09-15-multi-user` is merged first.

## 0. Current code (evidence)

| Fact | Where |
| --- | --- |
| A Change is `openspec/changes/<name>/` with canonical `.pipeline-run/current.json` or legacy `.pipeline.yaml`; name grammar `[A-Za-z0-9_-]+` | `kernel/src/state/run-revision-store.ts:73-93`, `cli/src/paths.ts:13-15` |
| `archive` is a reserved sub-directory (OpenSpec archive), skipped by every scan | `server/src/snapshotProjectScan.ts:84`, `server/src/snapshotFingerprint.ts:60`, `cli/src/guardContext.ts:147` |
| `archived` is the workflow-completed field (`transition <name> archived`), unrelated to hiding | `kernel/src/state/workflow-run-repository.ts:74`, `skills/tenon-archive/SKILL.md:95,107` |
| CLI `list` / `status` / `inbox` show Changes with `archived != true` | `cli/src/commands/status.ts:22-36,108-141`, `cli/src/commands/inbox.ts:114-122`, `cli/src/program.ts:253-256` |
| `tenon task <sub>` already is the task lifecycle command (add-dep/remove-dep/children/cascade/canonical) | `cli/src/program.ts:202-206`, `cli/src/commands/task.ts:205-213` |
| No delete/archive anywhere; server creates Changes only | `server/src/serverPostChangesRoutes.ts:143-155` |
| Server write guards: Host → bearer token → JSON; DELETE uses query params | `server/src/serverPostRoutes.ts:156-169`, `server/src/serverMutationRoutes.ts:124-157` |
| Per-change route pattern: name regex → registered root → state exists → 400 | `server/src/serverGetActivityRoutes.ts:139-157`, `server/src/serverPostExecutionRoutes.ts:117-137` |
| Transition / review decision HTTP routes | `server/src/serverPostExecutionRoutes.ts:288`, `server/src/serverPostDecisionRoutes.ts:54` |
| Snapshot builds every Change; aggregates read `projects[].changes` | `server/src/snapshotProjectScan.ts:83-199`, `server/src/snapshot.ts:247-260`, `server/src/afk.ts:144,191`, `dashboard-app/src/App.tsx:216-221` |
| SSE pushes when the fingerprint (state source, tasks.md, documents, activity, repo topology) changes | `server/src/snapshotFingerprint.ts:22-97`, `server/src/serverTransport.ts:50,129`, `server/src/repositoryFingerprint.ts:31-50` |
| Artifact service cache keyed by change dir | `server/src/server.ts:196-208`, `server/src/snapshot.ts` `projectArtifactAttempts` |
| Active pointer / interaction authority are repo-root single files today (multi-user moves them per user) | `cli/src/continuousAuthority.ts:11-13`, `server/src/changeLaunch.ts:127`, `.gitignore:21,40` |
| Review marker is root-level and names its Change; interaction/confirm markers carry no Change | `kernel/src/state/markers.ts:17,94-112`, `hooks/interactive-skill-gate.sh:150`, `hooks/confirm-clear.sh:43-44` |
| Session bindings `.pipeline/terminal-sessions/<id>.json {change}`; activity sidecar in change dir, TTL 120 s | `kernel/src/workspace/terminal-activity.ts:11,14,20`, `cli/src/commands/session.ts:121-145`, `server/src/snapshot.ts:130` |
| AFK queue = `automation` field in change state; scheduler reads directories | `automation/src/queue/scan.ts:45-47`, `automation/src/queue/state-machine.ts:17-29` |
| AFK cancel (running only); `cas automation queued off` is legal | `server/src/afk.ts:225`, `cli/src/commands/afk.ts:164-221`, `cli/src/commands/fields.ts:370-371` |
| Review pending = `review_gate_status=pending` | `kernel/src/state/review-gate.ts:20-23,43-45` |
| Dependents via `depends_on` | `kernel/src/state/tasks.ts:100,255` |
| `withLock` lives inside the change dir; claim `mkdir` is non-recursive; heartbeat and release swallow ENOENT | `kernel/src/state/lock.ts:216,236,278-294` |
| Hooks exclude `archived=true` in every Change loop | `hooks/active-change.sh:22`, `hooks/host-session-binding.sh:34`, `hooks/router.sh:106,157`, `hooks/breadcrumb.sh:65,94,145`, `hooks/session-start.sh:175,217`, `hooks/statusline.sh:76` |
| Dashboard: include-archived toggle, card is one `<button>`, detail footer only copy-link, 工作台 read-only rule | `dashboard-app/src/workspace/TaskListPane.tsx:48,65-77`, `TaskCard.tsx:32-52`, `TaskDetailPane.tsx:84,92-102`, `.trellis/spec/dashboard-app/frontend/component-guidelines.md:47` |
| Completed wording | `dashboard-app/src/i18n/translations.ts:153,167,333,337,488,549,1793,1865` (zh) / `2106,2120,2286,2290,2431,2492,3699,3772` (en); step label `归档` in `templates/workflows/default.yaml:126` (×5) and `kernel/src/workflow/default-workflow.generated.ts:13,22` |
| Kernel already spawns git via `execFile` | `kernel/src/workspace/build-revision-identity.ts:2,8,31` |

## 1. Boundaries

| Layer | Owns | Must not |
| --- | --- | --- |
| kernel `workspace/task-archive.ts` | per-user `archived.json` read/serialize/write, `isArchivedForUser`, `assertTaskNotArchived` | know HTTP, CLI text, React |
| kernel `workspace/task-lifecycle.ts` | reasons assessment, delete / archive / unarchive application (lock, re-check, cleanup, audit) | spawn hosts, call models |
| kernel `workspace/uncommitted-deletions.ts` | `git status` parse → count | run anything but `git status` |
| CLI `commands/task-lifecycle.ts` | argv, `--yes`, text/JSON/exit codes; `archivedGuard.ts` for refusals | re-implement cleanup |
| server `serverTaskLifecycleRoutes.ts` | HTTP mapping, root anchor, cache eviction, viewer identity | import `@tenon/cli` (`tools/check-architecture.mjs:236`) |
| server snapshot | partition `changes` / `archived`, `uncommittedDeletions` | decide reasons |
| dashboard | actions, dialogs, 已归档 view, count chip | compute reasons or touch disk |
| hooks | skip Changes archived for the current user (pure bash) | spawn node / jq |

One implementation: CLI and server both call `createTaskLifecycleApplication` (same pattern as the shared review
application, `.trellis/spec/server/backend/error-handling.md` "Shared application boundary").

## 2. Words

归档 (hide for me), 取消归档, 已归档 (view), 删除, 未提交删除, 完结 / 已完结 (workflow-completed). Reason chips:
评审待确认, AFK 排队, AFK 运行中, 会话活跃, 被依赖, 他人负责. No other copy; errors may be sentences.

## 3. Files and formats

### 3.1 `<repo>/.tenon/users/<slug>/local/archived.json` (gitignored via multi-user)

```json
{
  "version": 1,
  "changes": {
    "add-login": {
      "archived_at": "2026-09-15T12:00:00Z",
      "phase": "build",
      "actor": {
        "id": "a@example.com",
        "name": "A",
        "trust": "declared"
      }
    }
  }
}
```

- Canonical serializer: keys of `changes` sorted, `JSON.stringify(value, null, 2) + '\n'`, written temp + `rename`, mode 0600,
  under `withLock(<local dir>)`. Therefore a Change key is always the line `^    "<name>": {$` (4 spaces) — the bash ABI.
- Missing file → empty. Malformed (bad JSON, `version !== 1`, bad name, missing field) → reads treat as empty
  (display preference, fail-open); writes refuse with `archive-store-corrupt` and the path (never overwrite).
- Entries whose Change directory no longer exists are ignored on read and dropped on the next write.

### 3.2 Audit (`TaskLifecycleAuditRecord`, JSONL, append-only)

```ts
interface TaskLifecycleAuditRecord {
  ts: string
  action: 'delete' | 'archive' | 'unarchive'
  change: string
  phase: string
  actor: { id: string; name: string; trust: 'declared' }
  channel: 'terminal' | 'dashboard'
  acknowledged: TaskLifecycleReasonCode[]
  removed?: string[]          // delete only, repo-relative paths
}
```

- `delete` → tracked `<repo>/.tenon/users/<slug>/audit.jsonl` (shared with the deletion when the user commits).
- `archive` / `unarchive` → gitignored `<repo>/.tenon/users/<slug>/local/audit.jsonl` (personal, never synced).

### 3.3 Tombstones `<repo>/.tenon/users/<slug>/local/deleting/<name>-<epochMs>/`

Delete renames the Change directory here (same filesystem, atomic), then `rm -rf`. Leftovers are swept at the start of the
next delete by the same user. `EXDEV` → `delete-failed`, zero writes.

## 4. Kernel API

```ts
// packages/kernel/src/workspace/task-archive.ts
import type { TenonUser } from '../identity/user.js'          // from multi-user
export const TASK_ARCHIVE_FILE = 'archived.json'
export interface TenonActor { readonly id: string; readonly name: string; readonly trust: 'declared' }
export interface TaskArchiveEntry { readonly archivedAt: string; readonly phase: string; readonly actor: TenonActor }
export interface TaskArchive { readonly version: 1; readonly changes: Readonly<Record<string, TaskArchiveEntry>> }
export type TaskArchiveRead = { readonly kind: 'ok'; readonly archive: TaskArchive } | { readonly kind: 'corrupt'; readonly path: string }
export function taskArchivePath(repoRoot: string, user: TenonUser): string
export async function readTaskArchive(repoRoot: string, user: TenonUser): Promise<TaskArchiveRead>
export function serializeTaskArchive(archive: TaskArchive): string
export async function isArchivedForUser(repoRoot: string, user: TenonUser | { missing: true }, change: string): Promise<boolean>
export class TaskArchivedError extends Error { readonly code: 'task-archived'; readonly change: string }
/** Throws TaskArchivedError; missing identity or corrupt store → returns (fail-open, see §18 D6). */
export async function assertTaskNotArchived(repoRoot: string, user: TenonUser | { missing: true }, change: string): Promise<void>

// packages/kernel/src/workspace/task-lifecycle.ts
export type TaskLifecycleAction = 'delete' | 'archive'
export type TaskLifecycleReasonCode =
  | 'afk-running' | 'afk-queued' | 'review-pending' | 'host-session-live' | 'has-dependents' | 'owned-by-other'
export interface TaskLifecycleReason { readonly code: TaskLifecycleReasonCode; readonly detail?: string }
export interface TaskLifecycleAssessment {
  readonly action: TaskLifecycleAction
  readonly change: string
  readonly phase: string
  readonly blockers: readonly TaskLifecycleReason[]
  readonly confirmations: readonly TaskLifecycleReason[]
}
export interface TaskLifecycleDeps {
  readonly store: StateStore
  readonly clock: () => string
  readonly nowMs: () => number
  /** Hardened sidecar reader supplied by the adapter; must use parseTerminalActivityRecord + liveTerminalActivity. */
  readonly terminalActivityLive: (changeDir: string, change: string, nowMs: number) => Promise<boolean>
  readonly loadTaskTree?: (repoRoot: string, store: StateStore) => Promise<ChangeNode[]>   // default kernel loadTaskTree
  readonly git?: GitStatusRunner                                                               // default execFile git
}
export interface TaskLifecycleCommand {
  readonly repoRoot: string
  readonly change: string
  readonly user: TenonUser | { missing: true }
  readonly channel: 'terminal' | 'dashboard'
  /** CLI `--yes` → 'all'; Dashboard sends the exact codes it displayed. */
  readonly acknowledged: readonly TaskLifecycleReasonCode[] | 'all'
}
export type TaskLifecycleOutcome =
  | { readonly kind: 'deleted'; readonly change: string; readonly removed: readonly string[]; readonly uncommittedDeletions: number | null }
  | { readonly kind: 'archived'; readonly change: string; readonly changed: boolean; readonly entry: TaskArchiveEntry }
  | { readonly kind: 'unarchived'; readonly change: string; readonly changed: boolean }
  | { readonly kind: 'invalid-name'; readonly change: string }
  | { readonly kind: 'not-found'; readonly change: string }
  | { readonly kind: 'identity-missing' }
  | { readonly kind: 'blocked'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'confirmation-required'; readonly reasons: readonly TaskLifecycleReason[] }
  | { readonly kind: 'archive-store-corrupt'; readonly path: string }
  | { readonly kind: 'delete-failed'; readonly cause: string }
export interface TaskLifecycleApplication {
  assess(input: { repoRoot: string; change: string; action: TaskLifecycleAction; user: TenonUser | { missing: true } }): Promise<TaskLifecycleAssessment | Extract<TaskLifecycleOutcome, { kind: 'invalid-name' | 'not-found' }>>
  delete(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  archive(command: TaskLifecycleCommand): Promise<TaskLifecycleOutcome>
  unarchive(command: Omit<TaskLifecycleCommand, 'acknowledged'>): Promise<TaskLifecycleOutcome>
}
export function createTaskLifecycleApplication(deps: TaskLifecycleDeps): TaskLifecycleApplication
export function isTaskLifecycleName(name: string): boolean   // /^[A-Za-z0-9_-]+$/ && name !== 'archive'

// packages/kernel/src/workspace/uncommitted-deletions.ts
export type GitStatusRunner = (repoRoot: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>
export async function countUncommittedTaskDeletions(repoRoot: string, git?: GitStatusRunner): Promise<number | null>

// packages/kernel/src/state/markers.ts (addition)
export async function clearReviewMarkerOfChange(root: string, change: string): Promise<boolean>
```

All exported from `kernel/src/index.ts` next to the `workspace/terminal-activity.js` exports (`index.ts:18-26`).

## 5. Reasons (assessed twice: once for display, again under the lock)

| Code | Detection | delete | archive | Unlock hint (CLI / error text) |
| --- | --- | --- | --- | --- |
| `afk-running` | `automation ∈ {scheduled, running}` | block | block | `tenon afk cancel <name>` |
| `afk-queued` | `automation = queued` | confirm (queue entry disappears with the dir) | block | `tenon cas <name> automation queued off` |
| `review-pending` | `reviewGateStatus(state) === 'pending'` | confirm | confirm | — |
| `host-session-live` | `terminalActivityLive` within `TERMINAL_ACTIVITY_TTL_MS` | confirm | confirm | — |
| `has-dependents` | `directChildren(tree, name)` with `archived != true`; `detail` = names csv | confirm | — | — |
| `owned-by-other` | multi-user `owner` field set and `!== user.id`; `detail` = owner | confirm | — | — |

Under the lock: new blockers → `blocked`; any confirmation code not in `acknowledged` (unless `'all'`) → `confirmation-required`
with the fresh list. Both write nothing.

## 6. Delete sequence and what is removed

Under `withLock(changeDir)`:

1. validate name, state exists, identity present; sweep own `local/deleting/*`.
2. re-assess (§5).
3. `rename(changeDir, local/deleting/<name>-<ms>)` — removes in one step: canonical run store, `.pipeline.yaml`,
   `.pipeline-history.jsonl`, `.pipeline-documents.json`, `.pipeline-agent-runs.jsonl`, `.pipeline-terminal-activity.json`,
   `.breadcrumb`, `.sandcastle-run.log`, orchestration ledger files, tasks/specs, the lock directory itself
   (`release` tolerates it, `lock.ts:283-289`; waiters fail on the non-recursive claim `mkdir`, `lock.ts:236`).
4. external references (each best-effort, collected into `removed`):
   - every `.tenon/users/*/local/active-change` whose content is `<name>` (multi-user); if the active one belonged to the
     current user, also `<repo>/.pipeline-pending-interaction` and `<repo>/.pipeline-pending-confirm`;
   - every `.tenon/users/*/local/authority.json` whose `change` is `<name>`;
   - `<repo>/.pipeline-pending-review` when its v2 `change=<name>` (`clearReviewMarkerOfChange`);
   - `<repo>/.pipeline/terminal-sessions/*.json` whose `change` is `<name>` (regular files ≤ 4096 B only);
   - `.tenon/users/*/tests/<name>/` and `.tenon/users/*/local/artifacts/<name>/` (test-evidence);
   - the `<name>` entry in every `.tenon/users/*/local/archived.json` present in this checkout;
   - legacy `<repo>/.pipeline-active` / `.pipeline-interaction-authority` naming `<name>` only if still present after
     multi-user merges (merge note, not a kept feature).
5. append `delete` audit row (tracked file).
6. `rm -rf` tombstone (failure → warning, swept later).
7. `countUncommittedTaskDeletions`.

Not touched: preserved AFK worktrees (`automation_preserved_path`), git history, `openspec/changes/archive/**`, docs.

## 7. CLI

| Command | Output | Exit |
| --- | --- | --- |
| `tenon task delete <name> [--yes] [--json]` | stderr `[DELETE] <name>` + `未提交删除 <n>`; `--json` stdout `{"change","removed","uncommitted_deletions"}` | 0 ok · 1 usage/name/not found/identity/corrupt/failed · 2 confirmation required (reasons listed, rerun with `--yes`) · 3 blocked |
| `tenon task archive <name> [--yes] [--json]` | stderr `[ARCHIVE] <name> phase=<phase>`; `--json` `{"change","changed","archived_at","phase"}` | same |
| `tenon task unarchive <name> [--json]` | stderr `[UNARCHIVE] <name>`; `--json` `{"change","changed"}` | 0 · 1 |
| `tenon list --archived [--json]` | table `NAME PHASE ARCHIVED_AT BY`; JSON `{"changes":[{"name","phase","archived_at","actor"}]}` | 0 |

- Registration: `task` gets `.option('--yes')` next to `--json` (`program.ts:202-206`); `list` gets `--archived`
  (`program.ts:253-256`). Help text lists the three new subs.
- `tenon list`, `tenon status` (no name) and `tenon inbox` skip Changes archived for the current user
  (`status.ts:29`, `inbox.ts:122`). `tenon status <name>` / `get` / `document status` stay readable.
- Refusal helper `cli/src/archivedGuard.ts`:
  `refuseArchived(deps: CliDeps, name: string): Promise<boolean>` → prints
  `ERROR: 任务 '<name>' 已归档；先执行 tenon task unarchive <name>` and returns true (caller exits 1). Called first in:
  `transition`, `advance`, `review request|acknowledge`, `document record`, `artifact register`; `test run`
  (test-evidence) and agent run (review-agents) call it when they merge. Not in `get/set/set-many/cas` (repair path).

## 8. HTTP

| Route | Auth | Request | 200 body |
| --- | --- | --- | --- |
| `GET /api/change/:name/lifecycle?root=&action=delete\|archive` | loopback read (as `/history`) | — | `{ ok: true, action, phase, blockers: Reason[], confirmations: Reason[] }` |
| `POST /api/change/:name/archive` | token + JSON | `{ root, acknowledged: Code[] }` | `{ ok: true, changed, archived_at, phase }` |
| `POST /api/change/:name/unarchive` | token + JSON | `{ root }` | `{ ok: true, changed }` |
| `DELETE /api/change/:name?root=&acknowledged=a,b` | token | — | `{ ok: true, removed: string[], uncommittedDeletions: number \| null }` |

- File `server/src/serverTaskLifecycleRoutes.ts`: `handleTaskLifecycleGet`, `handleTaskLifecyclePost`,
  `handleTaskLifecycleDelete`; wired in `serverGetRoutes.ts:150-152`, `serverPostRoutes.ts:194-206`,
  `serverMutationRoutes.ts` after the auth block (`:143`). `mutationRouteDeps` (`server.ts:307-322`) and `PostRouteDeps`
  gain `taskLifecycle: { app: TaskLifecycleApplication; viewer(root): TenonUser | { missing: true }; evictChange(changeDir): void }`.
- Root: `workflowRootForRequest(root)` anchor; the application receives `anchor.path`.
- After delete: `evictChange` removes `artifactServices` entry for the change dir (`server.ts:197`).
- Transition (`serverPostExecutionRoutes.ts:288`) and decisions (`serverPostDecisionRoutes.ts:54`) routes call
  `assertTaskNotArchived` before the application → 409 `task-archived`.
- Channel is `dashboard`; actor is the server's `resolveTenonUser(root)` (self-declared, same machine user).

## 9. Filtering for the current user

- `scanAnchoredProject` (`snapshotProjectScan.ts`) reads the viewer archive once per project and pushes each built
  `ChangeSnapshot` into `changes` or `archived` (`ArchivedChangeSnapshot = ChangeSnapshot & { archive: { archivedAt, phase, actor } }`).
- `ProjectSnapshot` (`server/src/types.ts:191-203`, `dashboard-app/src/types.ts:218-226`) gains
  `archived?: ArchivedChangeSnapshot[]` and `uncommittedDeletions?: number` (omitted when not a git repo).
- Automatically filtered because they read `projects[].changes`: `change_count` (`snapshot.ts:250`), `/api/afk/snapshot`,
  `/api/afk/log` (`afk.ts:144,191`), project counts (`App.tsx:221`), inbox selection.
- Not filtered (shared facts): track/workflow reference scans (`serverGovernance.ts:59`), per-change GET routes (detail
  of an archived task stays readable), AFK scheduler scan (archive is blocked while queued, §5).
- Fingerprint (`snapshotFingerprint.ts`) adds lstat of the viewer `archived.json` and `.git/logs/HEAD` so archive,
  unarchive and the user's commit push a new snapshot.
- Hooks: new source-only `hooks/task-archive.sh`:
  `pipeline_change_archived_for_user() { # $1=root $2=change` → `grep -q "^    \"$2\": {\$"` on
  `$(pipeline_user_local_dir "$1")/archived.json` (regular file, not symlink, ≤ 1 MiB). Applied where hooks skip
  `archived=true`: `active-change.sh:22`, `host-session-binding.sh:34`, `router.sh:106,157`, `breadcrumb.sh:65,94,145`,
  `session-start.sh:175,217`, `statusline.sh:76`. The local dir is resolved once per hook run.

## 10. Refusals on archived tasks

| Entry | Result |
| --- | --- |
| `tenon transition/advance/review/document record/artifact register` | exit 1, `ERROR: 任务 '<name>' 已归档；先执行 tenon task unarchive <name>` |
| `POST /api/change/:name/transition`, `/decisions` | 409 `{ ok:false, code:'task-archived', error:'任务已归档，先取消归档' }` |
| Hooks (router / breadcrumb / active-change / host-session-binding) | Change not a candidate, not resumed, no evidence appended |
| Dashboard 已归档 detail | read-only: no ReviewDecisionPanel, no 归档/删除, only 取消归档 |

## 11. Uncommitted deletions

`git -C <root> status --porcelain=v1 -z --untracked-files=no -- openspec/changes` → entries with `X === 'D' || Y === 'D'`,
path `openspec/changes/<name>/…`, `<name> !== 'archive'`, directory absent on disk → count distinct names. Non-zero git exit
or spawn failure → `null`. Server computes per project during snapshot (once per scan); CLI prints after delete.

## 12. Dashboard

| Component | Change | Test ids |
| --- | --- | --- |
| `api/taskLifecycleClient.ts` (new) | `fetchTaskLifecycle`, `archiveTask`, `unarchiveTask`, `deleteTask`; bearer + JSON like `decisionClient.ts:104-117`; closed decoders | — |
| `workspace/TaskActionDialog.tsx` (new) | shared `Dialog` (`shared/Dialog.tsx:38,102`): title `删除 <name>` / `归档 <name>`, reason chips, blocked → error `detail` via `formatApiError`, actions 取消 / 删除 (danger) or 归档; loads reasons on open; 409 `confirmation-required` refreshes chips | `task-action-dialog`, `task-action-reason-<code>`, `task-action-confirm` |
| `TaskCard.tsx` | wrapper `div.relative`: existing `<button>` + sibling `MenuButton` (`shared/MenuButton.tsx`) replacing the chevron; items 归档 / 删除 (`danger`) | `task-card-menu-<name>` |
| `TaskDetailPane.tsx` | footer: 归档, 删除 before 复制链接; archived row: 取消归档 only, no review panel | `task-detail-archive`, `task-detail-delete`, `task-detail-unarchive` |
| `TaskListPane.tsx` | toggle row: `含已完结` (renamed) + `已归档 <n>` (switches list mode) + status chip `未提交删除 <n>` when n > 0 | `task-filter-completed`, `task-view-archived`, `task-uncommitted-deletions` |
| `taskModel.ts` | `archivedRowsOf(snapshot, currentRoot, rulesByKey, t)`; `TaskRow.archive?`; `includeArchived`→`includeCompleted`; summary kind `archived`→`completed` | — |
| `WorkspaceView.tsx` | `listMode: 'active' \| 'archived'` state (reset with root, `:48`); archived mode: search only, no facets; card slug row `<stage> · <time> · <actor>`; after delete/unarchive/archive → `onSelectedChange(null)`, `onRefresh()`, toast `已删除 <name>` / `已归档 <name>` / `已取消归档 <name>` | `task-archived-meta-<name>` |
| `api/snapshotDecoder.ts` | `decodeProject` (`:447-485`) accepts optional `archived[]` (each via `decodeChange` + `archive`) and non-negative integer `uncommittedDeletions` | — |

i18n (`workspace` namespace, zh/en symmetric, `i18n.test.tsx:29-60`): `archive` 归档/Archive, `unarchive` 取消归档/Unarchive,
`delete` 删除/Delete, `archived_view` 已归档/Archived, `uncommitted_deletions` 未提交删除/Uncommitted deletions,
`reason_afk_running` AFK 运行中/AFK running, `reason_afk_queued` AFK 排队/AFK queued, `reason_review_pending` 评审待确认/Review pending,
`reason_host_session_live` 会话活跃/Session live, `reason_has_dependents` 被依赖/Has dependents, `reason_owned_by_other` 他人负责/Owned by other,
`dialog_delete_title` 删除 {name}/Delete {name}, `dialog_archive_title` 归档 {name}/Archive {name},
`archived_meta` {stage} · {time} · {actor}, `done_deleted` 已删除 {name}/Deleted {name}, `done_archived` 已归档 {name}/Archived {name},
`done_unarchived` 已取消归档 {name}/Unarchived {name}.

## 13. 已完结 rename (UI only)

| Key | zh → | en → |
| --- | --- | --- |
| `workspace.include_archived` → `workspace.include_completed` | 含已完结 | Completed |
| `workspace.summary_archived` → `workspace.summary_completed` | 已完结 | Completed |
| `fields.archived` (`:333`) | 已完结 | Completed |
| `phases.archive` (`:337`), inbox `phase_archive` (`:488`) | 完结 | Done |
| `event_archived` (`:549`) | 已完结 | Completed |
| `fold_archived` (`:1793`), `canvas_archived` (`:1865`) | {n} 个已完结 / {n} 项已完结 | {n} completed |

Unchanged: state field `archived`, event `archived`, `openspec archive`, YAML step id `archive`. The YAML step label
`归档`→`完结` (`default.yaml` ×5 + generated) is owned by `09-15-workflow-io-openspec`. `mand_note_archive`
(`:1199`) refers to the step id and stays.

## 14. Data flow

```
Dashboard menu 删除 ─GET lifecycle→ server ─app.assess→ kernel (state, activity, tree) → reasons → dialog
  confirm ─DELETE ?acknowledged→ server ─app.delete→ kernel lock → re-assess → rename → cleanup → audit → rm → count
  ← 200 → onRefresh + SSE (fingerprint: directory gone) → snapshot without the Change, uncommittedDeletions=n
CLI tenon task delete x --yes ─→ same app.delete(acknowledged:'all') → exit 0, 未提交删除 n
Archive: app.archive → withLock(local) → archived.json → local audit → fingerprint(archived.json) → snapshot moves x to archived[]
Refusal: tenon transition x … → refuseArchived → exit 1 ; hooks → pipeline_change_archived_for_user → skip
```

## 15. Compatibility and removals

- Snapshot stays `tenon-snapshot/v2`; new fields optional; older Dashboard ignores them (decoder closed-shape check must
  allow them — updated in the same commit as the server).
- `tenon list` / `status` / `inbox` now hide Changes archived by the current user; `list --json` keys unchanged
  (`status.ts:113-120`). `docs/CONTRACT.md:245-258` rows added for `task delete|archive|unarchive` and `list --archived`.
- Removed: the `含已归档` wording and `TaskFilterState.includeArchived` name; nothing else. No migration (new file).
- Spec updates in this child: `.trellis/spec/dashboard-app/frontend/component-guidelines.md:47-58` (工作台 writes limited to
  归档 / 取消归档 / 删除; summary wording 已完结), `.trellis/spec/cli/frontend/hook-guidelines.md` (archived-for-user bash ABI),
  new `.trellis/spec/kernel/backend/task-lifecycle.md` (§3–§6 contracts).
- `gate.sh:307-309` read-only allowlist already matches `tenon list --archived`; `task archive/delete` stay blocked under
  pending markers (writes).

## 16. Validation and error matrix

| Condition | Kernel outcome | CLI | HTTP |
| --- | --- | --- | --- |
| Name fails grammar or is `archive` | `invalid-name` | 1 | 400 `invalid-name` |
| Root not registered / anchor lost | — | — | 403/404 (existing) |
| No state source | `not-found` | 1 | 404 `task-not-found` |
| Identity missing | `identity-missing` | 1 + setup hint (multi-user text) | 409 `identity-missing` |
| Blocker (`afk-running`; archive + `afk-queued`) | `blocked` | 3 + unlock hint | 409 `task-blocked` `{reasons}` |
| Confirmation not acknowledged | `confirmation-required` | 2 + reasons | 409 `confirmation-required` `{reasons}` |
| New reason appeared between GET and DELETE | `confirmation-required` | — | 409, dialog refreshes |
| `archived.json` corrupt on archive/unarchive/delete cleanup | `archive-store-corrupt` (delete: warning only, entry left) | 1 | 409 `archive-store-corrupt` |
| Rename fails (EXDEV, EACCES) | `delete-failed`, zero writes | 1 | 500 fixed message, no path |
| Tombstone `rm` fails | `deleted` + warning | 0 + `WARN` | 200 |
| Concurrent transition waiting on the lock | waiter fails `withLock` acquire | transition exit 1 | 500 → existing mapping |
| Archive already archived / unarchive not archived | `changed: false`, no audit row | 0 | 200 |
| Transition/review/document record on archived-for-me | `TaskArchivedError` | 1 + unarchive hint | 409 `task-archived` |
| Missing / unauthenticated token on writes | — | — | 401 (existing) |
| Not a git repo | `uncommittedDeletions: null` | count line omitted | field omitted |

Every non-`deleted`/`archived`/`unarchived` outcome writes nothing (no rename, no archive file, no audit, no marker removal).

## 17. Tests required

| File | Assertion points |
| --- | --- |
| `kernel/src/workspace/task-archive.test.ts` | serializer bytes (sorted, 4-space key line, trailing `\n`); missing → empty; corrupt → `corrupt` and write refuses without touching the file; mode 0600; `isArchivedForUser` per user; `assertTaskNotArchived` throws `task-archived`, returns for missing identity |
| `kernel/src/workspace/task-lifecycle.test.ts` | each §5 row for delete and archive; `blocked`/`confirmation-required` leave dir, markers, bindings, archive and audit byte-identical; delete removes dir and every §6 reference for `<name>` while a second Change's review marker, binding, tests and archive entry survive; interaction/confirm markers removed only when `<name>` was the current user's active Change; tombstone swept; audit row shape and file (tracked vs local); archive records `phase`; idempotent archive/unarchive (no second audit row); `invalid-name` for `archive`; lock: a concurrent `withLock` on the Change after rename rejects, no directory recreated |
| `kernel/src/workspace/uncommitted-deletions.test.ts` | real temp repo: two committed Changes, `rm -rf` one → 1; `git rm -r` staged → 1; commit → 0; one file deleted but dir present → 0; `archive/x` deleted → 0; non-repo → `null` |
| `cli/src/task-lifecycle.integration.test.ts` | harness repo: delete → exit 0, `list --json` lacks it, `git status --porcelain` has ` D`, `git rev-list --count HEAD` unchanged, stderr `未提交删除 1`; archive at build → `list` lacks, `list --archived --json` has `phase:"build"`; `transition`/`review request`/`document record` → exit 1 containing `tenon task unarchive`; unarchive → transition succeeds and phase/history unchanged; pending review without `--yes` → exit 2, state intact; with `--yes` → 0; `automation=running` → exit 3; `TENON_USER=a` archives, `TENON_USER=b` `list` still shows and can transition |
| `cli/src/commands/status.test.ts` / `inbox.test.ts` | archived-for-me rows skipped; JSON key order unchanged |
| `server/src/serverTaskLifecycleRoutes.test.ts` | GET reasons; POST/DELETE 401 without token; 409 `confirmation-required` zero writes; DELETE 200 then `/api/snapshot` lacks the Change and `uncommittedDeletions === 1`; archive → snapshot `archived[0].archive.phase === 'build'`, `/api/afk/snapshot` excludes it; viewer b (injected identity) still sees it in `changes`; transition and decisions routes → 409 `task-archived`; artifact cache evicted |
| `server/src/snapshot.test.ts` | fingerprint changes after archive.json write and after a commit (`logs/HEAD`) |
| `dashboard-app/src/workspace/taskModel.test.tsx` | `archivedRowsOf` rows and meta; `summary_completed` text 已完结; `includeCompleted` filter; existing 「已归档的运行没有进行中的阶段」 test renamed to 已完结 |
| `dashboard-app/src/workspace/TaskActions.test.tsx` | card menu → dialog → reasons chips from mocked GET → confirm sends `acknowledged` exactly; blocked disables confirm and shows error; 409 refresh; 已归档 toggle lists archived rows with meta and 取消归档 calls client; `未提交删除 2` chip; no text 已归档 on a completed task; nothing wraps (`whitespace-nowrap` on new rows) |
| `dashboard-app/src/api/boundaryDecoders.test.tsx` | snapshot with/without `archived`, bad `uncommittedDeletions` rejected |
| `dashboard-app/src/i18n/i18n.test.tsx` | existing symmetry/identical/literal-key tests pass with renamed keys |
| `tools/test-hooks.sh` §13 | archived.json of current user names the sole Change → router injects no resume, `active-change.sh` returns 1, session-start list omits it, statusline shows none; another user's archived.json has no effect; file symlink ignored; red line: no node/jq in changed hooks |

## 18. Decisions made during design

- D1 Commands live under `tenon task` (`delete|archive|unarchive`) plus `tenon list --archived`: `task` is already the lifecycle
  command and a top-level `tenon archive` collides with `transition … archived` / `openspec archive`.
- D2 Server hides archived Changes by partitioning the snapshot (`changes` vs `archived`) so every aggregate reading
  `changes` is filtered without per-endpoint code; archived detail stays available from `archived[]`.
- D3 Delete = atomic rename into a per-user gitignored tombstone, then remove; gives zero-write failure and no half-deleted
  Change visible to scans.
- D4 Reasons are computed by kernel only; Dashboard gets them from `GET …/lifecycle` and echoes the codes it showed, server
  re-checks under lock (TOCTOU-safe, no duplicated status logic).
- D5 Archive is blocked while AFK is queued/scheduled/running (the local scheduler would otherwise advance a hidden task);
  delete blocks only scheduled/running.
- D6 Archive state is a view preference: corrupt or unreadable `archived.json` and missing identity never block progress
  (fail-open); writes refuse to overwrite a corrupt file.
- D7 Audit split: delete in tracked `audit.jsonl` (shared fact), archive/unarchive in `local/audit.jsonl` (personal, no sync).
- D8 Added confirmations `has-dependents` and `owned-by-other` (cheap, prevent dangling `depends_on` and silent deletion of
  someone else's task); no owner gate on delete or archive.
- D9 Refusal set = transition, advance, review request/acknowledge, document record, artifact register (+ test run, agent run
  when merged); `get/set/set-many/cas` stay open as the repair path.
- D10 In code, the completed concept is renamed where it sits next to the new archive concept (`includeCompleted`,
  summary kind `completed`, i18n `*_completed`); the state field stays `archived`.
- D11 Uncommitted deletion count covers `openspec/changes` only; per-user test record deletions are not counted separately.
- D12 Idempotent archive/unarchive return success with `changed:false` and no audit row.

## 19. Contract change requests (parent `design.md`, not edited here)

1. §3 per-user layout: add tracked `.tenon/users/<slug>/audit.jsonl`, gitignored `local/audit.jsonl` and `local/deleting/`;
   pin the `archived.json` schema and serializer from §3.1.
2. §2 identity (multi-user): export `TenonActor` and `userDir(repoRoot, user)` / `userLocalDir(repoRoot, user)` from kernel, and a
   pure-bash `hooks/tenon-user.sh` with `pipeline_user_local_dir <root>` (env → config → `git config`, no node) for hooks.
3. §1 terms: add 取消归档 and 未提交删除; §7 surfaces: 工作台 is no longer strictly read-only (归档 / 取消归档 / 删除).
4. §5 records: `.pipeline-agent-runs.jsonl` and per-user tests are removed by delete (owners: review-agents, test-evidence).
5. Command guards: test-evidence (`tenon test run`) and review-agents (agent run) must call `assertTaskNotArchived`; multi-user's
   owner guard should share the same CLI preamble so archived/owner refusals are checked in one place.
</content>
</invoke>
