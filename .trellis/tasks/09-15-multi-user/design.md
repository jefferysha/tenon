# Multi-user collaboration: identity, ownership, per-user state

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X8 as your CR-1..CR-7; X9 fingerprint excludes the whole `.tenon/` directory (not only `.tenon/users`); X10 your helper names are the shared API, keep `userProjectPaths` extendable for sibling path fields (tests, baselines, audit, local/{archived.json, audit.jsonl, deleting, running, env.key, artifacts}); X18.

Binding inputs: `09-15-tenon-next-capabilities/design.md` §1–§3, §5, §7 and this task's `prd.md` (R1–R6).
Section 14 lists the places where this design needs the shared contract to change. Nothing else here deviates
from it.

## 0. Scope

**In scope:**
- one user identity, shared by the CLI, hooks and the Dashboard;
- a per-user project layout `.tenon/users/<slug>/`, replacing the shared `.pipeline-active` and
  `.pipeline-interaction-authority` files;
- a creator and an owner on every task;
- owner-only advancing, with 接手 in both the CLI and the Dashboard;
- `actor` on history, transition, review, document and owner records;
- identity-missing handling;
- Dashboard: a user in the top bar, the owner on task cards, an owner filter, operators on records.

**Out of scope:**
- login, tokens per user, and a permission model;
- the pending markers (`.pipeline-pending-*`), which stay repo-level;
- test and agent record files (`09-15-test-evidence`, `09-15-review-agents`), which consume the API defined here;
- archive state (`09-15-task-delete-archive`), which gets its path from here.

## 1. Current state (evidence)

### No identity anywhere

| Fact | Evidence |
| --- | --- |
| No production code reads `git config user.email` or `user.name` | Agent grep of kernel/cli/server; only tooling uses it, e.g. `tools/test-adapters.sh:762` |
| `TransitionRecord.actor?: string` exists but is deliberately never filled | `packages/kernel/src/workflow/run-types.ts:79-81`; commit draft has no actor at `workflow/transition-application.ts:383-385`; the record store already accepts a string `actor` at `state/transition-record-store.ts:73-76,94-96` |
| Review acknowledgement stores only the entry route | `kernel/src/review-gate-fields.ts:31-32`; review history row `decision/review-interaction.ts:108-122`; interaction events use `actor: 'system'` (`cli/src/interaction-emitter.ts:97-98`, `.trellis/spec/server/backend/decision-sync.md:135-137`) |
| Orchestration v2 actor ids are hard-coded | `cli/src/commands/orchestration.ts:103,145,183`; `dashboard-app/src/api/orchestrationV2Client.ts:105` |
| The Dashboard token belongs to the machine, not a user | `server/src/main.ts:113,144`; `server/src/transition.ts:328-331` ("token is not human evidence") |

### Task fields and history

| Fact | Evidence |
| --- | --- |
| `created_by` and `assignee` are already closed-set state fields | `kernel/src/types.ts:21` |
| `init` writes `created_by` from `--user`, or `'unknown'`; `assignee` becomes `'null'` | `state/store.ts:424-432`, `state/state-init.ts:93-94`, `cli/src/program.ts:80`, `cli/src/commands/init.ts:119,236,241-245` |
| The Dashboard create route passes no user | `server/src/serverPostChangesRoutes.ts:243-260,291` |
| The canonical state codec rejects any key outside `FIELD_ORDER` | `state/run-revision-codec.ts:272-275`; new fields must be appended at the end (`types.ts:30-34`) |
| YAML values may not contain `": "` or `" #"`, a newline, or a leading quote | `state/parse.ts:65-79` |
| Anyone can `tenon set assignee`; only `phase` and the review fields are protected | `cli/src/commands/fields.ts:220-226` |
| History rows carry only `by?: string`, written only by `init --user` | `types.ts:404-425`, `state/history.ts:13-36`; server decoder `server/src/transitionHistory.ts:17-39`; Dashboard decoder `dashboard-app/src/api/governanceDecoders.ts:64-87` |
| No Dashboard page reads history | `getHistory` has no caller (`api/governanceClient.ts:154-165`) |

### Where writes happen

| Write | Evidence |
| --- | --- |
| Transition use case (shared by CLI and server) | `transition-application.ts:267-270`; CLI `cli/src/commands/transition.ts:120,173-185` with exit mapping at `:187-295`; server `server/src/transition.ts:296,335-347`; `advance` goes through `cmdTransition` (`cli/src/commands/advance-support.ts:65-80`) |
| Review request | `cli/src/commands/review.ts:181-230`, history at `:262-268` |
| Review acknowledge (shared application) | `kernel/src/decision/review-application.ts:29-66,238-261`; CLI `cli/src/commands/review-acknowledge.ts:56-84`; server `server/src/serverPostDecisionRoutes.ts:103-139` |
| Document record | `cli/src/commands/document.ts:206-278` (lock `:222`, state read `:224`); ledger row type `state/document-ledger.ts:53-63`, built at `:341-355`, decoded at `:135-175`; automation submission `automation/src/submission/service.ts:9,98`, `adapters.ts:18` |

### Shared per-repo files

**`.pipeline-active`**
- Written by `cli/src/commands/session.ts:193-195`.
- Read back by `server/src/changeLaunch.ts:127-137` (Dashboard activation).
- Read by `hooks/active-change.sh:9-24`, which is sourced by:
  `gate.sh:381-386`, `skill-tracker.sh:81-84`, `skill-start.sh:46-48`, `decision-recorder.sh:88-91`,
  `codex-skill-receipt.sh:63-67`, `review-ack.sh:41-55`, `confirm-clear-prompt.sh:94-116,129-146`,
  `interactive-skill-gate.sh:98-114`.
- Also read inline by `hooks/breadcrumb.sh:52-73` and `hooks/router.sh:146-164`, and by
  `cli/src/continuousAuthority.ts:74-90`.
- Excluded from the workspace fingerprint (`kernel/src/workspace/fingerprint.ts:52-58`).
- Test fixtures write it in `tools/test-hooks.sh` (25 sites), `tools/test-adapters.sh` (6),
  `cli/src/integration-phase-skill-test-support.ts:21`, `server/src/test-support.ts:73`, `server/src/server.test.ts:5527`.

**`.pipeline-interaction-authority`**
- Written by `cli/src/commands/session.ts:147-177` and `hooks/interaction-authority.sh:107-129`.
- Parsed with the same v2 grammar in `continuousAuthority.ts:43-68` and `interaction-authority.sh:32-77`.

### Environment and boundaries

