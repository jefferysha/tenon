# User Identity, Per-User State and the Owner Rule (`kernel/src/users/`)

## 1. Scope / Trigger

- Several developers use Tenon on the same repositories. Tenon needs to know who is acting, attribute records, keep
  personal state apart, and stop one person from advancing another person's task by mistake.
- Identity is **self-declared** (`trust: 'declared'`). There is no login and no token per user; the owner rule prevents
  mistakes, not deliberate impersonation.

## 2. Signatures

```ts
// packages/kernel/src/users/user.ts (pure)
interface TenonUser { id: string; name: string; slug: string; source: 'env' | 'config' | 'git'; trust: 'declared' }
type TenonUserResolution = TenonUser | { missing: true; invalid?: 'env' | 'config' | 'git' }
interface RecordActor { id: string; name: string; trust: 'declared' }
interface UserRef { id: string; name: string; slug: string }
validateUserId(raw) · normalizeUserName(raw, id) · userSlug(id) · actorOf(user) · formatUserRef(user) // "Name <id>"
parseUserRef(value) · decodeRecordActor(value) · userResolutionView(resolution) · USER_MISSING_HINT
// resolve-user.ts
resolveTenonUser(repoRoot?, env = process.env) · readUserConfig(path) · writeUserConfig(path, { id, name? })
// user-paths.ts / active-change.ts
userProjectPaths(repoRoot, slug) · ensureUserLocalDir(repoRoot, slug) · writeUserLocalFile(path, content)
readActiveChange(repoRoot, slug) · writeActiveChange(repoRoot, slug, change)
// owner.ts (pure) / owner-transfer.ts
ownerOf(fields) · creatorOf(fields) · ownerDecision(fields, actor) · ownerRequiredMessage(change, owner)
assertOwner(change, fields, actor) // throws OwnerRequiredError { code: 'owner-required' }
transferOwner({ store, history?, clock }, { changeDir, change, actor, to? })
```

```bash
# hooks/tenon-user.sh (source-only, bash 3.2, no node/jq)
pipeline_user_id <root> · pipeline_user_slug <root> · pipeline_user_slug_of <id>
pipeline_user_local_dir <root> · pipeline_ensure_user_local_dir <root>
```

CLI: `requireUser` / `requireActor` (`packages/cli/src/userIdentity.ts`), `tenon user [set]`, `tenon owner take|set`.
Server: `DashboardServerOptions.resolveUser(root)`, `GET/POST /api/user`, `POST /api/change/:name/owner`.

## 3. Contracts

- **Resolution order:** `TENON_USER` (+ `TENON_USER_NAME`) → `<configRoot>/user.json` → `git config user.email` /
  `user.name` (repo scope with a root, `--global` without). A present but invalid higher source makes identity
  missing; it never falls through. Git runs with a 1.5 s timeout and a 4096-byte buffer.
- **Id:** trimmed printable ASCII, 3–200 chars, exactly one `@` with both sides non-empty; `<`, `>`, `"`, `\` refused
  anywhere; no leading `'`. **Name:** 1–100 chars; a name containing `<`, `>`, a control character, `": "`, `" #"`, or a
  leading quote falls back to the id's local part, so `Name <id>` always passes the YAML quote gate.
- **Slug:** lowercase → `@` → `-at-` → `[^a-z0-9._-]` → `-` → runs of `-` collapsed. TypeScript and bash are identical
  (`user-hook-parity.integration.test.ts`). Every slug contains `-at-`, so it is never `.` or `..`.
- **Layout:** `<repo>/.tenon/.gitignore` (`users/*/local/`, created once, never rewritten; the project's root
  `.gitignore` is never edited) and `.tenon/users/<slug>/{tests,baselines}/` (tracked) plus `local/` (0700:
  `active-change`, `authority`, `archived.json`, `artifacts/`). Directories must be ordinary; readers ignore a symlinked
  `local/`. The whole `.tenon/` directory is excluded from the workspace fingerprint.
- **Records:** `created_by` / `assignee` hold `Name <id>` (creator and first owner = the declared identity at init);
  history rows, document ledger records and review acknowledgements carry `actor`; `TransitionRecord.actor` stays the
  user-ref string. Hook-written host evidence rows carry no actor.
- **Owner rule:** transition, advance, review request and document record require `ownerDecision(...).allowed`
  (compared by slug). Unowned legacy values (`unknown`, `null`, bare names) must be taken over first. Take over is open
  to anyone; hand-over (`to`) is owner-only. `created_by` / `assignee` are not writable through `tenon set`.
- **Per-user session state:** `tenon session activate` writes `local/active-change` for the resolved slug and removes the
  retired repository-wide `.pipeline-active` / `.pipeline-interaction-authority` files; hooks read only the current
  user's pointer and authority.

## 4. Validation & Error Matrix

| Condition | CLI | HTTP | Hooks / Dashboard |
| --- | --- | --- | --- |
| No env, no `user.json`, no git email | writes exit 1 `ERROR: 未设置用户身份…` | `GET /api/user` → `user:null`; writes 412 `user-missing` | no selected Change; `top-bar-user-missing` |
| `TENON_USER=bad` or invalid `user.json` / git email | same, `invalid` names the source | same | same |
| Another user advances | exit 1 `任务 x 的负责人是 A <a@x.io>；先接手：tenon owner take x`, zero writes | 403 `owner-required` + `owner` | 接手 button |
| Unowned task advances | exit 1 `任务 x 没有负责人；先接手…` | 403, `owner: null` | 接手 button |
| `tenon owner take` by the owner | exit 0, unchanged, no history row | 200 `changed:false` | button hidden |
| `tenon owner set` by a non-owner | exit 1 owner message | — | — |
| `tenon set x assignee …` | exit 1 `字段 'assignee' 由 tenon owner 管理…` | — | — |
| Symlinked `.tenon/users/<slug>/local` | activate degraded | activation `degraded` | readers ignore, writer refuses |

## 5. Good / Base / Bad Cases

- Good: A and B each `session activate` a different task; A's hooks and delegated review read only A's `local/`.
- Base: a single developer with only `git config user.email` works without any setup.
- Bad: falling back from an invalid `TENON_USER` to the git identity (silent misattribution), or reading a shared
  repository-wide pointer (one user's selection steers another user's hooks).

## 6. Tests Required

- Kernel: `users/{user,resolve-user,user-paths,owner,owner-transfer}.test.ts`, `transition-application.test.ts`
  (owner refusal before commit, record actor), `state/document-ledger.test.ts` (actor round trip), `history.test.ts`.
- CLI: `commands/user.test.ts`, `owner.integration.test.ts` (two users), `session.integration.test.ts` (per-user pointer,
  stale files, missing identity), `commands/review.integration.test.ts` (another user's authority refused),
  `user-hook-parity.integration.test.ts`.
- Server: `serverUserRoutes.test.ts`, `server.test.ts` (403 / 412, owner/creator projection).
- Hooks: `tools/test-hooks.sh` section 13 (two users, missing identity, config and git sources, authority isolation).
- Dashboard: `TopBarUser`, `TaskDetailPane`, `taskOwnerFacet`, `userDecoders` tests.

## 7. Wrong vs Correct

### Wrong

```ts
const user = resolveTenonUser(root)
const actor = isTenonUser(user) ? actorOf(user) : { id: 'unknown', name: 'unknown', trust: 'declared' }
```

### Correct

```ts
const actor = requireActor(deps) // prints USER_MISSING_HINT
if (actor === null) return 1     // zero writes
```
