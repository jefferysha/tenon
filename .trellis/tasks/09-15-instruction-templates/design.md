# Design: instruction files and templates (`09-15-instruction-templates`)

> **Parent overrides** (`.trellis/tasks/09-15-tenon-next-capabilities/design.md` §9 wins over this file): X11 the builtin sync helper is generic (payload dir, target dir, validate) and serves agents, templates, resources, test directions; X12 resources dir `config/resources/`; X13 skills view is not in the library; library rail kinds agent / 模板 / 资源目录 / 测试方向 (others fill their tabs later); X18.

Binding inputs: parent `09-15-tenon-next-capabilities/design.md` (§1 terms, §2 identity, §3 layout, §6 execution
boundary, §7 surfaces), this child's `prd.md`, `research/harness-instructions.md`, `research/draft-template-react-java.md`,
`research/current-instructions.md`. Where this design needs a parent change it is listed in §12 and not applied here.

## 1. Current state (evidence)

| Fact | Evidence |
| --- | --- |
| No instruction-file or template feature exists; Tenon only writes its own Codex block into project `AGENTS.md` | `adapters/codex/install.sh:61-126`, generator `tools/generate-product-identity.mjs:45-70` → `templates/generated/codex-agents-block.md:1,22` |
| Ownership marker mismatch: kernel looks for `<!-- PIPELINE:START -->`, every writer uses a tagged marker (`PIPELINE:CODEX`, `PIPELINE:COPILOT`, `PIPELINE:ZED`) | `packages/kernel/src/state/ownership-manifest.ts:60-61,184-197`; writers `adapters/codex/install.sh:64`, `adapters/copilot/install.sh:51`, `adapters/zed/install.sh:47`; consumers `packages/cli/src/commands/sync.ts:95-98`, `uninstall.ts:228-233`; test only covers the untagged form `packages/kernel/src/state/ownership.test.ts:172-178`; doc `commands/tenon-uninstall.md:13,33` |
| Zed defect confirmed: Zed uses the **first matching** worktree-root file (`.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`); the adapter creates `.rules`, which hides `AGENTS.md`/`CLAUDE.md` | zed.dev/docs/ai/instructions (fetched 2026-09-15); `adapters/zed/install.sh:45-100`; test asserts `.rules` `tools/test-adapters.sh:916-923` |
| Cursor defect confirmed: "Project rules must use the `.mdc` extension. A plain `.md` file in `.cursor/rules` is ignored"; the adapter writes `.cursor/rules/pipeline.md` | cursor.com/docs/rules (fetched 2026-09-15); `adapters/cursor/install.sh:46-67`; test asserts `pipeline.md` `tools/test-adapters.sh:404-411` |
| Global config root is `resolveProductPaths().configRoot` (macOS `~/Library/Application Support/tenon/config`); workflows already use `configRoot/workflows` | `packages/kernel/src/product-paths.ts:102-160`, `workflow/global-store.ts:16-18`, `server/src/server.ts:248` |
| Release payload already ships the whole `templates/` directory | `packages/cli/src/runtime/release-store-codecs.ts:22-36` |
| Activation commits the selection, then runs post-commit housekeeping that must not fail activation; audit `kind` is a closed enum | `packages/cli/src/runtime/release-store.ts:309-322`, `release-store-codecs.ts:177`, `runtime/types.ts:80-81`; called from `runtime/installer.ts:64` |
| The dashboard server runs from the payload root and knows `paths` and `hostHome` | `packages/server/src/main.ts:46-48,74-79,114-119` |
| Project registration: `POST /api/projects` is the one write route exempt from the registered-root anchor; it stats the dir, captures an inode anchor, registers | `packages/server/src/serverPostChangesRoutes.ts:95-135`, `projects.ts:19-37`, `kernel/src/state/projectRegistry.ts:66-74` |
| Trusted write pattern: fd-anchored directory chain with `O_NOFOLLOW`, exclusive tmp + fsync + rename | `packages/server/src/workflowTrustedFs.ts:111-188`, `workflows.ts:251-316`, `workflowRootAnchor.ts:74-99` |
| Write-route guard: Host header check (403) then bearer token (401); body readers with byte caps | `packages/server/src/serverMutationRoutes.ts:83-89,302-323`, `serverWorkflowYamlRoutes.ts:26,71-88` |
| Route files near the size gate (400 lines for server): `serverGetRoutes.ts` 396, `serverMutationRoutes.ts` 324, `serverPostChangesRoutes.ts` 315, `server.ts` 386 | `wc -l`; gate `tools/check-architecture.mjs` size rules citing `.agent-rules/BACKEND.md:60-63`, `.agent-rules/FRONTEND.md:59-62` |
| Dashboard has two views; the nav renders `VIEWS`; `nav.projects: '项目'` key already exists (retired page) | `packages/dashboard-app/src/shell/views.ts:6`, `shell/TopBar.tsx:155-165`, `i18n/translations.ts:32-37` |
| No-project state teaches CLI commands and explicitly refuses a registration UI (decision #7, now superseded by the 2026-09-15 user decision) | `packages/dashboard-app/src/shell/Onboarding.tsx:155-194`; unused client `api/governanceClient.ts:38-51` |
| Dirty-draft guard is hard-wired to the workflow view | `packages/dashboard-app/src/App.tsx:93-113,148-169` |
| Markdown preview component (GFM, no raw HTML) exists; no editor dependency | `packages/dashboard-app/src/shared/Markdown.tsx:36-42`; `dashboard-app/package.json` has `react-markdown` only |
| Kernel has zero third-party dependencies; frontmatter parsing today is ad hoc | `packages/kernel/package.json` (`dependencies: {}`), `packages/server/src/skillsRegistry.ts:18` |
| Host ids used across server and generated capability rows | `packages/server/src/hostTargetPlanProtocol.ts:1-4`, `packages/kernel/src/catalog/adapter-capabilities.generated.ts:11-12` |
| i18n gates: zh/en key parity, no Chinese literals in production TSX, no `Error.message` rendering | `packages/dashboard-app/src/i18n/i18n.test.tsx:29-36,125-200` |
| This machine: `~/.codex/AGENTS.md` exists (0 bytes); `Zed.app` installed; Cursor not installed | local `ls` 2026-09-15 |

## 2. Boundaries

In scope:

- Template block library in the global config root: builtin synced from the payload, custom untouched, builtin read-only + copy.
- Block format with variables and composition into one Markdown document.
- 32 builtin blocks at the depth of the 15-rule baseline (§8).
- Project-level instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` at repo root) and user-level files at each host's documented path: read, Markdown edit + preview, preview diff, apply, delete, Tenon managed-block preservation, external change detection.
- Per-host label for how the two levels load.
- Dashboard pages 项目 (instruction files + 新建项目) and 库 (templates section).
- Server routes writing into trusted roots (registered project roots, host home, global config root).
- Fix: ownership marker grammar in kernel; Zed and Cursor adapters.

Out of scope: CLI commands (none added; `packages/cli/src/program*.ts` untouched), OpenCode (not a Tenon host), managed-policy files,
`tenon-local`'s own `AGENTS.md`, remembering which blocks a project was built from, host agent directories, DESIGN.md content and
catalog data (design-resources), any model call.

Layer owners:

| Layer | Owns | Must not |
| --- | --- | --- |
| kernel `src/instructions/` (pure, added to `DOMAIN_DIRS`) | categories, block parser, composer, managed-block grammar, host table, digests | import `node:*` |
| kernel `src/infrastructure/builtin-library-sync.ts` | copying builtin libraries from a payload root into `configRoot` | know about HTTP or UI |
| server | routes, trusted filesystem access, project creation (`git init`) | re-implement parsing/merging |
| dashboard | pages, dialogs, line diff rendering, polling | merge managed blocks or compose templates |
| cli runtime | calling the sync after activation commit | fail activation because of the sync |
| adapters | writing their own managed block into files the host really reads | touch user text outside their block |

## 3. File formats

### 3.1 Library layout

```
<configRoot>/templates/instructions/
  builtin/.library.json                 # sync marker, written last
  builtin/<category>/<id>.md            # replaced wholesale on every sync
  custom/<category>/<id>.md             # user-owned, never touched by sync
  audit.jsonl                           # appended by server writes (after multi-user, §10 commit 16)
```

Repository source of builtin blocks: `templates/instructions/builtin/<category>/<id>.md` (shipped by the existing `templates` payload
entry). `.library.json`:

```json
{ "version": 1, "library": "instruction-templates", "source_digest": "sha256:<hex>", "synced_at": "2026-09-15T12:00:00.000Z" }
```

`source_digest` = sha256 over the sorted lines `<posix relpath>\0<sha256 hex of bytes>\n` of every `.md` file under the source.

`audit.jsonl` row: `{ "at": ISO, "actor": { "id", "name", "trust": "declared" }, "action": "template-save" | "template-copy" |
"template-delete" | "instruction-apply" | "instruction-delete" | "project-create", "target": string, "digest_before": string,
"digest_after": string }`.

### 3.2 Categories (fixed, composition order)

| id | UI word | Heading level of block body | Multiple selections |
| --- | --- | --- | --- |
| `common` | 通用 | `##` | yes |
| `frontend` | 前端 | `##` | yes |
| `state` | 状态管理 | `###` (rendered inside 前端) | yes, filtered by selected frontend `frameworks` |
| `styling` | 样式 | `###` (rendered inside 前端) | yes, filtered by selected frontend `frameworks` |
| `backend` | 后端 | `##` | yes |
| `mobile` | 移动端 | `##` | yes |
| `system` | 系统 | `##` | yes |
| `api` | 接口约定 | `##` | yes |
| `database` | 数据库 | `##` | yes |

### 3.3 Block file grammar

```md
---
id: typescript-react
category: frontend
title: TypeScript + React
frameworks: [react]
directory: frontend/
directory_label: 前端工程根目录
catalog: [component-lib, icons, design-md]
variables:
  - key: component.soft
    default: 200
  - key: component.hard
    default: 350
---
## 前端

### 技术栈
…
| 组件 `.tsx` | {{component.soft}} 行 | {{component.hard}} 行 |
```

Frontmatter is a fixed line grammar (kernel has no YAML dependency), parsed by `parseInstructionBlock`:

| Key | Form | Rule |
| --- | --- | --- |
| `id` | `[a-z0-9][a-z0-9-]{0,63}` | equals file name without `.md` |
| `category` | one of §3.2 | equals parent directory |
| `title` | plain or double-quoted scalar, ≤ 80 chars | required |
| `frameworks` | `[a, b]` of `[a-z0-9-]+` | frontend: frameworks it provides; state/styling: frameworks it applies to (required there); others: omitted |
| `directory` | `[a-z0-9._-]+/` single segment | optional; feeds `{{directories}}` and the new-project skeleton |
| `directory_label` | scalar | required when `directory` is set |
| `catalog` | `[category, …]` from design-resources categories (`component-lib`, `blocks`, `template`, `icons`, `design-md`, `state`, `styling`) | enables `{{catalog.<category>}}` placeholders (frontend blocks) |
| `catalog_ref` | catalog entry id | enables `{{catalog.ref}}` (state/styling blocks) |
| `variables` | list items `- key: <k>` + optional `  default: <scalar>` | key `[a-z][a-z0-9_.-]{0,47}`, unique in the block; no default = required |

Body rules: first non-empty line is a heading at the category's level; no `# ` heading; no line matching the managed marker grammar
(§3.5); ≤ 64 KiB. Placeholders `{{name}}` resolve, in order, to the block's own variables, `project.name`, `directories`,
`catalog.<category>` (declared in `catalog`), `catalog.ref` (when `catalog_ref` is set). `\{{` renders a literal `{{`. Placeholders
inside fenced code are substituted (the baseline puts `{app}` inside a directory tree). Any unresolved name is a parse error.
Unknown frontmatter keys are errors (closed decoder).

### 3.4 Composition output

```
# <project.name>

<common bodies>
<frontend body 1>
<state bodies compatible with frontend 1>
<styling bodies compatible with frontend 1>
<frontend body 2 …>
<backend bodies> <mobile bodies> <system bodies> <api bodies> <database bodies>
```

- Blocks joined by one blank line; LF; single trailing newline. No section numbers (the baseline's `## 1.` numbering is dropped so
  any subset composes cleanly).
- `{{directories}}` renders `| 目录 | 内容 |` rows from selected blocks' `directory`/`directory_label`, deduplicated by path (first
  label wins), in composition order.