| Fact | Evidence |
| --- | --- |
| Hooks inherit the full host env plus `TENON_RUNTIME_CONFIG_ROOT` | `runtime/tenon-bootstrap.mjs:923-952,1048-1051` |
| A bash config-root precedent already exists | `hooks/auto-update.sh:14-22` |
| Hot-path hooks are pure bash with no git/node spawn; the router's HOT PATH section forbids node/python/jq | `hooks/project-root.sh:9`, `tools/test-hooks.sh:876-889` |
| AFK sandboxes set their own git identity and build their env in `createSandbox` | `tools/sandcastle/tenon-afk-run.sh:34-35`, `automation/src/lifecycle/ports.ts:331` |
| Product file names must come from `resolveProductPaths` | `tools/check-architecture.mjs:424-427`, `kernel/src/product-paths.ts:102-161` |
| Kernel "domain" directories may not import `node:`; `users/` is not one of them | `check-architecture.mjs:254-274,388-392`; precedent `workspace/build-revision-identity.ts:31-33` |

**Size limits on target files** (`check-architecture.mjs:309-341`, checker counts):
`cli/commands/fields.ts` 400/400, `kernel/state/store.ts` 498/500, `kernel/state/document-ledger.ts` 493/500,
`cli/commands/document.ts` 396/400, `kernel/types.ts` 443/450, `workflow/transition-application.ts` 439/450,
`cli/program.ts` 393/400.

### Dashboard today

- Task filter is workflow → track → stage (`dashboard-app/src/workspace/TaskListPane.tsx:25-84`, `taskModel.ts:159-232`).
- Card slug line is `[project] · workflow · track` (`TaskCard.tsx:27-30`).
- Top bar right cluster: `conn-indicator` then settings (`shell/TopBar.tsx:173-237`).

## 2. Architecture and boundaries

```
 TENON_USER(+_NAME) ─┐
 <configRoot>/user.json ─┼─► kernel users/resolve-user.ts: resolveTenonUser(repoRoot?, env)
 git config user.email/name ─┘        │                                   hooks/tenon-user.sh (bash mirror: id + slug)
                                      ▼                                          │
                         TenonUser { id, name, slug, source, trust }            ▼
             ┌────────────────────────┼─────────────────────────┐   .tenon/users/<slug>/local/{active-change,authority}
             ▼                        ▼                         ▼
   CLI deps.user() → requireActor   server options.resolveUser(root)   kernel users/user-paths.ts
             │                        │                                 (CLI session, server changeLaunch,
             ▼                        ▼                                  test-evidence, task-delete-archive)
   kernel users/owner.ts (pure guard) ─► transition-application, review request, document record, owner transfer,
                                          test run (test-evidence), agent run (review-agents)
   actor ─► history rows · transition record · review ack history · document ledger · owner change row
```

- **New kernel module `packages/kernel/src/users/`.** It is not in the domain list, so file and process access are
  allowed there.
  - `user.ts` and `owner.ts` stay pure (no `node:` imports). `workflow/transition-application.ts` imports only these two,
    with `import type` for types.
  - `resolve-user.ts` runs `git` with `execFileSync`, like `workspace/build-revision-identity.ts`.
- **The server never imports the CLI.** Owner transfer is a kernel use case called by both.
- **Hooks never call node.** They resolve the slug in pure bash and spawn `git` only when the env and the config file
  do not decide.
- **The Dashboard never resolves identity.** It reads `GET /api/user` and the snapshot's `owner` / `creator`.

## 3. Data model

### 3.1 TypeScript

```ts
// packages/kernel/src/users/user.ts  (pure)
export type UserSource = 'env' | 'config' | 'git'
export interface TenonUser {
  readonly id: string          // email: printable ASCII, exactly one '@', 3..200 chars, no '<' '>'
  readonly name: string        // 1..100 chars; invalid or absent → local part of id
  readonly slug: string
  readonly source: UserSource
  readonly trust: 'declared'
}
export interface TenonUserMissing { readonly missing: true; readonly invalid?: UserSource }
export type TenonUserResolution = TenonUser | TenonUserMissing
export interface RecordActor { readonly id: string; readonly name: string; readonly trust: 'declared' }
export interface UserRef { readonly id: string; readonly name: string; readonly slug: string }

export function isTenonUser(value: TenonUserResolution): value is TenonUser
export function validateUserId(raw: string): string | null                 // trimmed id or null
export function normalizeUserName(raw: string | undefined, id: string): string
export function userSlug(id: string): string
export function actorOf(user: Pick<TenonUser, 'id' | 'name'>): RecordActor
export function formatUserRef(user: Pick<RecordActor, 'id' | 'name'>): string // "Jeff Sha <jeff@example.com>"
export function parseUserRef(value: string | readonly string[] | undefined): UserRef | null
export function decodeRecordActor(value: unknown): RecordActor | undefined | null // absent | invalid
export const USER_MISSING_HINT =
  '未设置用户身份；运行 tenon user set <邮箱> --name <名字>，或 git config --global user.email <邮箱>'
```

- **Slug.** `id.toLowerCase()`, then `@` → `-at-`, then `[^a-z0-9._-]` → `-`, then runs of `-` collapsed.
  - Because an id is ASCII with one `@`, every slug is non-empty, contains `-at-`, and can never be `.` or `..`.
- **Name.** A name is rejected, and replaced by the id's local part, when it contains `<`, `>`, a control character,
  `": "` or `" #"`, or starts with a quote.
  - This keeps `formatUserRef` output inside the YAML quote gate (`state/parse.ts:65-79`).

