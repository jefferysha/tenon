# Instruction files, template library and project creation

## 1. Scope / Trigger

- Trigger: the Dashboard edits instruction files (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` at a project root, and each
  host's user-level file), manages the instruction template library, and creates projects from an existing or new directory.
- Owners: kernel `src/instructions/` (pure grammar, composition, host table), kernel
  `src/infrastructure/builtin-library-sync.ts` (payload → `config/<kind>/builtin`), server `instructionLibrary.ts` /
  `instructionFiles.ts` / `projectCreate.ts` / `instructionRoutes.ts`, dashboard `library/` and `projects/`.
- The server never re-implements parsing, composition or managed-block merging: those are kernel exports.

## 2. Signatures

```ts
// kernel (pure)
parseInstructionBlock(text, { category, id }): { ok: true; block } | { ok: false; errors }
composeInstructions({ projectName, selections, catalog }): { ok: true; markdown; directories } | { ok: false; errors }
parseManagedBlocks(content): { ok: true; userText; blocks } | { ok: false; error; tag; line }
mergeManagedBlocks(editorText, blocks): string
contentAfterDelete(blocks): string | null          // null = unlink the file
userInstructionPath(hostId, { homeDir, env, platform }): readonly string[] | null   // [trustedRoot, ...relative]
zedEffectiveFile(exists): string

// kernel (infrastructure)
syncBuiltinLibraries(payloadRoot, configRoot, libraries?): readonly BuiltinSyncResult[]   // never throws

// server
listTemplates(anchor) / readTemplate(anchor, ref) / writeCustomTemplate(anchor, category, id, text, ifMatch)
copyTemplate(anchor, from, id) / deleteCustomTemplate(anchor, category, id, digest)
composeFromRequest(anchor, body, catalog)
readInstructionTargets(scope) / previewInstructionApply(scope, text, ids) / applyInstructions(scope, text, targets)
deleteInstructionTarget(scope, targetId, digest)
registerProjectAnchored(paths, anchors, rawRoot) / handleProjectCreate(body, deps)
resolveInstructionGet(req, path, deps) / resolveInstructionMutation(req, method, path, deps)   // null = not our route
```

## 3. Contracts

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/instruction-templates` | `{ ok, sync, templates[] }`; lazily runs `syncBuiltinLibraries` first |
| GET | `/api/instruction-templates/:source/:category/:id` | `{ ok, …ref, text, digest, block \| null, errors[] }` |
| PUT | `/api/instruction-templates/custom/:category/:id` | `text/markdown` body, `If-Match` required; parses before writing |
| POST | `/api/instruction-templates/copy` | `{ from, id }` → `custom/<category>/<id>.md` |
| DELETE | `/api/instruction-templates/custom/:category/:id?digest=` | digest required |
| POST | `/api/instruction-templates/compose` | `{ project_name, selections[] }` → `{ markdown, directories, bytes }` |
| GET | `/api/instructions?root=` | `root` empty = user level; `{ hosts[], targets[] }` |
| POST | `/api/instructions/preview` | `{ root, text, targets[] }` → per-file `current` / `next` / `base_digest` |
| POST | `/api/instructions/apply` | `{ root, text, targets[{id, base_digest}] }` |
| DELETE | `/api/instructions?root=&target=&digest=` | `{ result: 'removed' \| 'managed-kept' }` |
| POST | `/api/projects/create` | `dry_run` plans, otherwise executes; the second write route exempt from the registered-root anchor |

- GET routes check the Host header only. POST / PUT / DELETE reuse the route tables' Host + bearer-token guard, and the
  POST table additionally requires `application/json`; template PUT requires `text/markdown`.
- Every write takes the digest the client last saw (`absent` for a new file). A mismatch writes nothing and returns 409
  with the current digest, so an external edit is never silently overwritten.
- `applyInstructions` verifies every target (digest + marker validity) before writing any file. A failure after the first
  write returns 500 `instruction-apply-partial` naming what was written.
- Tenon-owned managed blocks (`<!-- PIPELINE:<TAG>:START -->` … `END`) are split out of the editor text on read, kept
  verbatim, and re-appended at the end of the file on apply. A file whose markers are malformed refuses writes.
- Builtin templates are read-only; only `custom/` is written. A PUT whose text fails `parseInstructionBlock` is rejected,
  so templates written through the UI always parse.

### Trusted filesystem

- `instructionTrustedFs.ts` opens every directory through `withTrustedDirectoryChain` (`O_NOFOLLOW` + inode/realpath
  re-checks) from a captured root anchor: a registered project root, the host home, `$CODEX_HOME`, or `%APPDATA%`.
- Target files must be regular files: a symlink or non-file is refused (`target-symlink` / `not-file`), never followed.
- Writes go to an exclusive same-directory temp file, `fsync`, then `rename`; the temp file is removed on any failure.
- Missing intermediate directories under the trusted root (for example `~/.gemini/`) are created through the same chain.

### Builtin library sync

- `BUILTIN_LIBRARIES` rows are kind-agnostic (`{ id, source, target, extensions, validate }`); other kinds (agents,
  resources, test directions) add a row instead of writing their own copier.
- The payload tree is copied into `<configRoot>/<target>` wholesale under a lock, marker `.library.json` written last;
  `custom/` is never opened. Identical `source_digest` returns `unchanged` without touching files.
- Triggers: release activation post-commit (from `<releaseRoot>/payload`) and lazily on every library read. Failures are
  returned per library and never thrown, so activation and dashboard start are unaffected.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Bad Host header / missing token | 403 / 401 (route table guard) |
| Template ref not matching the grammar | 400 `invalid-template-ref` |
| PUT / DELETE on `builtin` | 409 `template-builtin-readonly` |
| PUT without `If-Match`, DELETE without `digest` | 428 `if-match-required` |
| Digest differs from disk | 409 `template-changed` / `instruction-file-changed` with the current digest |
| Copy target exists | 409 `template-exists` |
| Block / compose / body validation | 400 `invalid` with `errors[]`, nothing written |
| Editor text contains a marker line | 400 `managed-marker-in-text` |
| Current file has malformed markers | 409 `managed-block-invalid` |
| Target is a symlink or not a regular file | 409 `target-symlink` / `not-file` |
| Symlinked or replaced ancestor directory | 409 `path-unsafe` |
| `EACCES` / `EPERM` / `EROFS` | 422 `write-denied` |
| Create: non-absolute path, bad name, bad skeleton directory | 400 `invalid-path` / `invalid` |
| Create empty: target exists / parent missing / parent not a directory | 409 `project-path-exists` / 404 `parent-missing` / 400 `parent-not-directory` |
| Create empty: `git` not runnable | 422 `git-unavailable`, before `mkdir` |
| Create empty: failure after `mkdir` | created directory removed (inode-checked), 500 `project-create-failed` with `step` |
| Create existing: already registered | 200 with `registration: 'already'` |

## 5. Good / Base / Bad Cases

- Good: apply one body to `CLAUDE.md` + `AGENTS.md` → identical user text in both, `AGENTS.md` keeps its Codex block.
- Base: a template library whose `source_digest` is unchanged → `sync: { state: 'unchanged' }`, no writes.
- Bad: writing an instruction file without the client's digest, or following a symlinked target.

## 6. Tests Required

- `packages/kernel/src/instructions/*.test.ts`: marker grammar (unpaired / reversed / duplicate / nested with line),
  block frontmatter and placeholder errors, composition order and `{{directories}}` dedupe, host table equality with
  `ADAPTER_CAPABILITY_ROWS`, `CODEX_HOME` / win32 Zed paths, and the repo's builtin blocks composing.
- `packages/kernel/src/infrastructure/builtin-library-sync.test.ts`: first sync, `unchanged`, wholesale replace,
  `custom/` untouched, invalid builtin or payload symlink → `failed` with the previous builtin intact, stale staging cleanup.
- `packages/server/src/instruction*.test.ts`, `projectCreate.test.ts`: 403/401 on every mutation, the error matrix above,
  managed-block preservation, user-level writes under a temp home, and project creation including rollback after `mkdir`.
- `packages/cli/src/runtime/release-store.integration.test.ts`: activation populates `builtin/`, keeps `custom/`
  byte-identical, and still activates when the sync fails.
- `tools/check-instruction-templates.mjs` (npm `check:instruction-templates`): builtin inventory, per-category section
  headings, and the golden composition.

## 7. Wrong vs Correct

### Wrong

```ts
// Reading the payload root as the release root: <releaseRoot>/templates does not exist.
await syncBuiltinLibraries(finalRoot, this.paths.configRoot)
// Writing the editor text straight to disk: drops Tenon's managed block and ignores external edits.
writeFileSync(join(root, 'AGENTS.md'), editorText)
```

### Correct

```ts
await syncBuiltinLibraries(join(finalRoot, 'payload'), this.paths.configRoot).catch(() => [])
const parsed = parseManagedBlocks(current)            // malformed markers refuse the write
writeTrustedFile(anchor, [], 'AGENTS.md', mergeManagedBlocks(editorText, parsed.blocks), baseDigest, MAX)
```