- `{{catalog.<category>}}` / `{{catalog.ref}}` render one line per selected entry:
  `- <name>（<spdx>）· 安装 \`<install>\` · 文档 <docs_url>`; plus `- 署名：<name> 需要署名` when `license.attribution` is true. A
  placeholder with no selected or resolvable entry removes its whole line.
- A state/styling block whose `frameworks` does not intersect a selected frontend block → error `framework-mismatch`.

### 3.5 Managed blocks

Marker line grammar (exact line, no surrounding text): `<!-- PIPELINE:<TAG>:START -->` / `<!-- PIPELINE:<TAG>:END -->`,
`TAG = [A-Z][A-Z0-9_]*`. Valid file: for each tag at most one START and one END, START before END, no block opens inside another.
Errors: `unpaired`, `reversed`, `duplicate`, `nested` (with tag and 1-based line).

- **Split (read):** `userText` = file with every block (START..END lines plus one trailing newline) removed, trailing blank lines
  collapsed; `blocks` = `{ tag, text }` in file order.
- **Merge (apply):** `next = trimEnd(editorText) + '\n' + (blocks.length ? '\n' + blocks.map(b => b.text).join('\n') : '')`,
  normalized to one trailing newline. Blocks are kept verbatim and placed at the end in original order (where the Codex installer
  appends them, `adapters/codex/install.sh:118-123`). `editorText` containing a marker line → 400 `managed-marker-in-text`.
- **Delete:** no blocks → unlink; blocks → file rewritten to blocks only (result `managed-kept`).
- **Invalid markers in the current file** → reads return `error: 'managed-block-invalid'`, writes are refused (same fail-closed rule as
  `adapters/codex/install.sh:68-91`).
- Output is LF. A CRLF file is rewritten as LF; the diff shows it.

### 3.6 Host table (`packages/kernel/src/instructions/hosts.ts`)

From `research/harness-instructions.md`, Zed/Cursor/Cline re-checked 2026-09-15. User paths are relative to the host home.

| host | project file | user file | levels | UI label |
| --- | --- | --- | --- | --- |
| claude | `CLAUDE.md` | `.claude/CLAUDE.md` | joined | 叠加 |
| codex | `AGENTS.md` | `$CODEX_HOME/AGENTS.md` (absolute env), else `.codex/AGENTS.md` | joined | 叠加 |
| gemini | `GEMINI.md` | `.gemini/GEMINI.md` | joined | 叠加 |
| copilot | `AGENTS.md` | — (personal instructions need `applyTo` frontmatter or GitHub settings) | user-wins | 个人优先 |
| cursor | `AGENTS.md` | — (Settings only) | project-only | 仅项目 |
| zed | effective file: first existing of the Zed order, else `AGENTS.md` | `.config/zed/AGENTS.md`; win32 `%APPDATA%\Zed\AGENTS.md` | project-wins | 项目优先 |
| cline | `AGENTS.md` | `.agents/AGENTS.md` | joined | 叠加 |
| continue | `AGENTS.md` | — (global rules location not documented) | joined | 叠加 |
| amp | `AGENTS.md` | `.config/amp/AGENTS.md` | joined | 叠加 |
| devin | `AGENTS.md` | `.config/devin/AGENTS.md` | joined | 叠加 |
| pi | `AGENTS.md` | `.pi/agent/AGENTS.md` | joined | 叠加 |
| aider | — (needs `read:` config) | — | needs-config | 需配置 |

`ZED_PROJECT_ORDER = ['.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', 'AGENT.md',
'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']`. Project targets are the distinct project files of the selected hosts. Rows without a file
show `—` and no checkbox.

### 3.7 Digests

`digest = 'sha256:' + hex(bytes)`; a missing file is `'absent'`. Every write takes the base digest the client last saw.

## 4. TypeScript signatures

### 4.1 kernel `packages/kernel/src/instructions/` (exported from `src/index.ts`)