```ts
// packages/kernel/src/users/resolve-user.ts
export function resolveTenonUser(repoRoot?: string, env: NodeJS.ProcessEnv = process.env): TenonUserResolution
export function readUserConfig(path: string): { id: string; name: string } | 'absent' | 'invalid'
export async function writeUserConfig(path: string, input: { id: string; name?: string }): Promise<void>

// packages/kernel/src/users/user-paths.ts
export const TENON_PROJECT_DIR = '.tenon'
export interface UserProjectPaths {
  readonly userRoot: string        // <repo>/.tenon/users/<slug>
  readonly testsDir: string        // <userRoot>/tests           (test-evidence)
  readonly baselinesDir: string    // <userRoot>/baselines       (test-evidence)
  readonly localDir: string        // <userRoot>/local           (ignored by git)
  readonly activeChange: string    // <localDir>/active-change
  readonly authority: string       // <localDir>/authority
  readonly archived: string        // <localDir>/archived.json   (task-delete-archive)
  readonly artifactsDir: string    // <localDir>/artifacts       (test-evidence)
}
export function userProjectPaths(repoRoot: string, slug: string): UserProjectPaths
export async function ensureUserLocalDir(repoRoot: string, slug: string): Promise<UserProjectPaths>

// packages/kernel/src/users/active-change.ts
export async function readActiveChange(repoRoot: string, slug: string): Promise<string | null>
export async function writeActiveChange(repoRoot: string, slug: string, change: string): Promise<void>

// packages/kernel/src/users/owner.ts  (pure)
export type OwnerDecision = { readonly allowed: true } | { readonly allowed: false; readonly owner: UserRef | null }
export function ownerOf(fields: Readonly<Record<FieldName, string | string[]>>): UserRef | null   // assignee
export function creatorOf(fields: Readonly<Record<FieldName, string | string[]>>): UserRef | null // created_by
export function ownerDecision(fields: Readonly<Record<FieldName, string | string[]>>, actor: RecordActor): OwnerDecision
export function ownerRequiredMessage(change: string, owner: UserRef | null): string
export class OwnerRequiredError extends Error {                 // message = ownerRequiredMessage(...)
  readonly code: 'owner-required'
  constructor(readonly change: string, readonly owner: UserRef | null)
}
export function assertOwner(change: string, fields: Readonly<Record<FieldName, string | string[]>>, actor: RecordActor): void

// packages/kernel/src/users/owner-transfer.ts
export type OwnerTransferResult =
  | { readonly kind: 'changed'; readonly from: UserRef | null; readonly to: UserRef }
  | { readonly kind: 'unchanged'; readonly to: UserRef }
  | { readonly kind: 'owner-required'; readonly owner: UserRef | null }
export async function transferOwner(
  deps: { readonly store: StateStore; readonly history?: HistoryWriter; readonly clock: () => string },
  input: { readonly changeDir: string; readonly change: string; readonly actor: RecordActor; readonly to?: RecordActor },
): Promise<OwnerTransferResult>
```

**How `transferOwner` behaves**
- `to` omitted means take over: anyone may do it.
- `to` present means hand over: only the current owner may. Otherwise it returns `owner-required` with zero writes.
- The write sequence:
  1. Take `store.withLock(changeDir)` and read the state.
  2. Decide.
  3. `writeUnderLock(changeDir, next, { kind: 'set' })` with `assignee = formatUserRef(to)`. This is the same mutation
     shape as `cli/src/commands/artifact.ts:119`.
  4. Append the history row after the lock (best-effort, like `fields.ts:24-31`).

**Changes to existing types**

| Location | Change |
| --- | --- |
| `kernel/src/types.ts:207` | `InitOptions.user?: string` → `creator: RecordActor`, required |
| `kernel/src/types.ts:404-425` | `HistoryEntry.by?: string` removed; `actor?: RecordActor` added |
| `kernel/src/state/history.ts:13` | `createHistoryWriter(options?: { readonly actor?: () => RecordActor \| undefined })` fills `actor` on rows that lack one |
| `kernel/src/state/history.ts:27-36` | `transitionRecordToHistoryEntry` fills `actor` from `parseUserRef(record.actor)` |
| `workflow/run-types.ts:79-81,92` | `TransitionRecord.actor` / `TransitionDraft.actor` stay `string`; the value is now `formatUserRef(actor)` (see CR-5); comment replaced |
| `workflow/transition-application-types.ts:47-54` | `TransitionCommand.actor: RecordActor`, required |
| `workflow/transition-application-types.ts:70-122` | new result `{ kind: 'owner-required'; owner: UserRef \| null }` |
| `decision/review-application.ts:48-66` | `ReviewAcknowledgePorts.actor: RecordActor`, required; passed into `reviewAcknowledgeHistoryEntry` (`review-interaction.ts:108-122`) |
| `state/document-ledger.ts:53-63,242-257,341-355,135-175` | `DocumentRecord.actor?`; `RecordDocumentLedgerInput.actor?`; set on construction; decoded with `decodeRecordActor` |
| `documents/document-recording.ts:74-85` | `RecordDocumentInput.actor?` |
| `automation/src/submission/service.ts:9,37-38,98` and `adapters.ts:18` | the document submission input carries `actor` |
| `state/document-evidence.ts:114,152-160` | timeline entries gain `actor?: { id; name }` |
| `product-paths.ts:14-34,142-160` | `ProductPaths.userConfigPath = join(configRoot, 'user.json')` |

### 3.2 Files and formats

| File | Content |
| --- | --- |
| `<configRoot>/user.json` | `{"id":"jeff@example.com","name":"Jeff Sha"}\n`. Written atomically (temp + rename); refuses a symlink target. Decoder needs an object with a valid string `id`; `name` is an optional string; extra keys are ignored, matching the bash reader. |
| `.pipeline.yaml` / canonical fields | `created_by: Jeff Sha <jeff@example.com>` and `assignee: Jeff Sha <jeff@example.com>`. Values like `unknown`, `null` or a bare name are unowned. |
| `.pipeline-transitions/<seq>-<id>.json` | `"actor": "Jeff Sha <jeff@example.com>"` |
| `.pipeline-history.jsonl` | `…,"actor":{"id":"jeff@example.com","name":"Jeff Sha","trust":"declared"}`. Owner change: `{"ts":…,"kind":"set","field":"assignee","from":"Ann <ann@x.io>","to":"Jeff Sha <jeff@example.com>","actor":{…}}` |
| `.pipeline-documents.json` record | adds `"actor":{…}` |

```
<repo>/.tenon/.gitignore                 # tracked; created once when absent, never rewritten: "users/*/local/\n"
<repo>/.tenon/users/<slug>/
  tests/<change>/<run-id>.json           # test-evidence
  baselines/<test-id>.json               # test-evidence
  local/                                 # 0700, ignored
    active-change                        # "<change>\n" (grammar [A-Za-z0-9_-]+, as before)
    authority                            # pipeline-interaction-authority-v2 lines, grammar unchanged, 0600
    archived.json                        # task-delete-archive
    artifacts/<change>/<run-id>/         # test-evidence
```

### 3.3 Identity resolution (TypeScript and bash identical)

1. **Environment.** If `TENON_USER` is non-empty after trimming, validate it.
   - Valid: the name comes from `TENON_USER_NAME`. `source: 'env'`.
   - Invalid: `{ missing: true, invalid: 'env' }`. The lower sources are not consulted.
2. **Config file.** If `userConfigPath` exists, decode it.
   - Valid: `source: 'config'`.
   - Invalid: `{ missing: true, invalid: 'config' }`.
3. **Git.** Run `git config --get user.email` with `cwd = repoRoot`. Git's effective value is repo first, then global,
   then system. Without a `repoRoot`, use `git config --global --get user.email`.
   - Run options: `execFileSync`, `timeout: 1500`, `maxBuffer: 4096`, `env` passed through.
   - Absent, or git failed: `{ missing: true }`. Invalid: `{ missing: true, invalid: 'git' }`.
   - The name comes from `git config --get user.name` in the same scope.
4. Sources are never mixed. For example, an env id never takes its name from git.

