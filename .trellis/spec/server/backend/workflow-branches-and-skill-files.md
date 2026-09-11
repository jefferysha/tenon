# Workflow GET `branches` and the skill files API

## 1. Scope / Trigger

- Trigger: the dashboard needs per-branch effective IO for a workflow and the full contents of a local
  skill directory (SKILL.md plus every other file) for the skill detail pane.

## 2. Signatures

```ts
// workflows.ts
workflowBranchesForApi(def: WorkflowDef): Record<'_base' | TrackId, { label?: string; effectiveIo: WorkflowEffectiveIo }>

// skillsRegistry.ts
listSkillFiles(name, repoRoot, claudeDir): { name; source: SkillSource; origin: string; files: { path; bytes }[] } | undefined
readSkillFile(name, relPath, repoRoot, claudeDir): { kind: 'ok'; path; text } | { kind: 'not-found' | 'invalid-path' | 'too-large' | 'binary' }

// snapshot.ts / changeSnapshot.ts
resolveSnapshotEffectivePlan(root, name, binding, loadDefinition?, track?: TrackDefinition)
resolveSnapshotTrack(root, trackId, workflowName?): TrackDefinition | undefined
```


### Global workflow store (`root` may be empty)

- Every `/api/workflows*` route resolves its storage anchor through `workflowStoreForRequest(root)`
  (`serverGovernance.ts`): `root === ''` → the global store (`<paths.configRoot>/workflows`, directory created on
  first use, anchor captured once and re-asserted like registered roots); any other root → the registered-project
  anchor as before. The check carries `global: boolean`.
- `GET /api/workflows` (no root) lists the global files; `default.source` is `'global'` when a global override
  exists, `'builtin'` otherwise (`'project'` only for project-root requests with a legacy file).
- `GET /api/workflows/:name?root=<project>` follows the kernel order: project file → global file (`source:
  'global'`) → built-in default template. This is what the 工作台 uses to render a change's IO, so a change always
  sees the same definition the CLI runs.
- `POST` / `DELETE` / `PUT yaml` with empty root write to the global store; reference scans and locks are anchored on
  the global root, so deleting a global workflow does **not** scan project changes for references (documented gap).

## 3. Contracts

- `GET /api/workflows/:name` = definition (with `tracks`) + `source` + `effectiveIo` (first branch) + `branches`.
  A workflow with `tracks` yields one `branches` entry per track and no `_base`; a workflow without tracks
  yields `_base` only. `branches`, `effectiveIo`, `source` are read-only projections: the POST decoder rejects
  them, so clients strip them before writing (the dashboard client does).
- `GET /api/skills/:name/files`: name must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (400 otherwise). The skill
  directory is the first `SKILL.md` hit in: repo `skills/` (`local-plugin`, origin `tenon`) → `~/.claude/skills`,
  `~/.agents/skills` (`user`) → installed Claude plugin roots and the Codex plugin cache (`external-marketplace`).
  Files are listed recursively (hidden entries and files > 1 MB skipped), `SKILL.md` first, paths relative and
  posix. Missing skill → 404.
- `GET /api/skills/:name/file?path=`: `path` must be one of the listed files (no `..`, no absolute, no hidden
  segments; realpath must stay inside the skill dir) → 400 otherwise; > 256 KB → 413; contains NUL → 415;
  missing → 404. Read-only, loopback GET, no token.
- Snapshot plans resolve with the change's track (`resolveSnapshotTrack`, which falls back to a workflow branch
  when the registry does not know the id) so a legacy change without a frozen snapshot still gets its branch.

## 4. Validation & Error Matrix

- See status codes above; filesystem errors surface as 500 with `errMsg`.

## 5. Good / Base / Bad Cases

- Good: `GET /api/workflows/default` → `branches` keys `chat, pm, frontend, backend, free`.
- Base: `simple` (no tracks) → `branches = { _base }`.
- Bad: `GET /api/skills/tenon-open/file?path=../tenon-explore/SKILL.md` → 400.

## 6. Tests Required

- `server.test.ts`: default GET exposes the five branch keys; custom GET without tracks exposes `_base`;
  files 200 (SKILL.md first, local-plugin), file 200 / 400 / 404, unknown skill 404, invalid name 400.
- Global-store round trip (`root` empty): GET list / GET one / project-root fallback all report `source: 'global'`,
  and POST writes into the global directory while the project directory stays absent.
- Write-endpoint tests must pass the token as `reqPost(port, path, body, { headers: { Authorization: \`Bearer ${token}\` } })`.
  The fourth argument is an **options object**, not the token: passing the bare string silently sends no auth header,
  the endpoint answers 401, and the assertions after it never execute. The global-store POST case shipped that way
  and was red from the day it landed.

## 7. Wrong vs Correct

### Wrong

```ts
// Serving only SKILL.md's description from the registry entry as "the skill's documentation".
```

### Correct

```ts
const files = listSkillFiles(name, repoRootForSkills(), join(hostHome, '.claude'))   // whole directory
const file = readSkillFile(name, 'references/notes.md', repoRootForSkills(), join(hostHome, '.claude'))
```