```ts
// categories.ts
export const INSTRUCTION_CATEGORIES = ['common','frontend','state','styling','backend','mobile','system','api','database'] as const
export type InstructionCategory = (typeof INSTRUCTION_CATEGORIES)[number]
export type TemplateSource = 'builtin' | 'custom'
export interface TemplateRef { source: TemplateSource; category: InstructionCategory; id: string }
export function isTemplateId(value: string): boolean

// block.ts
export interface InstructionVariable { key: string; default?: string }
export interface InstructionBlock {
  id: string; category: InstructionCategory; title: string; frameworks: readonly string[]
  directory?: string; directoryLabel?: string; catalog: readonly CatalogCategory[]; catalogRef?: string
  variables: readonly InstructionVariable[]; body: string
}
export interface BlockError { code: 'frontmatter' | 'unknown-key' | 'id-mismatch' | 'category-mismatch' | 'heading'
  | 'unknown-placeholder' | 'managed-marker' | 'too-large'; line?: number; detail: string }
export function parseInstructionBlock(text: string, expected: { category: InstructionCategory; id: string }):
  { ok: true; block: InstructionBlock } | { ok: false; errors: readonly BlockError[] }

// compose.ts
export type CatalogCategory = 'component-lib' | 'blocks' | 'template' | 'icons' | 'design-md' | 'state' | 'styling'
export interface CatalogEntrySummary { id: string; name: string; category: CatalogCategory; frameworks: readonly string[]
  license: { spdx: string; redistributable: boolean; attribution: boolean }; install?: string; docs_url?: string }
export interface CatalogLookup { get(id: string): CatalogEntrySummary | null }
export const NO_CATALOG: CatalogLookup
export interface ComposeSelection { ref: TemplateRef; block: InstructionBlock; values: Readonly<Record<string, string>>
  catalog?: Readonly<Partial<Record<CatalogCategory, readonly string[]>>> }
export interface ComposeError { code: 'framework-mismatch' | 'missing-value' | 'catalog-category'; ref: TemplateRef; detail: string }
export function composeInstructions(input: { projectName: string; selections: readonly ComposeSelection[]; catalog: CatalogLookup }):
  { ok: true; markdown: string; directories: readonly { path: string; label: string }[] } | { ok: false; errors: readonly ComposeError[] }

// managed-blocks.ts
export const MANAGED_MARKER_LINE: RegExp            // ^<!-- PIPELINE:([A-Z][A-Z0-9_]*):(START|END) -->$
export interface ManagedBlock { tag: string; text: string }
export type ManagedParse = { ok: true; userText: string; blocks: readonly ManagedBlock[] }
  | { ok: false; error: 'unpaired' | 'reversed' | 'duplicate' | 'nested'; tag: string; line: number }
export function parseManagedBlocks(content: string): ManagedParse
export function containsManagedMarker(text: string): boolean
export function mergeManagedBlocks(editorText: string, blocks: readonly ManagedBlock[]): string
export function contentAfterDelete(blocks: readonly ManagedBlock[]): string | null   // null = unlink

// hosts.ts
export type InstructionLevels = 'joined' | 'project-wins' | 'user-wins' | 'project-only' | 'needs-config'
export type ProjectInstructionFile = 'AGENTS.md' | 'CLAUDE.md' | 'GEMINI.md'
export interface InstructionHost { id: string; projectFile: ProjectInstructionFile | null; levels: InstructionLevels }
export const INSTRUCTION_HOSTS: readonly InstructionHost[]
export const PROJECT_INSTRUCTION_FILES: readonly ProjectInstructionFile[]
export const ZED_PROJECT_ORDER: readonly string[]
export function projectTargetsFor(hostIds: readonly string[]): ProjectInstructionFile[]
export function userInstructionPath(hostId: string, ctx: { homeDir: string; env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform }): readonly string[] | null          // absolute path segments, null when not editable
export function zedEffectiveFile(exists: (rel: string) => boolean): string

// digest.ts
export function instructionDigest(bytes: Uint8Array | null): string   // 'absent' | 'sha256:<hex>' (uses src/sha256.ts)

// library-paths.ts
export function instructionLibraryRoot(input?: ProductPathInput): string    // <configRoot>/templates/instructions
```

`ownership-manifest.ts`: delete `MANAGED_BLOCK_START` / `MANAGED_BLOCK_END`; `isManagedAgentsMd(content)` becomes
`content !== undefined && (p => p.ok && p.blocks.length > 0)(parseManagedBlocks(content))`. `shouldKeepAgentsMd` and
`pruneOwnedManifest` keep their signatures.

### 4.2 kernel infrastructure `packages/kernel/src/infrastructure/builtin-library-sync.ts`

```ts
export interface BuiltinLibrary { id: string; source: string /* payload-relative */; target: string /* configRoot-relative */ }
export const BUILTIN_LIBRARIES: readonly BuiltinLibrary[] = [
  { id: 'instruction-templates', source: 'templates/instructions/builtin', target: 'templates/instructions/builtin' },
]
export type BuiltinSyncResult = { id: string; state: 'updated' | 'unchanged' } | { id: string; state: 'failed'; detail: string }
export async function syncBuiltinLibraries(payloadRoot: string, configRoot: string): Promise<readonly BuiltinSyncResult[]>
```

Per library, under `withLock(<configRoot>/<dirname(target)>)` (`kernel/src/state/lock.ts`, exported `state/index.ts:70`):
remove stale `<target>.staging-*` / `.old-*`; read the source tree (regular `.md` files only, no symlinks, ≤ 512 files, each ≤ 64 KiB,
parsed with `parseInstructionBlock`: any invalid builtin fails that library); compare `source_digest` with the marker; copy into
`<target>.staging-<pid>-<uuid>`, write marker last; rename `target → .old-<uuid>`, `staging → target`, remove `.old`; on failure of the
second rename rename `.old` back. `custom/` is never opened. Failures are returned per library, never thrown.

### 4.3 server

```ts
// packages/server/src/instructionLibrary.ts
export function listTemplates(libraryRoot: string): TemplateListBody
export function readTemplate(libraryRoot: string, ref: TemplateRef): TemplateReadResult
export function writeCustomTemplate(libraryRoot: string, category: InstructionCategory, id: string, text: string, ifMatch: string): TemplateWriteResult
export function copyTemplate(libraryRoot: string, from: TemplateRef, id: string): TemplateWriteResult
export function deleteCustomTemplate(libraryRoot: string, category: InstructionCategory, id: string, digest: string): TemplateWriteResult
export function composeFromRequest(libraryRoot: string, body: unknown, catalog: CatalogLookup): ComposeRouteResult

// packages/server/src/instructionFiles.ts
export type InstructionScope = { level: 'project'; anchor: WorkflowRootAnchor } | { level: 'user'; homeAnchor: WorkflowRootAnchor; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }
export function readInstructionTargets(scope: InstructionScope): InstructionTargetsBody
export function previewInstructionApply(scope: InstructionScope, text: string, targetIds: readonly string[]): PreviewBody | RouteError
export function applyInstructions(scope: InstructionScope, text: string, targets: readonly { id: string; base_digest: string }[]): ApplyBody | RouteError
export function deleteInstructionTarget(scope: InstructionScope, targetId: string, digest: string): DeleteBody | RouteError

// packages/server/src/instructionTrustedFs.ts  (reuses withTrustedDirectoryChain, workflowTrustedFs.ts:163-188)
export function readTargetFile(anchor: WorkflowRootAnchor, segments: readonly string[]): { bytes: Buffer | null; error?: 'target-symlink' | 'not-file' | 'too-large' }
export function writeTargetFile(anchor: WorkflowRootAnchor, segments: readonly string[], content: string, baseDigest: string): { ok: true; digest: string } | RouteError
export function unlinkTargetFile(anchor: WorkflowRootAnchor, segments: readonly string[], digest: string): { ok: true } | RouteError

// packages/server/src/projectCreate.ts
export function planProjectCreate(body: unknown, deps: ProjectCreateDeps): Promise<ProjectCreatePlan | RouteError>
export function executeProjectCreate(plan: ProjectCreatePlan, deps: ProjectCreateDeps): Promise<ProjectCreateBody | RouteError>
export interface ProjectCreateDeps { paths: ServerPaths; workflowRootAnchors: Map<string, WorkflowRootAnchor>; runGit: (args: readonly string[], cwd: string) => Promise<{ code: number; stderr: string }>; resolveActor: () => Actor | { missing: true } }

// packages/server/src/projects.ts (extracted from serverPostChangesRoutes.ts:95-135, both routes call it)
export async function registerProjectAnchored(paths: ServerPaths, anchors: Map<string, WorkflowRootAnchor>, rawRoot: unknown): Promise<{ ok: true; root: string; added: boolean } | { ok: false; code: 400 | 404 | 409; error: string }>

// packages/server/src/instructionRoutes.ts — the only thing the route tables call
export function resolveInstructionGet(req: IncomingMessage, path: string, deps: InstructionRouteDeps): Promise<RouteResult> | null
export function resolveInstructionMutation(req: IncomingMessage, method: 'POST' | 'PUT' | 'DELETE', path: string, deps: InstructionRouteDeps): Promise<RouteResult> | null
```