**Bash mirror, `hooks/tenon-user.sh`** (source-only, Bash 3.2, no node/jq).
- It sources `json-input.sh` when `pipeline_json_get_string` is undefined.
- Functions:
  - `pipeline_user_config_path`
  - `pipeline_user_valid_id <id>`
  - `pipeline_user_id <root>`, which prints the id or returns 1
  - `pipeline_user_slug_of <id>`, which loops over characters in pure bash with `LC_ALL=C`: a lookup table lowercases
    A–Z, and `-` is never appended after `-`
  - `pipeline_user_slug <root>`
  - `pipeline_user_local_dir <root>`
  - `pipeline_ensure_user_local_dir <root>`, which runs `umask 077; mkdir -p` and writes `.tenon/.gitignore` when absent
- Config root order: `TENON_RUNTIME_ROOTS.configRoot` (via `pipeline_json_get_string`), then
  `TENON_RUNTIME_CONFIG_ROOT`, then `$TENON_RUNTIME_HOME/config`, then Darwin
  `$HOME/Library/Application Support/tenon/config`, then `${XDG_CONFIG_HOME:-$HOME/.config}/tenon`. This mirrors
  `product-paths.ts:107-140` and `auto-update.sh:16-22`.
- `user.json` is read only when it is a regular file of 4096 bytes or less.
- Bash only needs the id and the slug, so it never reads names.

## 4. CLI

| Command | Behaviour | Exit |
| --- | --- | --- |
| `tenon user [--json]` | stdout `Jeff Sha <jeff@example.com> git`. `--json`: `{"user":{"id","name","slug","source","trust"}}` or `{"user":null,"invalid":"env"}` | 0 when set; 1 when missing, with `ERROR: <USER_MISSING_HINT>` on stderr |
| `tenon user set <id> [--name <name>]` | validates, runs `writeUserConfig(userConfigPath)`, prints the resolved user. When `TENON_USER` overrides the file, stderr `WARN: TENON_USER 覆盖本机配置` | 0; 1 on an invalid id |
| `tenon owner take <change>` | 接手: owner becomes the current user; history row. stdout = new owner ref | 0 (also when already the owner); 1 when identity is missing or the change is unknown |
| `tenon owner set <change> <id> [--name <name>]` | hand over; only the current owner may | 0; 1 with the owner-required message |

**Registration and helpers**
- Commands are registered in a new `packages/cli/src/program-users.ts`. `program.ts` gains one import and one call, and
  loses `--user` (`:80`).
- New `packages/cli/src/userIdentity.ts`:
  `requireUser(deps): TenonUser | null` and `requireActor(deps): RecordActor | null`. Both print
  `ERROR: ${USER_MISSING_HINT}`.
- `CliDeps.user: () => TenonUserResolution` (`deps.ts`), memoized in `main.ts`. The integration harness defaults to
  `resolveTenonUser(cwd, process.env)`.
- `tools/vitest.isolate-runtime-home.mjs` sets `TENON_USER=tester@tenon.test` and `TENON_USER_NAME=Tester` when unset.

**Identity required** (exit 1, zero writes):
`init`, `session activate`, `transition`, `advance`, `review request`, `review acknowledge`, `document record`,
`owner take|set`.

**Owner only** (exit 1, zero writes; stderr `ERROR: <ownerRequiredMessage>`):
- `transition` and `advance`, through the kernel application.
- `review request`: `assertOwner` right after `store.read` inside the lock at `review.ts:181-183`.
- `document record`: `assertOwner` after `store.read` at `document.ts:224`.
- Later children call the exported `assertOwner` for `tenon test run` and agent runs.

**Messages**
- Owned by someone else: `任务 <change> 的负责人是 Ann <ann@x.io>；先接手：tenon owner take <change>`
- Unowned: `任务 <change> 没有负责人；先接手：tenon owner take <change>`

**Not gated.** `set`, `set-many`, `cas`, `artifact register`, `task add-dep`, `import` and `afk` rows still get an
`actor` stamped by the history writer when identity resolves.

**Protected fields.** `created_by` and `assignee` join `phase` in `rejectProtectedField` (`fields.ts:220-226`). This is
a same-line edit, because the file is at its size limit.

**`tenon status`** (`status.ts:112-136`)
- The JSON list key `assignee` is replaced by `owner: {id,name} | null`.
- The table header `ASSIGNEE` becomes `OWNER` and shows the name, or `-`.

**Removed:** `init --user`, the wizard prompt (`init.ts:119,125`), and the `created_by = 'unknown'` fallback
(`store.ts:424-432`).

## 5. HTTP (packages/server)

`server.ts` gains the option `resolveUser?: (root: string) => TenonUserResolution`, following the options pattern at
`:91-198`. The default is `root === '' ? resolveTenonUser(undefined, process.env) : resolveTenonUser(root, process.env)`.
There is one resolver per request.

| Route | Guard | Request | Response |
| --- | --- | --- | --- |
| `GET /api/user?root=` (new) | Host check (`serverGetActivityRoutes.ts:42-44`); a non-empty root must pass `isRegisteredRoot` → 404 | — | 200 `{"ok":true,"user":{id,name,slug,source,trust}}` or `{"ok":true,"user":null,"invalid"?:"env"\|"config"\|"git"}` |
| `POST /api/user` (new) | Host, token, JSON (`serverPostRoutes.ts:156-169`) | exact keys `{"id":string,"name":string}` | 200, same body as GET for root `''`; 400 `{"ok":false,"code":"invalid-user","error":"…"}` |
| `POST /api/change/:name/owner` (new) | Host, token, JSON; registered root → 404; change exists → 404 | `{"root":string}` (take over only) | 200 `{"ok":true,"owner":{id,name,slug},"changed":bool}`; 412 `{"ok":false,"code":"user-missing","error":"…"}` |
| `POST /api/change/:name/transition` (changed) | unchanged | unchanged | adds 412 `user-missing` and 403 `{"ok":false,"code":"owner-required","owner":{id,name,slug}\|null,"error":"…"}` |
| `POST /api/change/:name/decisions` (changed) | unchanged | unchanged | adds 412 `user-missing`; the acknowledge history row carries `actor` |
| `POST /api/changes` (changed) | unchanged | unchanged | 412 `user-missing` before the registry lock; `creator` = resolved actor; init history row carries `actor` |
| `GET /api/snapshot` (changed) | — | — | each change gains `owner` and `creator` (`{id,name,slug} \| null`); document timeline entries gain `actor?: {id,name}` |
| `GET /api/change/:name/history` (changed) | — | — | entries: `by` removed, `actor?: {id,name,trust}` added |