Wiring: one `const r = resolveInstruction…(…); if (r) return send(await r)` line each in `serverGetRoutes.ts` (before `/api/workflows`,
line 282), `serverPostRoutes.ts` (before line 198), `serverMutationRoutes.ts` `handleDeleteRoute` (after the guard, before line 144) and
`handlePutRoute` (before line 316). The mutation guard (Host 403 → token 401) runs before dispatch as today. `main.ts` calls
`await syncBuiltinLibraries(root, paths.configRoot)` after `mkdirSync(paths.stateRoot …)` (line 87) and logs failures to stderr;
`GET /api/instruction-templates` also reports the last result.

### 4.4 cli runtime

`release-store.ts` after the selection commit and before `prune` (line 322):
`await syncBuiltinLibraries(finalRoot, this.paths.configRoot).catch(() => [])` — post-commit housekeeping like `prune`; no new audit
kind (closed enum). A failed sync is retried by the next dashboard start (§4.3), which is also what covers plugin updates made by a host
marketplace outside `tenon update`.

## 5. HTTP routes

All non-GET routes: Host guard + bearer token (as `serverMutationRoutes.ts:83-89`); JSON bodies need `Content-Type: application/json`;
template PUT needs `text/markdown`. GET routes use the same Host guard and no token (as `/api/workflows`, `serverGetRoutes.ts:282`).
Errors: `{ ok: false, code, error }`; validation lists: `{ ok: false, code: 'invalid', errors: string[] }`.

### 5.1 Templates

| Method | Path | Body / query | 200 response |
| --- | --- | --- | --- |
| GET | `/api/instruction-templates` | — | `{ ok, sync: BuiltinSyncResult \| null, templates: [{ source, category, id, title, frameworks, digest, errors: string[] }] }` |
| GET | `/api/instruction-templates/:source/:category/:id` | — | `{ ok, source, category, id, text, digest, block: { title, frameworks, directory, directory_label, catalog, catalog_ref, variables:[{key, default}] } \| null, errors }` |
| PUT | `/api/instruction-templates/custom/:category/:id` | raw Markdown; header `If-Match: <digest \| absent>` (required) | `{ ok, digest }` |
| POST | `/api/instruction-templates/copy` | `{ from: { source, category, id }, id }` | `{ ok, digest }` (target `custom/<category>/<id>.md`) |
| DELETE | `/api/instruction-templates/custom/:category/:id?digest=` | — | `{ ok }` |
| POST | `/api/instruction-templates/compose` | `{ project_name, selections: [{ source, category, id, values: {k: v}, catalog?: { <category>: [entryId] } }] }` | `{ ok, markdown, directories: [{path, label}], bytes }` |

A PUT whose text fails `parseInstructionBlock` is rejected (not saved), so custom files stay parseable; files edited outside the UI can
still be invalid and are listed with `errors`.

### 5.2 Instruction files (`root` = registered project root; `root` empty = user level)

| Method | Path | Body / query | 200 response |
| --- | --- | --- | --- |
| GET | `/api/instructions?root=` | — | `{ ok, level, root, hosts: [{ id, levels, target: string \| null, effective_file?: string }], targets: [{ id, path, exists, digest, text, managed: [{ tag }], bytes, error: null \| 'managed-block-invalid' \| 'target-symlink' \| 'not-file' \| 'too-large' \| 'path-unsafe' }] }` |
| POST | `/api/instructions/preview` | `{ root, text, targets: [id] }` | `{ ok, files: [{ id, path, base_digest, current: string \| null, next: string }] }` |
| POST | `/api/instructions/apply` | `{ root, text, targets: [{ id, base_digest }] }` | `{ ok, files: [{ id, digest }] }` |
| DELETE | `/api/instructions?root=&target=&digest=` | — | `{ ok, result: 'removed' \| 'managed-kept' }` |

Target ids: project level `AGENTS.md | CLAUDE.md | GEMINI.md` (always listed); user level = host ids whose user file is not `—`.
Apply checks every base digest and marker validity first, writes nothing on any mismatch, then writes each file atomically; a failure
after the first write returns 500 `{ code: 'instruction-apply-partial', written: [id], failed: id }`.

### 5.3 Project creation

`POST /api/projects/create`

```json
{ "mode": "empty", "parent": "/Users/me/code", "name": "shop",
  "directories": ["frontend/", "backend/", "sql/"],
  "instructions": { "text": "# shop\n…", "targets": ["CLAUDE.md", "AGENTS.md"], "base_digests": { "CLAUDE.md": "absent", "AGENTS.md": "absent" } },
  "dry_run": true }
{ "mode": "existing", "path": "/Users/me/code/legacy", "directories": [], "instructions": { … }, "dry_run": false }
```

- Dry run response: `{ ok, root, git: 'init' | 'existing' | 'none', registration: 'add' | 'already', directories: [{ path, exists }],
  files: [{ id, path, base_digest, current, next }] }`. No side effects.
- Execute response: `{ ok, root, git, registration, directories: [path], files: [{ id, digest }] }`.
- `empty`: validate everything (including `git --version`) → `mkdir` (non-recursive, parent anchored) → `git init` → each directory +
  `.gitkeep` → instruction files (base must be `absent`) → `registerProjectAnchored`. Any failure after `mkdir` removes the created
  directory (identity checked by inode) and returns 500 `{ code: 'project-create-failed', step }`.
- `existing`: path must exist; `directories` must be empty; never `git init`; instruction files use the dry-run base digests; then
  register (already registered → `registration: 'already'`, no error).
- `instructions` may be `null` (register only).

## 6. Data flow

```
templates/instructions/builtin (repo) ──payload──▶ release activation ─┐
                                        dashboard start (digest diff) ─┴▶ syncBuiltinLibraries ─▶ <configRoot>/…/builtin
库 page ─GET/PUT/POST/DELETE /api/instruction-templates─▶ instructionLibrary ─▶ custom/*.md  (parse on save)
新建项目 dialog ─POST compose─▶ kernel composeInstructions ─▶ markdown ─POST projects/create dry_run─▶ plan (current/next per file)
                ─POST projects/create─▶ mkdir → git init → dirs → files (mergeManagedBlocks) → registry ─▶ snapshot refresh
项目 page ─GET /api/instructions─▶ split (userText, blocks, digest) ─textarea─▶ POST preview ─▶ next ─lineDiff─▶ Drawer
         ─POST apply { base_digest }─▶ digest check ─▶ merge ─▶ atomic write ─▶ GET refresh
polling (5 s visible + window focus) ─▶ digest ≠ base ─▶ not dirty: reload; dirty: 外部修改 banner; apply → 409 → same banner
```

## 7. Dashboard

### 7.1 Navigation and shell

- `shell/views.ts`: `VIEWS = ['progress', 'workbench', 'projects', 'library']`. Nav labels `nav.projects: 项目` (exists), `nav.library: 库`.
- `App.tsx`: lazy `ProjectsView`, `LibraryView`; the dirty guard generalizes from `view === 'workbench'` to `dirtyView: View | null`
  reported by any editor (`onDirtyChange(view, dirty)`), same confirm/UnsavedDraftDialog flow (App.tsx:93-113,148-169). App stays
  under 600 lines (373 today).
- `Onboarding.tsx`: the two CLI command rows are removed; the no-project state shows one action `新建项目` (`onboard-new-project`) that
  opens `projects` with the dialog open.
- Every row, chip, label: `whitespace-nowrap` + truncation / horizontal scroll; no sentences except errors; tokens only.

### 7.2 项目 page (`projects/`)

`ProjectsView.tsx` renders `ThreeColumns` (`shell/ThreeColumns.tsx:10`):

- **Rail**: `RailCard` 用户级 (`proj-user`, selected when `root === ''`), one `RailCard` per registered project (path only,
  `proj-root-<basename>`), `RailFootLink` `新建项目` (`proj-new`). Selection goes through App's `selectProject`; URL `?view=projects&root=`.
- **List** (`HostTargetList.tsx`): 12 host rows `proj-host-<id>`: host name · file (`CLAUDE.md` / path basename / `—`) · levels label
  (`proj-levels-<id>`: 叠加 / 项目优先 / 个人优先 / 仅项目 / 需配置) · checkbox (`aria-checked`, absent when file is `—`). Under the rows a
  file table `proj-file-<id>`: file · 状态 (缺失 / 一致 / 不同 / 错误) · 受管块 count. Zed row shows the effective file; red tone when it is
  not `AGENTS.md`. `AGENTS.md` over 32 KiB gets a red `32KiB` chip (Codex `project_doc_max_bytes`).
- **Detail** (`InstructionEditor.tsx`): `DetailColumn` header: eyebrow 项目级 / 用户级, H1 project name or 用户级, mono root; `SheetTabs`
  编辑 (`proj-tab-edit`, monospace `<textarea>` `proj-editor`) / 预览 (`proj-tab-preview`, `Markdown`). Editor loads the `text` of the first
  selected existing target; when selected targets differ, the file table shows 不同 and each row has 载入 (`proj-load-<id>`). Footer:
  应用 (`proj-apply`) → `DiffDrawer.tsx` (`proj-diff`, one section per file, `lineDiff` rows `data-op=add|del|eq`, 确认 `proj-diff-confirm`);
  删除 (`proj-delete`) → `Dialog` listing files and 受管块保留 count → DELETE per file. Banner `proj-external` (外部修改 · 重新载入).
  No token (`getToken() === ''`) disables every write control.
- `useInstructionFiles.ts`: GET, 5 s polling while `document.visibilityState === 'visible'` and on focus, `baseDigests`, `dirty`,
  `external`; `instructionModel.ts`: `targetsForHosts`, `fileStatus`, `firstLoadable`.

### 7.3 新建项目 dialog (`projects/NewProjectDialog.tsx`, `Dialog variant="workspace"`)

`SheetTabs`: 目录 · 模板 · 宿主 · 预览.

- 目录: radio 已有目录 / 新建目录 (`np-mode-existing|empty`); 路径 (`np-path`) or 父目录 (`np-parent`) + 名称 (`np-name`).
- 模板 (`TemplatePicker.tsx`): one row per category: category word + checkbox chips (`np-block-<source>-<category>-<id>`, title,
  内建/自定义 pill); 状态管理 / 样式 rows appear after a 前端 block is checked and list only compatible blocks; 通用/base preselected; 变量
  table (block · key mono · input with default as placeholder) for selected blocks; catalog selects only when design-resources supplies
  entries.
- 宿主: the same `HostTargetList` (checkboxes; claude + codex preselected).
- 预览: POST compose then POST create `dry_run`; file table (文件 · 新建 / 修改 / 不变), directories chips, `Markdown` preview, row → DiffDrawer.
  Footer 创建 (`np-create`) → POST create; success → snapshot `refresh()`, `selectProject(root)`, close. Errors list `role=alert`.

### 7.4 库 page (`library/`)

`LibraryView.tsx` renders `ThreeColumns`: rail sections (模板 `lib-section-templates`; other children add sections), list: category
`FilterChip`s, source chips 内建 / 自定义, search input, rows `lib-tpl-<source>-<category>-<id>` (title · mono `category/id` · pill), list
header `+` (`lib-tpl-new` → `NewTemplateDialog.tsx`: category select + id). Detail (`TemplateDetail.tsx`): eyebrow category word, H1
title, mono `builtin/frontend/typescript-react.md`, `StatusPill` 内建 / 自定义; SheetTabs 预览 / 编辑 (custom only); 变量 table (key · 默认);
errors list. Footer: builtin → 复制 (`lib-tpl-copy`, dialog asks id); custom → 复制, 保存 (`lib-tpl-save`, `If-Match`), 删除
(`lib-tpl-delete`, confirm). 409 → error text + 重新载入.

### 7.5 API client

`api/instructionsClient.ts` + `api/instructionsDecoders.ts` (closed decoders, `isRecord`/`stringArray` from `transport.ts`); errors via
`throwApiError` / `formatApiError`. `shared/lineDiff.ts`: LCS line diff `(a: string, b: string) => { op: 'eq' | 'add' | 'del'; text: string }[]`
(inputs ≤ 256 KiB; above 4 000 × 4 000 lines falls back to whole-file del/add).

### 7.6 Dictionary (zh; en mirrors)

`nav.library` 库. `projects.*`: 用户级, 项目级, 新建项目, 已有目录, 新建目录, 路径, 父目录, 名称, 宿主, 文件, 状态, 受管块, 编辑, 预览, 应用,
删除, 确认, 载入, 重新载入, 外部修改, 缺失, 一致, 不同, 错误, 新建, 修改, 不变, 目录, 模板, 创建, levels 叠加 / 项目优先 / 个人优先 / 仅项目 /
需配置, error codes of §9. `library.*`: 模板, 内建, 自定义, 复制, 保存, 变量, 默认, and category words 通用 / 前端 / 状态管理 / 样式 / 后端 /
移动端 / 系统 / 接口约定 / 数据库. No `*_desc`, `*_hint`, `*_note`, `*_lead` keys.

## 8. Builtin block inventory (`templates/instructions/builtin/`, 32 files)

Every language block (frontend, backend, mobile, system) has exactly the sections 技术栈 · 分层结构 · 编码规范 · 文件长度 · 测试要求 at the
depth of `research/draft-template-react-java.md` §3–§4: a directory tree with dependency rules, 10–15 concrete rules, a soft/hard length
table driven by variables, and the commands that must pass. Version numbers are checked against official docs on the authoring day.

### 8.1 通用

| File | Sections | Content |
| --- | --- | --- |
| `common/base.md` | 最终回复格式 · 目录约束 | baseline §1 verbatim; baseline §2 with `{{directories}}` table and the two rules (no code outside listed dirs, root holds repo-level config only) |

### 8.2 前端 (`catalog: [component-lib, icons, design-md]`, directory `frontend/`)

| File | frameworks | Stack · layering · key rules · length (soft/hard vars) · tests |
| --- | --- | --- |
| `frontend/typescript-react.md` | react | TS + React + Vite + pnpm; baseline feature-first tree and dependency rules; baseline §3.3 rules except state/styling (moved to their blocks); Axios only via `shared/api` with `{code,msg,data}` unwrapping; `{{catalog.component-lib}}` `{{catalog.icons}}` lines; `DESIGN.md` line when selected; `.tsx` 200/350, `.ts` 250/400; Vitest + Testing Library, Playwright e2e, `pnpm lint/typecheck/test` |
| `frontend/typescript-vue3.md` | vue | Vue 3 `<script setup lang="ts">` + Vite + pnpm; `features/<f>/{api,components,composables,stores,types,utils,index.ts}`, same one-way rules; Composition API only, typed `defineProps/defineEmits`, no prop mutation, `computed` over `watch`, stable `v-for` keys, `vue-tsc --noEmit` strict; `.vue` 200/350, `.ts` 250/400; Vitest + Vue Test Utils, Playwright |
| `frontend/typescript-angular.md` | angular | Angular LTS standalone + signals + pnpm; `app/{core,shared,features/<f>/{feature,ui,data-access,util}}`; no NgModules, `OnPush`, `inject()`, `@if/@for` with `track`, `takeUntilDestroyed`, strict templates; component `.ts` 250/400, `.html` 150/300; `ng test`, Playwright |

### 8.3 状态管理 (`###` heading, `catalog_ref`)