**Placement**
- New file `server/src/serverUserRoutes.ts`:
  - `handleGetUserRoute(req, res, path, deps): Promise<boolean>`, called in `serverGetActivityRoutes.ts` after the Host
    check.
  - `handlePostUserRoutes(req, res, path, deps)`, inserted in `serverPostRoutes.ts` before `handlePostExecutionRoutes`
    (`:204`), because that router ends in a 404 (`serverPostExecutionRoutes.ts:289`).
- `performTransition(deps, root, name, event)` (`transition.ts:228-233`): `deps.resolveUser(root)` gives 412, otherwise
  `command.actor`; `mapTransitionResult` maps `owner-required` to 403.
- Snapshot: `ownerOf` / `creatorOf` are computed in `snapshotProjectScan.ts:138-164` and `changeSnapshot.ts:362-380`.
  The type change is in `server/src/types.ts:37-73,111`.
- `activateChangeSession` (`changeLaunch.ts:107-140`) takes `userSlug` and verifies with `readActiveChange`. The runner
  child inherits the server env (`operations.ts:52`), so the CLI resolves the same identity.

## 6. Hooks

| File | Change |
| --- | --- |
| `hooks/tenon-user.sh` (new, executable) | bash mirror from §3.3 |
| `hooks/active-change.sh:9-24` | sources `tenon-user.sh`; the pointer is `$(pipeline_user_local_dir "$root")/active-change`; missing identity → return 1 (no selected Change) |
| `hooks/interaction-authority.sh:12-17,107-139` | the path is `$(pipeline_user_local_dir "$1")/authority`; the temp file is `$marker.$$`; the writer calls `pipeline_ensure_user_local_dir`; grammar and functions unchanged |
| `hooks/router.sh:146-164`, `hooks/breadcrumb.sh:52-73` | the inline pointer read is replaced by `pipeline_active_change_dir` (both already source `canonical-state.sh`) |
| gate, skill-tracker, skill-start, decision-recorder, codex-skill-receipt, review-ack, confirm-clear-prompt, interactive-skill-gate | no code change; they go through `active-change.sh` |
| `prompt-intent.sh:4,146`, `terminal-activity.sh:4`, `host-session-binding.sh:5`, `adapters/codex/hooks/prompt.sh:11` | comments name the per-user pointer |
| `tools/verify-skills.sh:195-203` | adds `hooks/tenon-user.sh` (release payload also runs `bash -n` on every hook, `release-payload.ts:298-300`) |

Hooks still never block on owner rules; the CLI does.

## 7. Dashboard (packages/dashboard-app)

### New files

| File | Content |
| --- | --- |
| `api/userClient.ts` | `CurrentUserState = { kind: 'set'; user: CurrentUser } \| { kind: 'missing'; invalid?: UserSource }`; `fetchCurrentUser(root)`; `saveUser({id,name})`; `takeOwner(root, change)`. Uses the POST pattern of `snapshotClient.ts:24-39` and `formatApiError` from `transport.ts:37-55`. |
| `state/useCurrentUser.ts` | `useCurrentUser(root: string): { state: CurrentUserState \| null; refresh(): void }`. Refetches on root change and after save. |
| `shell/UserDialog.tsx` | shared `Dialog` (`shared/Dialog.tsx:102`), testid `user-dialog`; inputs `user-dialog-id` (label 邮箱) and `user-dialog-name` (label 名字); actions 取消 / 保存 (`user-dialog-save`, disabled without a token or with an empty id); error `user-dialog-error` |
| `workspace/TaskRecords.tsx` | section 记录 (`task-records`). One `li[data-kind]` per mapped history row: `time · label · actor name` (`—` when absent). |

**How `TaskRecords` labels rows**
- `init` → 创建
- `transition` → `<from> → <to>`
- `set` on `assignee` → 负责人 plus the new name
- `tool` with `review:request` → 评审请求; `review:acknowledge` → 评审确认
- anything else is skipped
- Refetch when the snapshot signature changes, as `ReviewDecisionPanel` does.

### Changed files

| File | Change |
| --- | --- |
| `types.ts`, `api/snapshotDecoder.ts:158-224,86-98` | `ChangeSnapshot.owner` / `creator: UserRefView \| null` are required keys with an exact `{id,name,slug}` shape; timeline `actor?` |
| `api/governanceTypes.ts:17-25`, `api/governanceDecoders.ts:64-87` | history `by` → `actor?: {id,name,trust}` |
| `shell/TopBar.tsx:15-28,173-182` | props `user: CurrentUserState \| null`, `onUser(): void`. Before `conn-indicator`: `top-bar-user` (User icon + name, `whitespace-nowrap truncate`, `title=id`, `data-source`) or `top-bar-user-missing` (label 未设置, warn tone). Both open `UserDialog`. |
| `App.tsx:114,240-252` | `useCurrentUser(currentRoot)` (root `''` in the aggregate view); dialog state; passes `me` to `WorkspaceView` |
| `workspace/taskModel.ts:25-34,159-232` | `TaskRow.owner: UserRefView \| null`; `TaskFilterState.owner: 'all' \| <slug>` (default `'all'`); `matches` ignore key `'owner'`; `TaskFacets.owners: FacetChip[]` (id = slug, label = name); `FacetChip.testKey?`; `facetTotal` facet union adds `'owner'` |
| `workspace/TaskListPane.tsx:25-84` | first row `FacetRow facet="owner"`, label 负责人: 全部, then 我的 (`task-facet-owner-me`, only when `me` is set), then other owners (`task-facet-owner-<slug>`). Shown when any row has an owner or `me` is set. |
| `workspace/TaskCard.tsx:27-47` | slug adds `row.owner?.name`; button `data-owner=<slug>` |
| `workspace/TaskDetailPane.tsx:76-101` | header meta line `workflow · track · owner name`. Footer button 接手 (`task-detail-take`), shown only when a project is selected (the same flag as `showReviewConsole`, `WorkspaceView.tsx:131`), `me` is set, `owner.slug !== me.slug`, and `getToken() !== ''`. It calls `takeOwner`, refreshes, and toasts 已接手. A 412 opens `UserDialog`; other errors toast `formatApiError`. `TaskRecords` renders under the same project-selected flag, so the aggregate view still issues only `/api/snapshot`. |
| `workspace/stageIo.ts:43-44`, `workspace/StageIoPanel.tsx:40` | row meta `file · producer · actor name · time` |
| `workspace/WorkspaceView.tsx:40-48` | owner filter resets with the other facets on project change |

**i18n.** Keys added to both `zh` and `en`, parity enforced by `i18n/i18n.test.tsx:29-34`:

| Key | zh | en |
| --- | --- | --- |
| `shell.user` | 用户 | User |
| `shell.user_unset` | 未设置 | Not set |
| `shell.user_id` | 邮箱 | Email |
| `shell.user_name` | 名字 | Name |
| `workspace.facet_owner` | 负责人 | Owner |
| `workspace.filter_mine` | 我的 | Mine |
| `workspace.take_owner` | 接手 | Take over |
| `workspace.take_done` | 已接手 | Taken over |
| `workspace.records` | 记录 | Records |
| `workspace.record_init` | 创建 | Created |
| `workspace.record_review_request` | 评审请求 | Review requested |
| `workspace.record_review_ack` | 评审确认 | Review confirmed |
| `common.user_missing` (error) | 未设置用户身份 | User identity not set |
| `workspace.owner_required` (error) | 负责人是 {name} | Owner is {name} |

Existing `cancel` / `save` keys are reused. No `*_hint` or `*_note` keys are added.

## 8. Data flow

1. **Create.**
   - `tenon init x` → `requireActor` → `initChange({ creator })` → `created_by = assignee = "Ann <ann@x.io>"` → history
     `init` row with `actor`.
   - `POST /api/changes` does the same with `resolveUser(root)`.
2. **B advances A's task.**
   - `tenon transition x build-complete` (as B) → kernel app → `ownerDecision` refuses inside the transaction before
     any work → CLI exit 1 with the take-over hint, or server 403. Zero writes.
   - `tenon owner take x` (as B) → `transferOwner` → `assignee = B` plus a history `set` row with actor B.
   - B's transition then applies: the record has `actor: "B <b@x.io>"` and the history projection has `actor: {…B}`.
   - A is now refused.
3. **Dashboard 接手.** Click → `POST /api/change/x/owner {root}` → `transferOwner` as the server-resolved user → SSE
   snapshot → the card's `data-owner` changes → the 我的 filter updates.
4. **Per-user selection.**
   - `tenon session activate x` (as A) → `writeActiveChange(repo, slugA)` → stale root `.pipeline-active` and
     `.pipeline-interaction-authority` are removed.
   - A's hooks read `.tenon/users/<slugA>/local/active-change`. B's hooks read B's own file.
   - `--continuous` writes `local/authority` under the same slug.
   - `review acknowledge --delegated` reads both with `requireUser(deps).slug`.
5. **Identity missing.**
   - CLI writes exit 1 with the hint. Hooks: no active Change, so evidence hooks do nothing.
   - Dashboard shows `top-bar-user-missing` → `UserDialog` → `POST /api/user` → `GET /api/user` refresh → 接手 and
     create work.
6. **AFK sandbox.**
   - `createSandbox` (`automation/src/lifecycle/ports.ts:331`) passes `TENON_USER` / `TENON_USER_NAME` of the host
     identity that runs `tenon afk run`.
   - In-sandbox `tenon` records therefore attribute to the enqueuing user, not to the sandbox git identity
     `afk@pipeline.local` (`tools/sandcastle/tenon-afk-run.sh:34-35`).

## 9. Compatibility, migration, removals

**Removed**
- Every reader and writer of repo-root `.pipeline-active` and `.pipeline-interaction-authority`, with no fallback read.
- `ACTIVE_POINTER_FILE` and `INTERACTION_AUTHORITY_FILE` (`continuousAuthority.ts:11-12`, `session.ts:48-53`).
- Their `.gitignore` lines (`.gitignore:21,40`).
- `init --user`, the wizard user prompt, `HistoryEntry.by`, and `created_by = 'unknown'`.
- The history `by` decoding in the server and the Dashboard.

**Migration (one step, no compatibility layer)**
- `tenon session activate` deletes stale root copies of the two files when they are regular files.
- The old basenames stay in the workspace fingerprint exclusion (`fingerprint.ts:52-58`), so in-place build tokens
  frozen before the upgrade stay valid while a stale copy still exists.
- `.tenon/users/` is added to `EXCLUDED_RELATIVE_ROOTS` (`fingerprint.ts:61`), so per-user records never change a
  candidate.

**Existing Changes**
- `assignee` values `null`, `unknown` or a bare name are unowned, and must be taken over before advancing.
- `created_by` shows `—`.
- No state rewrite is needed: the field set is unchanged, so the canonical codec and N-1 readers are unaffected.
- Transition records keep a string `actor`, so an N-1 runtime still validates the chain (`transition-record-store.ts:94-96`).
- Old ledgers without `actor` still decode. The N-1 ledger decoder builds records key by key (`document-ledger.ts:171-174`),
  so an extra `actor` key does not break it.

**Unchanged:** the `pipeline-interaction-authority-v2` grammar, the `.pipeline/terminal-sessions/` host bindings, the
pending markers, the interaction event `actor: 'system'`, and the orchestration v2 actor ids.

## 10. Validation and error matrix

| Condition | CLI | HTTP | Dashboard / hooks |
| --- | --- | --- | --- |
| No env, no config, no git email | writes exit 1 `ERROR: 未设置用户身份…`; `tenon user` exit 1 | `GET /api/user` → `user:null`; writes 412 `user-missing` | `top-bar-user-missing`; hooks see no active Change |
| `TENON_USER=not-an-email` | same as missing; `--json` shows `invalid:"env"`; config and git ignored | `invalid:"env"` | missing state |
| `user.json` invalid JSON or invalid id | missing, `invalid:"config"` | same | same |
| `tenon user set bad` / `POST /api/user {"id":"bad"}` | exit 1 `ERROR: 用户邮箱非法: bad` | 400 `invalid-user` | `user-dialog-error` |
| `POST /api/user` with an extra key or a missing token | — | 400 / 401 | error text |
| B transitions A's task | exit 1 owner message, zero writes (record chain and state unchanged) | 403 `owner-required` + owner | — |
| B review requests or records a document on A's task | exit 1 owner message, no receipt, no ledger row | — | — |
| B acknowledges a review on A's task | allowed; history `actor` = B | 200 | 评审确认 row shows B |
| Unowned task, any advancing write | exit 1 `没有负责人；先接手` | 403, `owner:null` | 接手 visible |
| `tenon owner take` by the current owner | exit 0, `unchanged`, no history row | 200 `changed:false` | button hidden |
| `tenon owner set x c@x.io` by a non-owner | exit 1 owner message | — | — |
| `tenon set x assignee …` | exit 1 `字段 'assignee' 由 tenon owner 管理…` | — | — |
| Name with `": "` or non-ASCII id from git | name falls back to the local part; a non-ASCII id is invalid → missing `invalid:"git"` | same | same |
| `.tenon/users/<slug>/local` is a symlink or a file | activate WARN degraded, as today (`session.ts:262-266`); authority write refused | Dashboard activation `degraded` | hook writer refuses; readers ignore |
| `.tenon/.gitignore` already exists with other content | left untouched | — | — |
| git missing or hangs | missing after a timeout of at most 1.5 s | same | hooks: missing |

## 11. Security and trust