| File | frameworks | Rules |
| --- | --- | --- |
| `state/zustand.md` | react | store per feature in `store/`, expose selectors and actions only, subscribe with selectors / `useShallow`, no server data in stores |
| `state/redux-toolkit.md` | react | one slice per feature, typed `useAppSelector/useAppDispatch`, RTK Query for server data, no hand-written reducers outside slices |
| `state/jotai.md` | react | atoms colocated per feature, derived atoms for computed data, `atomFamily` cleanup, no single global atom object |
| `state/tanstack-query.md` | react, vue | query key factory per feature, invalidation after mutations, never copy query data into client stores |
| `state/pinia.md` | vue | setup stores per feature, `storeToRefs` when destructuring, actions own async work, no cross-store cycles |
| `state/angular-signals.md` | angular | feature signal services, `computed` for derived state, `effect` only for external sync, no `BehaviorSubject` state |
| `state/ngrx-signals.md` | angular | `signalStore` per feature, `withState/withComputed/withMethods`, `rxMethod` for side effects |

### 8.4 样式 (`###` heading, `catalog_ref`)

| File | frameworks | Rules |
| --- | --- | --- |
| `styling/tailwind.md` | react, vue, angular | utility classes only, tokens in theme (`@theme`), no new global CSS except tokens, class merging helper, no arbitrary values when a token exists |
| `styling/css-modules.md` | react, vue | `*.module.css` next to the component, CSS variables for tokens in one file, `:global` only in the app shell |
| `styling/scss.md` | angular, vue, react | component-scoped styles, `@use` not `@import`, tokens in `_tokens.scss`, nesting ≤ 3 |

### 8.5 后端

| File | directory | Stack · layering · key rules · length · tests |
| --- | --- | --- |
| `backend/java-spring-boot-ddd.md` | `backend/` | baseline §4 verbatim (Java 21, Spring Boot 4, Gradle Groovy multi-module `{{app}}-domain/application/infrastructure/interfaces/bootstrap`, DDD rules, JPA rules); class 300/500, method 40/80; JUnit 5 + AssertJ + Testcontainers PostgreSQL, ArchUnit layer tests, `./gradlew build` |
| `backend/kotlin-spring-boot.md` | `backend/` | Kotlin + Spring Boot + Gradle Kotlin DSL; hexagonal `domain / application / adapter/in / adapter/out`; constructor injection, `val` + data classes, no `!!`, sealed results, coroutines in adapters only; file 300/500, function 40/80; JUnit 5 + MockK + Testcontainers |
| `backend/go.md` | `backend/` | Go stable + modules; `cmd/<app>`, `internal/<domain>/{handler,service,repository}`; `context.Context` first, wrap errors `%w`, no panic in libraries, interfaces at the consumer, `golangci-lint`; file 400/600, func 50/100; table-driven `go test -race`, testcontainers-go |
| `backend/python-fastapi.md` | `backend/` | Python 3.12 + FastAPI + uv + Pydantic v2 + SQLAlchemy 2; `app/{api,schemas,services,repositories,models,core}`; type hints everywhere, pyright strict, `Depends` injection, no business logic in routers, async I/O only; module 300/500, function 40/80; pytest + httpx `AsyncClient` |
| `backend/python-django.md` | `backend/` | Django + DRF + uv; `apps/<context>/{models,services,selectors,api,tests}`; services write, selectors read, thin views, no business logic in signals, `select_related/prefetch_related`; module 300/500, function 40/80; pytest-django |
| `backend/node-nestjs.md` | `backend/` | Node LTS + NestJS + TS strict + pnpm + Prisma Client; `src/modules/<context>/{domain,application,infrastructure,interfaces}`; constructor DI, class-validator DTOs, exception filter → unified response, no `any`; file 300/500, method 40/80; Vitest/Jest + supertest |
| `backend/csharp-aspnet-core.md` | `backend/` | .NET LTS + ASP.NET Core + EF Core; `src/{App.Domain,App.Application,App.Infrastructure,App.Api}`; nullable enabled, records for DTOs, async + `CancellationToken`, no lazy loading, ProblemDetails mapped to unified response; file 300/500, method 40/80; xUnit + FluentAssertions + Testcontainers |
| `backend/rust-axum.md` | `backend/` | Rust stable + Axum + Tokio + SQLx; workspace `crates/{domain,application,infrastructure,api}`; no `unwrap/expect` outside tests and `main`, `thiserror` in libraries, `anyhow` only in the binary, `clippy -D warnings`; file 400/700, fn 50/100; `cargo test`, SQLx test databases |
| `backend/php-laravel.md` | `backend/` | PHP 8.3 + Laravel + Composer; `app/Domain/<Context>/{Models,Actions,Data}`, `app/Http/{Controllers,Requests,Resources}`; `strict_types`, FormRequest validation, Actions hold business logic, `preventLazyLoading`, Larastan max level; class 300/500, method 40/80; Pest |
| `backend/ruby-rails.md` | `backend/` | Ruby 3.3 + Rails + Bundler; `app/{models,controllers,services,queries,serializers}`; thin controllers, service objects with `call`, strong params, no business logic in callbacks, RuboCop; class 250/400, method 20/40; RSpec + FactoryBot request specs |

### 8.6 移动端

| File | directory | Stack · layering · key rules · length · tests |
| --- | --- | --- |
| `mobile/swift-swiftui.md` | `ios/` | Swift + SwiftUI + SPM; `Features/<F>/{Views,Models,Services}`; `@Observable` models, `@MainActor` UI, async/await, no force unwrap, SwiftLint; file 300/500, `body` 80/150; Swift Testing + XCUITest |
| `mobile/kotlin-android-compose.md` | `android/` | Kotlin + Jetpack Compose + Gradle KTS + Hilt; `feature/<f>/{ui,domain,data}`; ViewModel + `StateFlow`, unidirectional data flow, `collectAsStateWithLifecycle`, no logic in composables, detekt; file 300/500, composable 60/120; JUnit + Turbine + Compose UI tests |
| `mobile/dart-flutter.md` | `mobile/` | Dart + Flutter + Riverpod; `lib/features/<f>/{presentation,application,domain,data}`; `const` widgets, immutable state, no logic in `build`, `flutter_lints`; file 300/500, `build` 60/120; `flutter test` + `integration_test` |

### 8.7 系统

| File | directory | Stack · layering · key rules · length · tests |
| --- | --- | --- |
| `system/c.md` | `native/` | C17 + CMake + clang-format/clang-tidy; `include/<project>/`, `src/`, `tests/`; check every return value, paired alloc/free ownership comments, no VLAs, `static` internal linkage, ASan/UBSan in debug; file 500/800, function 50/100; ctest + Unity |
| `system/cpp.md` | `native/` | C++20 + CMake + vcpkg; `include/`, `src/`, `tests/`; RAII, no raw `new/delete`, `std::unique_ptr` ownership, `const` correctness, no exceptions across ABI boundaries, clang-tidy; file 500/800, function 50/100; GoogleTest + ctest + sanitizers |

### 8.8 接口约定 and 数据库

| File | directory | Sections · content |
| --- | --- | --- |
| `api/rest-v1-unified-response.md` | — | 前缀与版本 · 统一响应 · 分页 · 错误码: baseline §5 verbatim (`/api/v1`, `{code,msg,data}`, `PageResult`, `code` int / `total` long, one error-code table shared with the frontend) |
| `database/postgresql.md` | `sql/` | 脚本 · 表结构 · 约束: baseline §6 verbatim, plus the migration ban listing Flyway, Liquibase, Alembic, Django migrations, Prisma Migrate, Laravel and Rails migrations |
| `database/mysql.md` | `sql/` | same sections; InnoDB + `utf8mb4`; `id bigint auto_increment primary key`, `version bigint not null default 0`, `created_at/updated_at datetime(3)` with `ON UPDATE CURRENT_TIMESTAMP(3)`; inline `COMMENT`; no stored procedures, no triggers |

Gate: `tools/check-instruction-templates.mjs` (npm `check:instruction-templates`) parses every builtin with the built kernel, asserts the
32-file inventory, the per-category section headings above, and that composing `common/base + frontend/typescript-react + state/zustand +
styling/tailwind + backend/java-spring-boot-ddd + api/rest-v1-unified-response + database/postgresql` succeeds.

## 9. Validation and error matrix