- **Identity is self-declared** (`trust: 'declared'` on every actor). The owner rule prevents mistakes, not deliberate
  impersonation (prd R3a, Out of Scope). Nothing labels an actor `human`
  (`.trellis/spec/server/backend/decision-sync.md:135-137`).
- **The token is still not identity.** The server attributes writes to the identity resolved on the machine that runs
  it, for the requested root. That is the same OS user and resolution as the CLI, so no new trust is added.
- **Per-process env overrides.** A `TENON_USER` in one terminal does not reach an already-running Dashboard. The config
  file and git config are machine-wide. `GET /api/user` returns `source` so the difference is visible.
- **Email exposure.** `GET /api/user` returns an email, but only behind the Host/DNS-rebinding check, to localhost.
  `POST /api/user` needs the bearer token.
- **Path safety.**
  - A slug's character set is `[a-z0-9._-]` and always contains `-at-`, so no traversal is possible.
  - Per-user files are written only as regular files (`lstat` checks, as in `session.ts:87-115`, and
    `[ ! -L ]` in bash). Temp file + rename.
  - `user.json` is at most 4096 bytes in bash. It is never evaluated.
- **Git access.** `git` gets a fixed argv, no shell, a timeout, and a bounded buffer.

## 12. Tests required (assertion points)

### Kernel (`npx vitest run packages/kernel/src/users …`)

**`users/user.test.ts`**
- Slugs:
  - `Jeff.Sha@Example.COM` → `jeff.sha-at-example.com`
  - `a+b@x.io` → `a-b-at-x.io`
  - `a-@b.c` → `a-at-b.c`
- Rejects no `@`, two `@`, whitespace, non-ASCII, `<`, and over 200 characters.
- Name fallback cases.
- `formatUserRef` / `parseUserRef` round trip; `unknown`, `null` and `jeff` → `null`.
- `decodeRecordActor` absent / invalid / valid.

**`users/resolve-user.test.ts`** uses temp `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1` and `TENON_RUNTIME_HOME`.
- env beats config beats git.
- An invalid env does not fall through.
- Repo-scope email beats global.
- No git email → missing.
- The name comes only from the chosen source.

**Other kernel tests**
- `users/owner.test.ts`: owner allowed; other user refused with the owner ref; unowned refused.
- `users/owner-transfer.test.ts`:
  - take writes `assignee` and one `set` history row with actor;
  - hand-over by a non-owner leaves state, revision and history unchanged;
  - an owner's take returns `unchanged` with no row.
- `users/user-paths.test.ts`, `users/active-change.test.ts`:
  - paths are correct;
  - `.tenon/.gitignore` is created once and not overwritten;
  - a symlinked `local` is refused;
  - an invalid name in `active-change` → `null`.
- `workspace/fingerprint.test.ts`: files under `.tenon/users/**` do not change the fingerprint (replaces the `:86` case).
- `product-paths.test.ts`: `userConfigPath` per platform.
- `workflow/transition-application.test.ts`:
  - `owner-required` is returned before any commit (record chain length unchanged);
  - an applied record has `actor === formatUserRef(actor)`;
  - the history projection has an object `actor`.
- `state/store.test.ts`: init sets `created_by === assignee === "Tester <tester@tenon.test>"`.
- `state/document-ledger.test.ts`: actor round trip; invalid actor rejected; a ledger without actor still parses.
- `decision/review-application` test: the acknowledge history row carries `actor`.

### CLI

- **New `commands/user.test.ts`:** `user --json` for each source; `user set` writes the config file and prints the WARN
  when env overrides.
- **New `owner.integration.test.ts`** (users A and B through harness env):
  - A inits.
  - B `transition`, `review request` and `document record` each exit 1 with stderr containing `tenon owner take`, and
    state is unchanged.
  - B `owner take` → `assignee` is B, plus a history row.
  - B transition exit 0 with record actor B; A transition exit 1.
  - `tenon set assignee` exit 1.
- **`session.integration.test.ts`:**
  - activate writes `.tenon/users/tester-at-tenon.test/local/active-change`;
  - a second user writes a separate file and neither overwrites the other;
  - `.tenon/.gitignore` is `users/*/local/`;
  - stale root files are removed;
  - identity missing → exit 1 and no file.
- **`commands/review.integration.test.ts:259-292`:** delegated authority is honoured only from the same user's `local/`;
  another user's authority file → exit 1.
- **Updates to existing tests:**
  - `status.test.ts` → `OWNER` / `owner`.
  - Drop `--user` in `program.test.ts:218`, `integration.test.ts:43,344`,
    `workflow-skill-orchestration.integration.test.ts:265` and `tools/test-bundle.sh:106`.
  - `init.test.ts` has no user prompt.
  - `integration.test.ts:284-299`, `terminal-activity-hook.integration.test.ts:60` and
    `integration-phase-skill-test-support.ts:21` use the per-user pointer.
- **New `user-hook-parity.integration.test.ts`:** for a fixture list of ids and env/config combinations, bash
  `pipeline_user_slug` (sourced from `hooks/tenon-user.sh`) equals the TypeScript `userSlug(resolveTenonUser(...).id)`.

### Server

- **New `serverUserRoutes.test.ts`:**
  - GET with root `''` / registered / unregistered → 404; bad Host → 403;
  - POST 401 without token, 400 on extra key or bad id, 200 writes `userConfigPath`;
  - owner POST 200 with a history row, and 412 when `resolveUser` returns missing.
- **`server.test.ts`:**
  - transition 403 `owner-required` when `resolveUser` returns B;
  - 412 when missing;
  - `POST /api/changes` sets creator and owner, 412 when missing;
  - the decisions history row has actor;
  - snapshot `owner` / `creator` are objects, and `null` for a legacy `unknown`;
  - activation reads the per-user pointer (`:5527-5552`).
- **`test-support.ts:73`:** writes the per-user pointer.

### Dashboard (`npm run test:web`)

- `taskModel.test.tsx`: owner facet counts; `owner: <slug>` filtering; an owner change moves a task between 我的 and others.
- `TaskListPane` / `WorkspaceView` test: `task-facet-owner-me[aria-selected=true]` shows only own tasks; aggregate view
  still issues only `/api/snapshot`.
- TopBar / App test: `top-bar-user` shows the name with `title` = id; the missing state shows `top-bar-user-missing`;
  saving the dialog POSTs `/api/user` and refreshes.
- `TaskDetailPane` test:
  - `task-detail-take` is hidden for the owner, hidden without a token, and hidden in the aggregate view;
  - clicking POSTs `/api/change/x/owner`;
  - `task-records` lists actor names.
- `snapshotDecoder` test: a missing `owner` key → snapshot `null`; `owner:null` accepted.
- `i18n.test.tsx` passes.

### Hooks (`bash tools/test-hooks.sh`, `bash tools/test-adapters.sh`)