| Condition | Where | Result |
| --- | --- | --- |
| Template `source/category/id` not matching grammar | server | 400 `invalid-template-ref` |
| PUT/DELETE on `builtin` | server | 409 `template-builtin-readonly` |
| PUT without `If-Match`, or `If-Match` ≠ current digest (`absent` when creating) | server | 428 `if-match-required` / 409 `template-changed` (`digest`) |
| Copy target exists | server | 409 `template-exists` |
| Frontmatter / placeholder errors on save | server | 400 `invalid` with `errors[]`, nothing written |
| Compose errors (framework mismatch, missing value) | server | 400 `invalid` with `errors[]` |
| Body over 256 KiB (instruction text) / 64 KiB (template) | server | 413 |
| `root` not registered | server | 404 (existing `workflowRootForRequest` wording) |
| Unknown target id / host without user file | server | 400 `invalid-target` |
| Editor text contains a managed marker line | server | 400 `managed-marker-in-text` |
| Current file has malformed markers | server | GET `error: managed-block-invalid`; preview/apply/delete 409 `managed-block-invalid`, file unchanged |
| Base digest ≠ current digest (external change) | server | 409 `instruction-file-changed` `{ id, digest }`, nothing written; UI banner 外部修改 |
| Target file is a symlink / not a regular file | server | GET `error: target-symlink` / `not-file`; writes 409 same code |
| An existing ancestor directory (inside project root or home) is a symlink or replaced during the call | server | 409 `path-unsafe` (mapped from `workflowTrustedFs` errors, fixed message) |
| Missing parent directories under home (e.g. `~/.gemini/`) | server | created with the trusted chain, then written |
| `EACCES` / `EPERM` / `EROFS` | server | 422 `write-denied` `{ path }` |
| `AGENTS.md` > 32 KiB | UI | red `32KiB` chip (not blocked) |
| Identity missing (after multi-user wiring) | server | 409 `identity-missing` on every write |
| Create: `path`/`parent` not absolute, contains NUL, `name` not `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` | server | 400 `invalid-path` |
| Create empty: target exists | server | 409 `project-path-exists`, nothing written |
| Create empty: parent missing / not dir / symlink | server | 404 `parent-missing` / 400 `parent-not-directory` / 400 `path-unsafe` |
| Create empty: parent not writable | server | 422 `write-denied` |
| Create: `git` not runnable | server | 422 `git-unavailable` before any write |
| Create empty: failure after `mkdir` | server | created directory removed; 500 `project-create-failed` `{ step }` |
| Create existing: path missing / not dir / symlink | server | 404 / 400 / 400 (same codes as `POST /api/projects`) |
| Create existing: `directories` non-empty | server | 400 `invalid` |
| Create existing: already a git repo / already registered | server | `git: 'existing'`, `registration: 'already'` (200) |
| Directory names not `[a-z0-9._-]+/` or more than 8 | server | 400 `invalid` |
| Builtin sync: invalid builtin, symlink in payload, rename failure | kernel | library `failed`, previous builtin kept; activation unaffected; next dashboard start retries |
| Zed adapter: user `.rules` present | adapter | block written into `.rules` (the file Zed reads) |
| Cursor adapter: legacy `.cursor/rules/pipeline.md` edited by user | adapter | kept, warning printed, not counted as failure |

## 10. Compatibility, migration, removals

- **Kernel exports removed**: `MANAGED_BLOCK_START`, `MANAGED_BLOCK_END` (only test import `ownership.test.ts:9`). Untagged
  `<!-- PIPELINE:START -->` is no longer recognized; no writer produces it. `commands/tenon-uninstall.md:13,33` updated to the tagged
  grammar.
- **Zed adapter**: stops creating `.rules`. Install: (1) if `.rules` contains only the ZED block (whitespace aside), delete it;
  (2) remove the ZED block from every file in `ZED_PROJECT_ORDER` except the effective file; (3) upsert the block into the effective file
  (first existing in the order, else `AGENTS.md`). Idempotent. README and `registry.yaml` comment say "effective instruction file".
- **Cursor adapter**: writes `.cursor/rules/tenon.mdc` with frontmatter `description: Tenon workflow` and `alwaysApply: true`; removes
  `.cursor/rules/pipeline.md` only when its sha256 equals the previously generated content (constant in the script), otherwise warns and
  keeps it. README updated.
- **Onboarding**: CLI teaching rows and their dictionary keys removed; test `Onboarding.test.tsx` rewritten for the single action.
- **`POST /api/projects`** stays (behaviour unchanged) but its body moves into `registerProjectAnchored`; the unused dashboard client
  `registerProject` (`governanceClient.ts:38-51`) is deleted.
- **No data migration**: the library is new; builtin appears on the first activation or dashboard start after upgrade.
- **Versioning**: none needed; the marker digest drives updates.

## 11. Tests required (assertion points)

Kernel (`npx vitest run packages/kernel/src/instructions packages/kernel/src/infrastructure/builtin-library-sync.test.ts packages/kernel/src/state/ownership.test.ts`):

- `instructions/managed-blocks.test.ts`: the real `templates/generated/codex-agents-block.md` parses as one `CODEX` block; unpaired,
  reversed, duplicate, nested each return the right error and line; merge appends blocks after user text with one blank line; delete
  keeps blocks / returns null without blocks; `containsManagedMarker` true for a marker line, false for marker text inside prose.
- `state/ownership.test.ts` (regression for R7): `shouldKeepAgentsMd(realCodexBlockWrappedInUserText) === true`;
  `pruneOwnedManifest({ 'AGENTS.md': h }, { agentsMdContent: that })` keeps the key; untagged `<!-- PIPELINE:START -->` pair is not managed.
- `instructions/block.test.ts`: valid block round-trips every field; id/category mismatch; unknown key; missing title; state block without
  `frameworks`; unknown placeholder with line; `\{{` literal; marker in body; > 64 KiB.
- `instructions/compose.test.ts`: category order; `{{directories}}` dedupe; state/styling rendered inside the frontend section; framework
  mismatch error; required variable missing; values override defaults; `NO_CATALOG` removes catalog lines; golden output for the React +
  Java + PostgreSQL + REST selection contains `## 前端`, `## 后端`, `/api/v1`, `sql/`, `frontend/`, `backend/` rows.
- `instructions/hosts.test.ts`: host id set equals `ADAPTER_CAPABILITY_ROWS.map(r => r.host_id)`; `projectTargetsFor(['claude','codex'])` =
  `['CLAUDE.md','AGENTS.md']`; `CODEX_HOME` absolute honoured, relative ignored; zed win32 path; `zedEffectiveFile` picks `.rules` over
  `AGENTS.md` and defaults to `AGENTS.md`; labels for copilot/cursor/zed/aider.
- `infrastructure/builtin-library-sync.test.ts`: first sync copies tree + marker; same digest → `unchanged` and no mtime change; changed
  source replaces wholesale (removed file disappears); `custom/` byte-identical after sync; invalid builtin or symlink → `failed`, previous
  builtin intact; stale staging dirs cleaned.

Server (`npx vitest run packages/server/src/instruction*.test.ts packages/server/src/projectCreate.test.ts`), write requests use
`reqPost(port, path, body, { headers: { Authorization: … } })` (spec `server/backend/workflow-branches-and-skill-files.md` §6):

- `instructionRoutes.test.ts`: 403 bad Host, 401 no token on every mutation; list shows builtin + custom with errors; PUT builtin 409;
  PUT custom new (`If-Match: absent`) 200; stale `If-Match` 409; invalid text 400 and file absent; copy 200 then 409; DELETE stale 409;
  compose 200 golden, 400 mismatch.
- `instructionFiles.test.ts` (tmp project registered, tmp home): GET lists three project files with digest + managed tags; preview `next`
  of `AGENTS.md` ends with the Codex block; apply `CLAUDE.md` + `AGENTS.md` → user text identical, `AGENTS.md` keeps the block; file
  changed between preview and apply → 409 and both files unchanged; symlinked `CLAUDE.md` → 409 and link target unchanged; malformed
  markers → 409; delete `CLAUDE.md` removed, `AGENTS.md` → block only; user level writes `<home>/.claude/CLAUDE.md` and
  `$CODEX_HOME/AGENTS.md`; symlinked `~/.gemini` → 409 `path-unsafe`; read-only dir → 422 (skipped when uid 0).
- `projectCreate.test.ts`: dry run leaves no directory; empty execute → dir, `.git/HEAD`, `frontend/.gitkeep`, `backend/.gitkeep`,
  `sql/.gitkeep`, `CLAUDE.md` user text === `AGENTS.md` user text, registry contains root, anchor stored; existing path → 409 nothing
  written; `git` stub failing → 422 before `mkdir`; injected failure after `mkdir` → directory gone, 500 `step`; existing mode with
  `.git` → `git: existing`, `.git` untouched, no new directories; already registered → `registration: already`.
- `serverPostChangesRoutes` characterization: `POST /api/projects` responses unchanged after the extraction.
- `release-store.integration.test.ts`: activation of a candidate with `templates/instructions/builtin` populates
  `<configRoot>/templates/instructions/builtin` and leaves a pre-seeded `custom/` file byte-identical; a sync failure still activates.

Dashboard (`npm run typecheck:web && npm run test:web`):

- `api/instructionsDecoders.test.tsx`: reject extra/missing keys and wrong enums.
- `shared/lineDiff.test.ts`: eq/add/del sequence; large-input fallback.
- `projects/ProjectsView.test.tsx`: rail 用户级 + projects + 新建项目; `proj-levels-claude` 叠加, `-zed` 项目优先, `-copilot` 个人优先,
  `-cursor` 仅项目, `-aider` 需配置, aider has no checkbox; checking claude + codex targets `CLAUDE.md` + `AGENTS.md`; 应用 opens `proj-diff`
  with both files, 确认 posts `base_digest`s; 409 shows `proj-external`; polling with a changed digest and a clean editor reloads silently;
  dirty editor + changed digest shows the banner; 删除 dialog then DELETE; empty token disables writes; switching view with a dirty editor
  opens the unsaved dialog.
- `projects/NewProjectDialog.test.tsx`: empty mode requires parent + name; checking `typescript-react` reveals 状态管理/样式 rows with only
  react-compatible chips; React + Java selection posts compose with namespaced values; 预览 shows files 新建 and directories
  `frontend/ backend/ sql/`; 创建 posts `dry_run: false` then refreshes and selects the new root; 409 `project-path-exists` rendered via
  `formatApiError`.
- `library/LibraryView.test.tsx`: builtin detail shows 复制 only; custom shows 复制 / 保存 / 删除; save sends `If-Match`; copy then list
  contains the custom row; delete removes it; server `errors` render as a list.
- `shell` / `App.test.tsx`: `VIEWS` deep links `?view=projects&root=` and `?view=library`; nav renders four tabs; Onboarding shows
  `onboard-new-project` only.
- `i18n.test.tsx` stays green (parity, no Chinese literals, no `Error.message`).

Adapters (`bash tools/test-adapters.sh`):

- Cursor: `.cursor/rules/tenon.mdc` exists with `alwaysApply: true` inside frontmatter; no `pipeline.md`; legacy generated
  `pipeline.md` removed; edited legacy file kept with warning and exit 0.
- Zed: clean project → no `.rules`, one ZED block in `AGENTS.md`; user `.rules` → block in `.rules`, not in `AGENTS.md`; Tenon-only
  `.rules` from the old installer → deleted, block moved to `AGENTS.md`; reinstall → exactly one ZED block across all order files; the
  script's order list equals kernel `ZED_PROJECT_ORDER` (node import of `packages/kernel/dist`).

Real host evidence (recorded in `verification.md` of this task during implementation):

- Claude Code and Codex: PRD acceptance items 1–3 and 6 in fresh sessions on the installed release (project + user level constraint
  answered from the files; deletion stops it).
- Zed (`Zed.app` installed): project with a user `AGENTS.md` and no `.rules` → agent quotes the AGENTS.md rule; add `.rules` → agent quotes
  only `.rules`. If the Zed agent cannot run without an account, record the docs quote as the evidence.
- Cursor (not installed): docs quote dated 2026-09-15 is the evidence; no claim of a live run.

## 12. Decisions made during design

1. **Blocks, not whole templates.** The PRD open question is answered with the user's 2026-09-15 block decision; one file per block,
   categories fixed (§3.2); state and styling are separate categories filtered by frontend `frameworks`.
2. **Fixed frontmatter grammar** parsed in kernel, because kernel has no YAML dependency; closed keys so bad files fail loudly.
3. **Variables are block-scoped** (`{{component.soft}}` inside its block) so two backend blocks never collide; the baseline's inline
   `{key = default}` syntax becomes frontmatter defaults.
4. **No section numbers** in composed output; any subset composes without renumbering.
5. **Managed blocks move to the end of the file on apply** and are otherwise verbatim; malformed markers block writes.
6. **Marker grammar is tag-based** (`PIPELINE:<TAG>:START|END`); the untagged legacy form is dropped because nothing writes it.
7. **Same content per level**: one editor per level writes identical user text to every selected target (PRD decision: no `@AGENTS.md`).
   Files that differ are shown as 不同 with per-file 载入.
8. **User-level targets only where a plain whole-file Markdown path is documented**; Copilot, Cursor, Continue, Aider are labelled but not
   editable at user level.
9. **Zed row shows the effective file** and the Zed adapter writes into it, instead of deleting user files.
10. **Cursor uses `.mdc` with `alwaysApply: true`** (smallest change that the docs say works).
11. **Builtin sync runs at activation post-commit and at dashboard start** (digest-gated). Activation alone misses host-marketplace
    updates; startup alone misses CLI-only use by other libraries.
12. **Symlinks are refused** for target files and for ancestors inside the trust root (project root or home); no following.
13. **Parent directories under home are created** when missing (e.g. `~/.gemini/`), through the trusted chain.
14. **Editor is a `<textarea>` + `Markdown` preview**; no editor dependency. **Diff is computed in the dashboard** from the server's
    `current`/`next`; the server alone merges.
15. **Project creation is one endpoint with `dry_run`**, covering both modes; existing mode never runs `git init` and never creates
    skeleton directories; empty mode adds `.gitkeep` so the skeleton is committable; failure after `mkdir` removes the directory.
16. **Path input, no server directory browser** (minimal; avoids a listing endpoint over the home directory).
17. **No CLI commands**; the only CLI change is the activation hook.
18. **Page word 库** for the Library surface; builtin is **内建** (the word the workflow page already uses), not 内置.
19. **Audit and author stamping** land after multi-user merges (injected `resolveActor`; §10 commit 16 of `implement.md`).
20. **Route modules are separate files** (`instructionRoutes.ts`) with one-line dispatch, because the route tables sit at 315–396 of a
    400-line gate.

## 13. Contract change requests (for the parent `design.md`; not applied here)

- **CCR-1 Shared builtin sync.** Add to §3: `syncBuiltinLibraries(payloadRoot, configRoot)` in
  `packages/kernel/src/infrastructure/builtin-library-sync.ts` owns writing every `builtin/` library; each library writes
  `builtin/.library.json` `{ version, library, source_digest, synced_at }`. Triggers: release activation post-commit
  (`packages/cli/src/runtime/release-store.ts` after line 310) and dashboard server start. review-agents, design-resources and test-evidence
  add one row each to `BUILTIN_LIBRARIES` instead of writing their own copier.
- **CCR-2 Library page shell.** Add to §7: instruction-templates creates the `library` view (`VIEWS`, nav `库`, rail of sections) with the
  模板 section; other children add rail sections and detail components only. Add to §1 Terms: Library page = 库; builtin = 内建;
  user-created = 自定义.
- **CCR-3 Level labels.** Add to §1 Terms: instruction loading labels 叠加 / 项目优先 / 个人优先 / 仅项目 / 需配置.
- **CCR-4 Catalog lookup port.** Add to §3/§7: design-resources implements kernel `CatalogLookup` (`get(id) → CatalogEntrySummary | null`,
  fields in §4.1) and a server list route used by the 新建项目 dialog; instruction-templates ships `NO_CATALOG`. design-resources extends
  `POST /api/projects/create` with `design_md` (entry id) and writes `DESIGN.md` in the same transaction.
- **CCR-5 Audit path.** Add to §3 Global: `config/templates/instructions/audit.jsonl` (owner instruction-templates) with the row in §3.1,
  covering template and instruction-file writes and project creation (multi-user R2).
- **CCR-6 Projects page entry.** Add to §7: the no-project Onboarding state becomes a single 新建项目 action (retires the CLI teaching
  state and decision #7).