- `export TENON_USER=hooks@tenon.test` at the top.
- Helper `set_active <root> <change>` writes `.tenon/users/hooks-at-tenon.test/local/active-change` and replaces every
  root-pointer write.
- Authority assertions (`:1698-1739`) move to `local/authority`.
- New section:
  - two users (`TENON_USER=a@x.io` / `b@x.io`) on one project: skill-tracker writes evidence only to each user's own
    active Change;
  - `TENON_USER` unset with no config or git email (`HOME` / `GIT_CONFIG_GLOBAL` pointed at temp) → no history
    written, exit 0;
  - config-file source via `TENON_RUNTIME_CONFIG_ROOT`;
  - git source via `GIT_CONFIG_GLOBAL`;
  - an authority written for user A does not unlock user B's interactive gate;
  - router's HOT PATH red line still passes.
- `tools/verify-skills.sh` lists `tenon-user.sh`.

### Real acceptance (prd)

- Two terminals with different `TENON_USER` on one repo, in Claude Code and in Codex: each creates and advances a task,
  each has its own active Change, and B is refused on A's task until 接手.
- Dashboard shows the top-bar user, owner cards, and filtering by 我的 / a named user.
- After `git pull` on a second clone, records show the operators.

## 13. Decisions made during design

1. **Creator and owner live in the existing `created_by` / `assignee` fields**, not new `creator` / `owner` keys. That
   needs no closed-codec change, oracle change or N-1 break (CR-1).
2. **Stored value is git-style `Name <email>`.** One field, and the Dashboard shows the name without a lookup.
3. **Unowned tasks** (legacy values) are refused for advancing until 接手. One rule, no exceptions.
4. **Review acknowledgement is not owner-gated.** prd R3a lists only 评审请求, and the permission model is out of scope.
   The actor is still recorded.
5. **Hook-written evidence rows carry no actor.** These are `tool`, `tool-start`, `prompt` and `InteractionConfirmed`.
   They are host evidence, not user operations listed in R2, and adding the name would put JSON escaping on the hook
   hot path.
6. **CLI history rows get `actor` from the history writer's stamping**, so no per-command edits are needed. This matters
   because `fields.ts` is at 400/400.
7. **An invalid value at a higher source makes identity missing.** It never falls through, so a typo in `TENON_USER`
   cannot silently attribute to the git identity.
8. **Ids are printable ASCII with exactly one `@`.** This guarantees identical bash and TypeScript slugs.
9. **`resolveTenonUser` is synchronous.** It keeps the shared signature; git gets a 1.5 s timeout.
10. **`.tenon/.gitignore` is a nested tracked file.** Tenon never edits a project's root `.gitignore` (CR-3).
11. **The authority file keeps its v2 text grammar at `local/authority`**, instead of JSON (CR-2).
12. **All of `.tenon/users/` is excluded from the workspace fingerprint**; the old basenames stay excluded (§9).
13. **Stale root files are deleted on `session activate`.** No read fallback.
14. **Owner facet row sits first, defaults to 全部**, and chips are keyed by slug.
15. **The Dashboard offers only 接手.** Hand-over to another person is CLI-only (`tenon owner set`).
16. **Records and 接手 appear only when a project is selected.** The aggregate view keeps a single request.
17. **HTTP codes:** 412 `user-missing`, 403 `owner-required`.
18. **`tenon status --json`:** `assignee` is replaced by `owner`.
19. **Server identity** comes from its own process env plus per-root git config. The aggregate 我的 uses root `''`.
20. **AFK sandboxes receive `TENON_USER` / `TENON_USER_NAME`** from the host so sandbox records attribute to the
    enqueuing user.
21. **`TransitionRecord.actor` stays a string** (the user ref) for N-1 chain compatibility. APIs expose the object (CR-5).

## 14. Contract change requests (parent `design.md`)

- **CR-1 (§5 `.pipeline.yaml` `creator`, `owner`).**
  - Replace with: creator and owner are stored in the existing `created_by` / `assignee` fields as `Name <id>`, and
    projected as `creator` / `owner` `{id,name,slug}` in the snapshot and in `tenon status`.
  - Reason: `run-revision-codec.ts:272-275` rejects keys outside `FIELD_ORDER`; `types.ts:30-34` requires appending
    only; `tools/oracle/run.sh:120-123` hard-codes the order.
- **CR-2 (§3 `local/authority.json`).**
  - Replace with `local/authority`, keeping the `pipeline-interaction-authority-v2` line grammar.
  - Reason: two strict parsers already exist (`continuousAuthority.ts:43-68`, `interaction-authority.sh:32-77`), and a
    JSON form would need a new strict bash JSON reader on a hook path.
- **CR-3 (§3 "`.gitignore` gets `.tenon/users/*/local/`").**
  - Replace with: Tenon creates `<repo>/.tenon/.gitignore` containing `users/*/local/` on the first per-user write.
  - Reason: no Tenon code writes project root `.gitignore` today (grep: none in cli/kernel/server/templates), and user
    projects are not tenon-local.
- **CR-4 (§2 `resolveTenonUser`).**
  - Missing becomes `{ missing: true; invalid?: 'env' | 'config' | 'git' }`.
  - Ids are restricted to printable ASCII with exactly one `@`, at most 200 characters; an invalid higher source does
    not fall through.
  - Reason: bash/TypeScript slug parity, and no silent misattribution.
- **CR-5 (§2 "every new record carries `actor: { id, name, trust }`").**
  - `TransitionRecord.actor` carries the same identity as a user-ref string. The history projection and APIs expose the
    object.
  - Reason: `transition-record-store.ts:94-96` validates a string in every released runtime; an object would break
    rollback reading of the chain.
- **CR-6 (§3, additive).** The workspace fingerprint excludes `.tenon/users/`, so per-user test records and pointers
  never make a candidate stale. `09-15-test-evidence` depends on this.
- **CR-7 (§5, additive).** `.pipeline-documents.json` records gain `actor`, and `ProductPaths` gains `userConfigPath`.

## 15. API for sibling children (stable after commit C3)

| Child | Imports from `@tenon/kernel` |
| --- | --- |
| `09-15-test-evidence` | `userProjectPaths(...).testsDir / baselinesDir / artifactsDir`, `RecordActor`, `assertOwner`, fingerprint exclusion (CR-6) |
| `09-15-review-agents` | `RecordActor`, `assertOwner` |
| `09-15-task-delete-archive` | `userProjectPaths(...).archived`, `ensureUserLocalDir`, `RecordActor`, CLI `requireActor` (`packages/cli/src/userIdentity.ts`), server `deps.resolveUser` |
| `09-15-instruction-templates` | `RecordActor` for template author; server `deps.resolveUser` |
