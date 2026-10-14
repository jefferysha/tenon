# 文档机制重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新任务不再预先规定每一步的输入输出文档：Tenon 在离开步骤时观察实际产出并标注来源技能，只把直接上游的文档产出交给下一步且必须读完，门禁只保留按路径的必须产出；旧快照任务照旧走完。

**Architecture:** kernel 新增深模块 `documents/step-outputs.ts`（内部接缝 `workspace/step-checkpoint.ts` 做 git 检查点与比较、`state/step-output-ledger.ts` 存账本），转换在锁内直接调用它记录产出与校验读取；`capabilities.documents.mode` 是唯一分流点（`contract` = 冻结计划带旧契约，`observed` = 新任务）。CLI / server / Dashboard 只按 mode 投影；工作流 YAML 删除 `document_contract` 与步骤 `inputs` / `outputs` / `artifacts`，新增 `required-output` 守卫。

**Tech Stack:** TypeScript ESM（Node 22），vitest，git CLI 子进程，React 18 dashboard（Vite），Playwright e2e。

**Spec:** `docs/superpowers/specs/rework-document-mechanism-design.md`（设计）；`openspec/changes/rework-document-mechanism/specs/*/spec.md`（delta spec，8 个 capability）；`openspec/changes/rework-document-mechanism/proposal.md`。

## Global Constraints

- 只改本任务范围：kernel 文档契约与治理、产出登记与读取回执、CLI document / artifact 命令、status / step 里与文档有关的 next 动作、工作流 YAML 的 inputs / outputs / artifacts / document_contract 键、Dashboard 输入输出显示、`skills/tenon/SKILL.md` 文档动作行、相关文档。
- 不碰测试体系：test-system 代码、`.tenon/tests/catalog.yaml`、YAML 的 `test_policy` / `tests` 键、测试相关动作行、code-size、测试信任。唯一例外是 `statusStepTestFlow.ts` 里「验证报告路径从哪里取」这一处（设计 §10）。
- 不碰 Dashboard 画布：`OrchestrationFlow*`、`orchestration*.ts`、`SkillFlow*`、`skillFlow*`、`StageFlowSection*`、`signalPlan*`、`flowSignal*`、`pipelineModel*`、`MiniPipeline*`、`StageRail*`、server `orchestrationGraph.ts`；`StageEditorPane.tsx` 只改输入输出两段。
- 文件行数上限（`tools/check-architecture.mjs`）：`packages/kernel/src/state/**` 与 `*codec|store|repository.ts` ≤ 500；其余 kernel ≤ 450；`packages/cli/src/commands/**` ≤ 400；其余 cli ≤ 500；`packages/server/src/**` ≤ 400；dashboard 组件 / hook ≤ 400、页面 ≤ 600。逼近上限就按职责拆文件。
- 新增或修改的生产代码不得有显式 / 隐式 `any`、非空断言、无校验的类型断言；外部输入先以 `unknown` 收窄。跨包只用提供方 `src/index.ts` 公开出口。
- kernel 领域纯函数不导入 Node fs / 子进程；git 与文件读写放在 `workspace/` 与 `state/` 的基础设施模块里。
- 新增用户可见文案走现有中英文目录：CLI `packages/cli/src/i18n/`，Dashboard `packages/dashboard-app/src/i18n/translations.ts`。
- 测试不得读写真实的 `~/.claude`、`~/.codex`、`~/Library/Application Support/tenon`；用临时目录与隔离 HOME（沿用现有 harness）。
- 不提交（Tenon 在交付步按 `next` 统一提交）；不运行 `tenon test trust`、不设置 `TENON_TEST_TRUST`、不运行 `tenon setup --from-source`。
- 子代理改文件只用 Edit / Write；shell 一次只做一件事；hook 套件用 `npm run test:hooks`；vitest 定向用 `npx vitest run <文件>`，dashboard 用 `npx vitest run --config packages/dashboard-app/vitest.config.ts <文件>`；被 hook 拦下就停下原样报告，不改写命令绕过。
- 生成物只用脚本重新生成：`npm run generate:default-workflow`（`packages/kernel/src/workflow/default-workflow.generated.ts`）、`npm run build`（`packages/*/dist`）。

## Review Focus

1. 冻结快照里带契约的在途任务（含没有快照、绑定 `legacy-full` 的更早任务）升级后 `status` / `check` / `transition` 的行为与升级前逐项一致——Task 4 的 legacy 夹具测试与 Task 6 的旧快照端到端测试钉住。
2. rebase 到新的 origin/main 之后，别人合并进来的文件不出现在本步产出与下一步的 `read-documents` 里——Task 1 的「HEAD 移动只算本任务提交」测试钉住。
3. 当前访问没有检查点、或项目不是 git 仓库时，转换不能被观察失败挡住，也不能产生伪造的输入——Task 2、Task 4 的 unavailable 测试钉住。
4. 读过输入后本步又修改了它，不应要求重读；输入文件在下一步被删除时不应卡死——Task 2 的读取回执测试钉住。
5. 已有的历史设计文档（`docs/superpowers/specs/` 下别的任务留下的）不能满足本任务的必须产出——Task 2 的 `produced` 测试与 Task 6 的端到端测试钉住。

---

## 文件结构

新增：

- `packages/kernel/src/workspace/step-checkpoint.ts` — git 检查点采集、比较、排除规则（基础设施）。
- `packages/kernel/src/workspace/step-checkpoint.test.ts`
- `packages/kernel/src/state/step-output-ledger.ts` — `.pipeline-step-outputs.json` 的结构、编解码、上限与原子写。
- `packages/kernel/src/state/step-output-ledger.test.ts`
- `packages/kernel/src/documents/step-outputs-model.ts` — 纯函数：文档判定、来源标注、交接输入、读取判定、路径模式。
- `packages/kernel/src/documents/step-outputs-model.test.ts`
- `packages/kernel/src/documents/step-outputs.ts` — 应用层深模块：`startStepVisit` / `recordStepExit` / `recordInputReads` / `readStepOutputs` / `requiredOutputSatisfied`。
- `packages/kernel/src/documents/step-outputs.test.ts`
- `tools/fixtures/legacy-default-workflow.yaml` — 升级前（`f474225f`）的 `templates/workflows/default.yaml` 原文，供各包测试构造带契约的旧快照任务。
- `packages/cli/src/commands/document-observed.ts` — 观察模式的 `document read` / `document status` 与旧命令拒绝（`document.ts` 已 399 行）。
- `packages/cli/src/observed-documents.integration.test.ts` — 新后端 / 轻量 / Spec Kit 端到端。
- `packages/server/src/stepIo.ts` — 两种模式统一的 `stepIo` 投影。

主要修改（详见各任务）：kernel `workflow/{types,ir,parse,serialize,compile-guards,guard-handlers,stepGuard,universal-guard-capabilities,validate,auto-gate,document-contract,effective-plan-build,effective-plan-types,effective-plan,governed-lifecycle-policy,step-exit-report,transition-application,step-graph-execution}.ts`、`state/workflow-run-repository.ts`、`state/default-openspec-scaffold.ts`、`compress/ledger-context-bundle*.ts`、`index.ts`；`templates/workflows/{default,design-system}.yaml`；CLI `commands/{statusStep,statusStepParts,statusStepNext,statusStepTestFlow,document,artifact,check,review,init}.ts`、`integration-harness*.ts`；server `workflowOrchestration.ts`、`workflows.ts`、`serverGetRoutes.ts`、`snapshotFingerprint.ts`、`test-support.ts`；dashboard `workspace/{stageIo.ts,StageIoPanel.tsx,TaskDetailPane.tsx,EndedDetail.tsx}`、`workflow/{StageEditorPane.tsx,leaveConditions.ts,lint.ts}`、`workbench/*`、`api/*`；`tools/oracle/*`、`tools/test-hooks.sh`；`skills/tenon/SKILL.md`；`docs/usage/**`、`docs/CONTRACT.md`。

删除：`packages/dashboard-app/src/workflow/IoTable.tsx`（+ test）、`packages/dashboard-app/src/workbench/documentContractEdits.ts`（+ test，若有）、`packages/kernel/src/design-system/precondition.ts`（+ test）、`packages/kernel/src/infrastructure/design-precondition.ts`。

---

### Task 1: kernel 检查点采集与比较

**Files:**
- Create: `packages/kernel/src/workspace/step-checkpoint.ts`
- Test: `packages/kernel/src/workspace/step-checkpoint.test.ts`

**Interfaces:**
- Consumes: 无（只依赖 git 子进程与 `node:fs`）。
- Produces（Task 2 使用，不从 kernel 公共出口导出）：

```ts
export interface StepCheckpoint {
  /** 访问开始时的 HEAD；仓库还没有提交时为 null。 */
  readonly head: string | null
  /** 相对 HEAD 有改动（含未跟踪、不含被忽略）的观察路径 → 当前内容 sha256，已删除为 null。 */
  readonly files: Readonly<Record<string, string | null>>
}
export type CheckpointCapture =
  | { readonly kind: 'captured'; readonly checkpoint: StepCheckpoint }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'truncated' }
export type FileChangeKind = 'added' | 'modified' | 'deleted'
export interface FileChange { readonly path: string; readonly change: FileChangeKind; readonly sha256: string | null }
export type CheckpointComparison =
  | { readonly kind: 'observed'; readonly changes: readonly FileChange[]; readonly current: StepCheckpoint }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'truncated' }
export interface CheckpointOptions {
  /** @internal 测试缝：替换 git 子进程。 */
  readonly runGit?: (args: readonly string[], cwd: string, input?: string) => Promise<string>
  /** 改动路径上限，默认 CHECKPOINT_PATH_LIMIT。 */
  readonly pathLimit?: number
}
export const CHECKPOINT_PATH_LIMIT = 20_000
export function isObservedPath(path: string, change: string): boolean
export function captureCheckpoint(root: string, change: string, options?: CheckpointOptions): Promise<CheckpointCapture>
export function compareCheckpoint(root: string, change: string, entry: StepCheckpoint, options?: CheckpointOptions): Promise<CheckpointComparison>
```

- [ ] **Step 1: 写失败测试**（临时 git 仓库，`mkdtemp` + `git init -q -b main` + `git -c user.email=t@t -c user.name=t commit`；每个用例自己建仓库，`afterEach` 删除）

```ts
import { describe, expect, test, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCheckpoint, compareCheckpoint, isObservedPath } from './step-checkpoint.js'

const roots: string[] = []
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'step-checkpoint-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), '# readme\n')
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  mkdirSync(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '# tasks\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function entry(root: string) {
  const capture = await captureCheckpoint(root, 'demo')
  if (capture.kind !== 'captured') throw new Error(`capture failed: ${capture.kind}`)
  return capture.checkpoint
}

describe('compareCheckpoint', () => {
  test('新增、修改、删除都记下，内容没变的不算', async () => {
    const root = repo()
    writeFileSync(join(root, 'scratch.md'), 'before\n') // 进入前就有的未跟踪改动
    const start = await entry(root)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'design.md'), '# design\n')
    writeFileSync(join(root, 'README.md'), '# readme v2\n')
    rmSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'))
    const result = await compareCheckpoint(root, 'demo', start)
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') return
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([
      ['README.md', 'modified'],
      ['docs/design.md', 'added'],
      ['openspec/changes/demo/tasks.md', 'deleted'],
    ])
    expect(result.changes.find((c) => c.path === 'openspec/changes/demo/tasks.md')?.sha256).toBeNull()
  })

  test('被忽略的、Tenon 状态、其他任务目录与任务目录下的点文件都不观察', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'ignored.txt'), 'x')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', '.pipeline-history.jsonl'), '{}\n')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', '.breadcrumb'), 'x')
    mkdirSync(join(root, 'openspec', 'changes', 'other'), { recursive: true })
    writeFileSync(join(root, 'openspec', 'changes', 'other', 'proposal.md'), '# other\n')
    mkdirSync(join(root, '.tenon'), { recursive: true })
    writeFileSync(join(root, '.tenon', 'x.json'), '{}')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', 'proposal.md'), '# mine\n')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => c.path)).toEqual(['openspec/changes/demo/proposal.md'])
  })

  test('访问内的本任务提交算产出', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'src.ts'), 'export const a = 1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'work')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['src.ts', 'added']])
  })

  test('rebase 到新上游：上游改动不算，本任务的未提交改动照算', async () => {
    const root = repo()
    git(root, 'checkout', '-q', '-b', 'task')
    // 模拟上游：main 上多一个改 README 的提交，并让 refs/remotes/origin/HEAD 指向它
    git(root, 'checkout', '-q', 'main')
    writeFileSync(join(root, 'README.md'), '# upstream\n')
    git(root, 'commit', '-q', '-am', 'upstream')
    git(root, 'update-ref', 'refs/remotes/origin/HEAD', 'main')
    git(root, 'checkout', '-q', 'task')
    const start = await entry(root)
    writeFileSync(join(root, 'mine.md'), '# mine\n')
    git(root, 'rebase', '-q', 'main')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => c.path)).toEqual(['mine.md'])
  })

  test('符号链接按链接目标取摘要', async () => {
    const root = repo()
    const start = await entry(root)
    symlinkSync('README.md', join(root, 'link.md'))
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['link.md', 'added']])
  })

  test('不是 git 仓库：unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'step-checkpoint-nogit-'))
    roots.push(root)
    expect((await captureCheckpoint(root, 'demo')).kind).toBe('unavailable')
  })

  test('改动超过上限：truncated', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    expect((await captureCheckpoint(root, 'demo', { pathLimit: 1 })).kind).toBe('truncated')
  })
})

describe('isObservedPath', () => {
  test.each([
    ['docs/x.md', true],
    ['CONTEXT.md', true],
    ['specs/001-demo/spec.md', true],
    ['openspec/changes/demo/specs/cap/spec.md', true],
    ['openspec/changes/demo/.openspec.yaml', false],
    ['openspec/changes/demo/.pipeline-run/current.json', false],
    ['openspec/changes/other/proposal.md', false],
    ['openspec/changes/archive/2026-01-01-x/proposal.md', false],
    ['openspec/.gitignore', false],
    ['.pipeline/workflows/default.yaml', false],
    ['.claude/agents/tenon-builder.md', false],
    ['.github/hooks/pre-commit', false],
    ['.github/workflows/ci.yml', true],
    ['packages/x/node_modules/y.js', false],
  ])('%s → %s', (path, expected) => {
    expect(isObservedPath(path, 'demo')).toBe(expected)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run packages/kernel/src/workspace/step-checkpoint.test.ts`
Expected: FAIL（`step-checkpoint.js` 不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 步骤检查点：一次步骤访问开始时的工作区状态，离开时与之比较得到本步产出（设计 §3）。
 * 只用 git 读：HEAD + 相对 HEAD 有改动的文件（含未跟踪、不含被忽略）。`--no-optional-locks` 不刷新索引，
 * 不与用户同时进行的 git 操作抢锁。读不出来一律 unavailable，由调用方降级，从不抛给转换。
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
export const CHECKPOINT_PATH_LIMIT = 20_000
const HIDDEN_ROOTS: ReadonlySet<string> = new Set(['.git', '.tenon', '.claude', '.agents', '.codex', '.superpowers', '.worktrees', '.turbo'])

// …（类型照上面 Interfaces 原样声明）

/** 不观察：Tenon 状态、宿主集成目录、依赖、其他任务目录、本任务目录下直接的点文件。 */
export function isObservedPath(path: string, change: string): boolean {
  const segments = path.split('/')
  if (segments.some((segment) => segment.startsWith('.pipeline') || segment === 'node_modules')) return false
  if (HIDDEN_ROOTS.has(segments[0] ?? '')) return false
  if (path.startsWith('.github/hooks/') || path === 'openspec/.gitignore') return false
  if (segments[0] === 'openspec' && segments[1] === 'changes') {
    if (segments[2] !== change) return false
    if (segments.length === 4 && (segments[3] ?? '').startsWith('.')) return false
  }
  return true
}

async function defaultRunGit(args: readonly string[], cwd: string, input?: string): Promise<string> {
  if (input === undefined) {
    return (await exec('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' })).stdout
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks).toString('latin1'))
      else reject(new Error(`git ${args[0] ?? ''} exited ${String(code)}`))
    })
    child.stdin.end(input)
  })
}

/** 文件当前内容摘要：普通文件流式 sha256；符号链接按链接目标；目录项（子模块）返回 undefined = 不观察。 */
async function workingSha(root: string, path: string): Promise<string | null | undefined> {
  let entry
  try { entry = await lstat(join(root, path)) } catch { return null }
  if (entry.isSymbolicLink()) return createHash('sha256').update(`symlink:${await readlink(join(root, path))}`).digest('hex')
  if (!entry.isFile()) return undefined
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(root, path))) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
```

采集：
- `git rev-parse --is-inside-work-tree` 失败 → `unavailable`。
- `git rev-parse --verify -q HEAD` → head（失败 = 还没有提交 → `null`）。
- `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all --no-renames` 按 `\0` 切分，每条前 3 个字符是 `XY `，其后是路径；过滤 `isObservedPath`；超过 `pathLimit` → `truncated`；逐个 `workingSha`（`undefined` 的跳过）。

比较：
- 当前 = 再采集一次（`unavailable` / `truncated` 原样返回）。
- 候选 = `Object.keys(entry.files) ∪ Object.keys(current.files) ∪ headMoved`。
- `headMoved`：`entry.head === current.head` 时为空；`entry.head === null` 时取 `git ls-tree -r --name-only -z <current.head>`；否则 `git log --format= --name-only -z --no-renames <entry.head>..<current.head> --not <上游引用…>`。上游引用：`git rev-parse --verify -q refs/remotes/origin/HEAD` 成功时加 `refs/remotes/origin/HEAD`；`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` 成功、且它去掉第一段（远端名）后不等于 `git rev-parse --abbrev-ref HEAD` 时加它。
- 「之前」：`Object.hasOwn(entry.files, p)` ? `entry.files[p]` : `blobSha(entry.head, p)`；「之后」同理用 `current`。`blobSha(rev, p)` 用一次 `git cat-file --batch`（stdin 每行 `<rev>:<path>`，输出逐条 `<oid> blob <size>\n<内容>\n` 或 `<name> missing`）批量取内容再 sha256；`rev === null` 时为 null。注意按 `latin1` 读回再以 `Buffer.from(…, 'latin1')` 取字节，保证二进制安全。
- 前后不同即为产出：之前 null → added；之后 null → deleted；否则 modified；`sha256` 取之后的值。结果按路径排序。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run packages/kernel/src/workspace/step-checkpoint.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 类型检查**

Run: `npx tsc -p packages/kernel/tsconfig.json --noEmit`
Expected: 无错误

---

### Task 2: kernel 产出账本、领域规则与深模块

**Files:**
- Create: `packages/kernel/src/state/step-output-ledger.ts`、`packages/kernel/src/state/step-output-ledger.test.ts`
- Create: `packages/kernel/src/documents/step-outputs-model.ts`、`packages/kernel/src/documents/step-outputs-model.test.ts`
- Create: `packages/kernel/src/documents/step-outputs.ts`、`packages/kernel/src/documents/step-outputs.test.ts`
- Modify: `packages/kernel/src/index.ts`（导出 Produces 里列出的公共接口与类型）

**Interfaces:**
- Consumes: Task 1 的 `captureCheckpoint`、`compareCheckpoint`、`StepCheckpoint`、`FileChange`；现有 `readCurrentRunRevision`（`state/run-revision-store.ts`）、`atomicReplaceFile`（`state/atomic-publish.ts`）、`readSkillInvocationEventsForApplication`（`skill-invocation/repository.ts`）。
- Produces（kernel 公共出口）：

```ts
// state/step-output-ledger.ts
export const STEP_OUTPUT_LEDGER_FILE = '.pipeline-step-outputs.json'
export type StepObservation = 'observed' | 'unavailable' | 'truncated'
export interface StepOutputRecord { readonly path: string; readonly change: 'added' | 'modified' | 'deleted'; readonly sha256: string | null; readonly skill: string | null }
export interface StepInputRead { readonly path: string; readonly sha256: string; readonly read_at: string }
export interface StepVisitRecord {
  readonly run_id: string
  readonly sequence: number
  readonly step: string
  readonly entered_at: string
  readonly checkpoint: StepCheckpoint | null
  readonly exit: { readonly event: string; readonly to: string; readonly at: string; readonly observation: StepObservation } | null
  readonly outputs: readonly StepOutputRecord[]
  readonly reads: readonly StepInputRead[]
}
export interface StepOutputLedger { readonly version: 1; readonly visits: readonly StepVisitRecord[] }
export class StepOutputLedgerError extends Error {}
export function readStepOutputLedger(changeDir: string): Promise<StepOutputLedger>   // 文件不存在 → { version: 1, visits: [] }；损坏 → StepOutputLedgerError
export function writeStepOutputLedger(changeDir: string, ledger: StepOutputLedger): Promise<void>
export function upsertVisit(ledger: StepOutputLedger, visit: StepVisitRecord): StepOutputLedger

// documents/step-outputs-model.ts（纯函数）
export function isDocumentPath(path: string): boolean
export interface SkillLoad { readonly skill: string; readonly at: string }
export function attributeSkill(mtimeMs: number, loads: readonly SkillLoad[]): string | null
export interface HandoffInput { readonly path: string; readonly sha256: string; readonly fromStep: string; readonly skill: string | null }
export function handoffInputs(ledger: StepOutputLedger, runId: string, sequence: number): readonly HandoffInput[]
export function isInputRead(input: HandoffInput, reads: readonly StepInputRead[], currentSha: string | null): boolean
export function validateOutputPattern(pattern: string): string | null
export function matchesOutputPattern(pattern: string, change: string, path: string): boolean

// documents/step-outputs.ts（应用层）
export interface StepOutputsContext { readonly root: string; readonly changeDir: string; readonly change: string }
export interface StepVisitRef { readonly runId: string; readonly sequence: number; readonly step: string }
export interface StepInputView extends HandoffInput { readonly read: boolean }
export interface StepIoView { readonly inputs: readonly StepInputView[]; readonly outputs: readonly StepOutputRecord[] }
export interface StepOutputsView {
  readonly visit: StepVisitRef | null
  readonly observation: StepObservation
  readonly inputs: readonly StepInputView[]
  readonly outputs: readonly StepOutputRecord[]
  /** 每个步骤最近一次访问的输入输出（当前步骤用实时比较）。 */
  readonly steps: Readonly<Record<string, StepIoView>>
  /** 本 run 里每个步骤产出过（新增或修改）且现在存在的路径。 */
  readonly produced: Readonly<Record<string, readonly string[]>>
}
export function stepOutputsContextFor(changeDir: string): StepOutputsContext   // root = changeDir 上三级，change = basename
export function startStepVisit(ctx: StepOutputsContext, visit: StepVisitRef, at: string): Promise<void>
export function recordStepExit(ctx: StepOutputsContext, exit: StepVisitRef & { readonly event: string; readonly to: string; readonly at: string }): Promise<void>
export function recordInputReads(ctx: StepOutputsContext, target: 'all' | string, at: string): Promise<readonly string[]>
export function readStepOutputs(ctx: StepOutputsContext, options: { readonly live: boolean }): Promise<StepOutputsView>
export function unreadInputs(view: StepOutputsView): readonly StepInputView[]
export function requiredOutputSatisfied(ctx: StepOutputsContext, view: StepOutputsView, step: string, pattern: string): Promise<boolean>
```

- [ ] **Step 1: 写领域规则的失败测试** `step-outputs-model.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { attributeSkill, handoffInputs, isDocumentPath, isInputRead, matchesOutputPattern, validateOutputPattern } from './step-outputs-model.js'
import type { StepOutputLedger } from '../state/step-output-ledger.js'

describe('attributeSkill', () => {
  const loads = [
    { skill: 'tenon', at: '2026-10-12T00:00:00Z' },
    { skill: 'brainstorming', at: '2026-10-12T00:01:00Z' },
    { skill: 'domain-modeling', at: '2026-10-12T00:05:00Z' },
  ]
  test('取修改时间之前最后加载的技能，编排技能 tenon 不算', () => {
    expect(attributeSkill(Date.parse('2026-10-12T00:03:00Z'), loads)).toBe('brainstorming')
    expect(attributeSkill(Date.parse('2026-10-12T00:06:00Z'), loads)).toBe('domain-modeling')
    expect(attributeSkill(Date.parse('2026-10-12T00:00:30Z'), loads)).toBeNull()
  })
  test('按秒比较：同一秒内写出的文件归给这一秒加载的技能', () => {
    expect(attributeSkill(Date.parse('2026-10-12T00:05:00.700Z'), loads)).toBe('domain-modeling')
  })
})

describe('isDocumentPath', () => {
  test.each([['a/b.md', true], ['x.MDX', true], ['y.markdown', true], ['z.ts', false], ['test-plan.yaml', false]])('%s', (p, v) => {
    expect(isDocumentPath(p)).toBe(v)
  })
})

const visit = (sequence: number, step: string, outputs: StepOutputLedger['visits'][number]['outputs']) => ({
  run_id: 'r', sequence, step, entered_at: '2026-10-12T00:00:00Z', checkpoint: null,
  exit: { event: 'e', to: 'next', at: '2026-10-12T00:00:00Z', observation: 'observed' as const }, outputs, reads: [],
})

describe('handoffInputs', () => {
  const ledger: StepOutputLedger = {
    version: 1,
    visits: [
      visit(0, 'open', [{ path: 'openspec/changes/c/proposal.md', change: 'added', sha256: 'p0', skill: 'openspec-propose' }]),
      visit(1, 'explore', [
        { path: 'docs/superpowers/specs/c-design.md', change: 'added', sha256: 'd1', skill: 'brainstorming' },
        { path: 'src/a.ts', change: 'modified', sha256: 'a1', skill: null },
        { path: 'old.md', change: 'deleted', sha256: null, skill: null },
      ]),
    ],
  }
  test('只取直接上游、只取文档、不取删除', () => {
    expect(handoffInputs(ledger, 'r', 2)).toEqual([
      { path: 'docs/superpowers/specs/c-design.md', sha256: 'd1', fromStep: 'explore', skill: 'brainstorming' },
    ])
  })
  test('第一次访问没有输入', () => {
    expect(handoffInputs(ledger, 'r', 0)).toEqual([])
  })
})

describe('isInputRead', () => {
  const input = { path: 'a.md', sha256: 'up', fromStep: 'explore', skill: null }
  test('回执等于上游摘要或当前摘要都算读过', () => {
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'up', read_at: 't' }], 'changed')).toBe(true)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'cur', read_at: 't' }], 'cur')).toBe(true)
    expect(isInputRead(input, [{ path: 'a.md', sha256: 'old', read_at: 't' }], 'cur')).toBe(false)
    expect(isInputRead(input, [], 'up')).toBe(false)
  })
})

describe('output patterns', () => {
  test('占位与通配', () => {
    expect(matchesOutputPattern('openspec/changes/{change}/proposal.md', 'c', 'openspec/changes/c/proposal.md')).toBe(true)
    expect(matchesOutputPattern('docs/superpowers/specs/*.md', 'c', 'docs/superpowers/specs/x-design.md')).toBe(true)
    expect(matchesOutputPattern('docs/superpowers/specs/*.md', 'c', 'docs/superpowers/specs/sub/x.md')).toBe(false)
    expect(matchesOutputPattern('openspec/changes/{change}/specs/*/spec.md', 'c', 'openspec/changes/c/specs/cap/spec.md')).toBe(true)
    expect(matchesOutputPattern('specs/**/spec.md', 'c', 'specs/001-a/spec.md')).toBe(true)
    expect(matchesOutputPattern('specs/**/spec.md', 'c', 'specs/spec.md')).toBe(true)
    expect(matchesOutputPattern('docs/r?.md', 'c', 'docs/r1.md')).toBe(true)
  })
  test('非法模式', () => {
    expect(validateOutputPattern('')).not.toBeNull()
    expect(validateOutputPattern('/etc/passwd')).not.toBeNull()
    expect(validateOutputPattern('docs/../x.md')).not.toBeNull()
    expect(validateOutputPattern('docs/{name}.md')).not.toBeNull()
    expect(validateOutputPattern('docs/{change}-design.md')).toBeNull()
  })
})
```

- [ ] **Step 2: 写账本与应用层的失败测试**

`step-output-ledger.test.ts`：文件不存在读出空账本；写后读回深等价；`upsertVisit` 按 `(run_id, sequence)` 覆盖；超过 512 次访问丢最旧的已离开访问（当前未离开的访问不丢）；单次访问 `outputs` 超过 2000 条写入被拒（由调用方先截断，见应用层）；损坏 JSON / 未知版本 / 字段类型不符读取抛 `StepOutputLedgerError`；写出文件超过 4 MiB 被拒。

`step-outputs.test.ts`（临时 git 仓库 + 用 kernel 现有 `createWorkflowRunRepository` / `createStateStore` 在 `openspec/changes/demo` 初始化一个任务，或直接写最小 `.pipeline-run/current.json`——以仓库里现有 kernel 测试的夹具写法为准；技能加载用 `appendSkillInvocationEvent` 写 `invocation-started` 事件，`step_visit` 对上当前访问）覆盖：
1. `startStepVisit` 后写文件、`recordStepExit` 记下产出与来源技能，并为 `sequence + 1` 开始下一次访问（带检查点、`step = to`）。
2. 同一访问 `recordStepExit` 调两次结果相同（幂等）。
3. 下一次访问的 `readStepOutputs({ live: true })`：`inputs` 只有上游文档，`read` 为 false；`recordInputReads('all')` 后为 true；`unreadInputs` 为空。
4. `recordInputReads('src/a.ts')`（不是输入）抛错，文案点名「不是本步的交接输入」。
5. 当前访问没有检查点：`observation = 'unavailable'`，`inputs` 为空，`recordStepExit` 不抛、离开记录的 `observation = 'unavailable'`。
6. `requiredOutputSatisfied`：本步产出过且文件存在 → true；`docs/superpowers/specs/` 下只有进入前就有的旧文件 → false；`observation = 'unavailable'` 时有匹配文件就 true（在非 git 临时目录验证）。
7. 账本里已有一次 spec 访问产出了计划，回到 spec 的第二次访问没改它 → `requiredOutputSatisfied('spec', 'docs/superpowers/plans/*.md')` 仍为 true。

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run packages/kernel/src/documents/step-outputs-model.test.ts packages/kernel/src/state/step-output-ledger.test.ts packages/kernel/src/documents/step-outputs.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现领域规则** `step-outputs-model.ts`

```ts
/**
 * 步骤产出的纯规则（设计 §4–§6）：文档判定、来源标注、直接上游交接、读取判定、必须产出的路径模式。
 * 不读盘、不起进程；读盘与 git 在 state/step-output-ledger.ts 与 workspace/step-checkpoint.ts。
 */
import type { StepInputRead, StepOutputLedger } from '../state/step-output-ledger.js'

const DOCUMENT_EXTENSION = /\.(?:md|mdx|markdown)$/iu
const ORCHESTRATOR_SKILLS: ReadonlySet<string> = new Set(['tenon', 'tenon:tenon'])

export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSION.test(path)
}

export interface SkillLoad { readonly skill: string; readonly at: string }

/** 修改时间之前（按秒）最后加载的技能；`recorded_at` 只到秒，所以两边都取整秒比较。 */
export function attributeSkill(mtimeMs: number, loads: readonly SkillLoad[]): string | null {
  const second = Math.floor(mtimeMs / 1000)
  let picked: { readonly skill: string; readonly at: number } | null = null
  for (const load of loads) {
    if (ORCHESTRATOR_SKILLS.has(load.skill)) continue
    const at = Math.floor(Date.parse(load.at) / 1000)
    if (!Number.isFinite(at) || at > second) continue
    if (picked === null || at >= picked.at) picked = { skill: load.skill, at }
  }
  return picked?.skill ?? null
}

export interface HandoffInput { readonly path: string; readonly sha256: string; readonly fromStep: string; readonly skill: string | null }

export function handoffInputs(ledger: StepOutputLedger, runId: string, sequence: number): readonly HandoffInput[] {
  const upstream = ledger.visits.find((visit) => visit.run_id === runId && visit.sequence === sequence - 1)
  if (upstream === undefined) return []
  return upstream.outputs
    .filter((output) => output.change !== 'deleted' && output.sha256 !== null && isDocumentPath(output.path))
    .map((output) => ({ path: output.path, sha256: output.sha256 ?? '', fromStep: upstream.step, skill: output.skill }))
}

export function isInputRead(input: HandoffInput, reads: readonly StepInputRead[], currentSha: string | null): boolean {
  return reads.some((read) => read.path === input.path && (read.sha256 === input.sha256 || read.sha256 === currentSha))
}

const PLACEHOLDER = /\{([^}]*)\}/gu

export function validateOutputPattern(pattern: string): string | null {
  if (pattern.trim() === '') return 'required-output 的 path 不能为空'
  if (pattern.startsWith('/') || /^[A-Za-z]:/u.test(pattern)) return `required-output 的 path 必须是项目相对路径：${pattern}`
  if (pattern.split('/').includes('..')) return `required-output 的 path 不能含 ..：${pattern}`
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    if (match[1] !== 'change') return `required-output 的 path 只支持 {change} 占位：${pattern}`
  }
  return null
}

function patternRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u')
}

export function matchesOutputPattern(pattern: string, change: string, path: string): boolean {
  return patternRegExp(pattern.replaceAll('{change}', change)).test(path)
}
```

- [ ] **Step 5: 实现账本** `step-output-ledger.ts`：严格解码（版本必须是 1、每个字段类型都校验，任何不符抛 `StepOutputLedgerError`）、`MAX_VISITS = 512`、`MAX_OUTPUTS = 2000`、`MAX_BYTES = 4 * 1024 * 1024`；写入用 `atomicReplaceFile(join(changeDir, STEP_OUTPUT_LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n')`；调用方负责持有任务锁（在文件头注释写明）。

- [ ] **Step 6: 实现应用层** `step-outputs.ts`

要点（每条都在测试里有对应用例）：
- 当前访问：`readCurrentRunRevision(changeDir)` 的 `state.runMetadata`（`runId`、`transitionSequence`）与 `state.fields.phase`；读不到 → `visit: null`、`observation: 'unavailable'`。
- `startStepVisit`：`captureCheckpoint`；`captured` → 记 `checkpoint`；其余记 `checkpoint: null`（之后离开时为 `unavailable` / `truncated`）。`upsertVisit` 后写回。
- `recordStepExit`：找到 `(runId, sequence)` 的访问记录（没有就新建一条 `checkpoint: null` 的记录）；有检查点就 `compareCheckpoint`，`observed` 时对每个新增 / 修改的产出 `lstat` 取 `mtimeMs` 并 `attributeSkill`（技能加载取 `readSkillInvocationEventsForApplication(changeDir)` 里 `type === 'invocation-started'` 且 `subject.step_visit` 等于本访问的事件，`payload.skill.id` + `recorded_at`；读失败当作没有加载记录）；产出多于 2000 条时截断并记 `truncated`；写离开记录（`checkpoint` 清空），再为 `{ runId, sequence: sequence + 1, step: to }` 开始下一次访问（检查点直接用比较结果的 `current`，比较不可用时重新 `captureCheckpoint`）。整个函数不向外抛 git 错误。
- `readStepOutputs`：`inputs` = `handoffInputs` 加上当前访问 `reads` 判定（当前摘要用文件现读的 sha256，文件已不存在的输入不列入）；`live: true` 且当前访问有检查点时实时 `compareCheckpoint` 得到 `outputs`；`steps` 取每个步骤最近一次访问（当前步骤用实时结果）；`produced[step]` = 该 run 里该步骤所有访问（含实时）的新增 / 修改产出中现在仍存在的路径（去重排序）。
- `recordInputReads`：`'all'` = 当前所有交接输入；单个路径必须是交接输入；对每个文件现读 sha256，追加 `{ path, sha256, read_at: at }`（同路径同摘要不重复）。
- `requiredOutputSatisfied`：`view.observation === 'observed'` → `produced[step]` 里有匹配；否则在 `root` 下按模式的静态前缀目录有界遍历（最多 10000 个条目），存在匹配的普通文件即 true。

- [ ] **Step 7: 导出**：在 `packages/kernel/src/index.ts` 导出 Produces 列出的应用层函数、`isDocumentPath`、`matchesOutputPattern`、`validateOutputPattern`、`STEP_OUTPUT_LEDGER_FILE` 与全部类型（不导出 `step-checkpoint.ts`）。

- [ ] **Step 8: 运行，确认通过**

Run: `npx vitest run packages/kernel/src/documents/step-outputs-model.test.ts packages/kernel/src/state/step-output-ledger.test.ts packages/kernel/src/documents/step-outputs.test.ts packages/kernel/src/workspace/step-checkpoint.test.ts`
Expected: PASS

Run: `npx tsc -p packages/kernel/tsconfig.json --noEmit`
Expected: 无错误

---

### Task 3: 工作流定义：`required-output` 守卫与旧键校验

**Files:**
- Modify: `packages/kernel/src/workflow/types.ts`（`WorkflowGuardConfig` 加 `{ type: 'required-output'; path: string } & WorkflowConditional`；`GUARD_DATA_KEYS` 加 `'required-output': ['path']`）
- Modify: `packages/kernel/src/workflow/ir.ts`（运行层 `CompiledGuardConfig` 同步；`GuardInput` 加能力 `requiredOutput?: (step: string, pattern: string) => Promise<boolean>`；`UniversalGuardCapabilities` 的 `Pick` 加 `'requiredOutput'`）
- Modify: `packages/kernel/src/workflow/parse.ts`（守卫扁平字段加 `path`：`GUARD_FLAT_FIELDS` 只对 `file-exists` 把 `path` 折成 `field`，`required-output` 保留 `path`；`buildGuard` 加 `case 'required-output'`，缺 `path` 报「guard 'required-output' 缺 path」。`parse.ts` 已 435 行，超出 450 就把守卫解析（`GUARD_FLAT_FIELDS`、`rejectExtraGuardFields`、`buildGuard`、`parseGuardEntry`、`parseGuardsBlock`）整体移到新文件 `workflow/parse-guards.ts`）
- Modify: `packages/kernel/src/workflow/serialize.ts`（守卫写出 `path:`；不再写 `inputs` / `outputs` / `artifacts` / `document_contract`）
- Modify: `packages/kernel/src/workflow/compile-guards.ts`（`case 'required-output'` 原样编译，带 `when`；调用 `validateOutputPattern`，非法抛编译错误并点名步骤）
- Modify: `packages/kernel/src/workflow/guard-handlers.ts`（`'required-output'` handler：缺能力 → `capabilityUnavailable('required-output', 'requiredOutput')`；能力抛错 → `evaluationError`；`currentStep` 缺失 → `current-step-unavailable`；不满足 → `{ kind: 'failed', guardType: 'required-output', actual: 'missing' }`）
- Modify: `packages/kernel/src/workflow/stepGuard.ts`（`buildStepGuardInput` 透传 `requiredOutput`；`renderGuardFailure` 加 `case 'required-output'`：`renderUniversalFailure(stepId, \`产出匹配 ${g.path} 的文件\`, d, () => '本任务里这一步还没有写出这样的文件')`）
- Modify: `packages/kernel/src/workflow/universal-guard-capabilities.ts`（`requiredOutput: async (step, pattern) => { const ctx = stepOutputsContextFor(changeDir); return requiredOutputSatisfied(ctx, await readStepOutputs(ctx, { live: true }), step, pattern) }`）
- Modify: `packages/kernel/src/workflow/step-graph-execution.ts`（第 54 行附近把 `requiredOutput: command.context.requiredOutput` 一并透传）
- Modify: `packages/kernel/src/workflow/validate.ts`（新定义校验拒绝：顶层或任一分支的 `documentContract`；任一步骤非空的 `inputs` / `outputs` / `artifacts`；任一守卫 `nonempty-output`。报错格式沿用该文件现有的「workflow 校验错误：…」并给替代：`document_contract 已删除：步骤的文档产出由 Tenon 在离开步骤时自动记录；需要门禁时写 { type: required-output, path: <路径> }`、`steps.<id>.outputs 已删除：字段门禁写 field-nonempty / field-equals，文档门禁写 required-output`、`nonempty-output 依赖已删除的 outputs：改用 field-nonempty 或 required-output`。同时删掉 `document-contract-validation.ts` 在新定义上的调用路径（契约已被拒绝，不再需要校验契约内容）；`validateDefaultWorkflowStructure` 保留「`spec: openspec` 分支要有 spec 与 ship 步」）
- Modify: `packages/kernel/src/workflow/auto-gate.ts`（`withAutoGateGuards` 不再从 `outputs` 推导守卫：新编译的 IR 里 `outputs` 恒为空，函数保持对旧 IR 的行为——旧冻结计划不重编译，不受影响；若函数因此只剩空分支，保留函数签名、内部直接返回 `steps`，并更新文件头注释说明 auto = 离开条件全部满足）
- Test: `packages/kernel/src/workflow/{parse,serialize,compile,validate,guard-handlers,universal-guards}.test.ts` 增改用例

**Interfaces:**
- Consumes: Task 2 的 `stepOutputsContextFor`、`readStepOutputs`、`requiredOutputSatisfied`、`validateOutputPattern`。
- Produces: 守卫类型 `required-output`（YAML `path` 键）；`GuardInput.requiredOutput`；校验错误文案（Task 6 的 CLI 测试按子串断言 `document_contract 已删除`、`outputs 已删除`、`nonempty-output 依赖已删除的 outputs`）。

- [ ] **Step 1: 写失败测试**

```ts
// parse.test.ts / serialize.test.ts
test('required-output round-trip', () => {
  const yaml = [
    'name: demo',
    'steps:',
    '  - id: write',
    '    label: 写',
    '    gate: null',
    '    skills: []',
    '    guards:',
    '      - type: required-output',
    '        path: docs/superpowers/specs/*.md',
    '    transitions: []',
  ].join('\n')
  const def = parseWorkflow(yaml)
  expect(def.steps[0]?.guards).toEqual([{ type: 'required-output', path: 'docs/superpowers/specs/*.md' }])
  expect(parseWorkflow(serializeWorkflow(def))).toEqual(def)
  expect(serializeWorkflow(def)).not.toMatch(/^\s*(inputs|outputs|artifacts):/mu)
})

// validate.test.ts
test.each([
  ['document_contract', 'document_contract 已删除'],
  ['outputs', 'outputs 已删除'],
  ['artifacts', 'artifacts 已删除'],
  ['nonempty-output', 'nonempty-output 依赖已删除的 outputs'],
])('新定义拒绝 %s', (key, message) => { /* 构造带该键的最小定义，expect(() => validateWorkflow(def)).toThrow(message) */ })
test('只有空列表的旧文件照常通过', () => { /* inputs: [] / outputs: [] / artifacts: [] → 通过 */ })
test('非法 required-output 模式在编译时被拒', () => { /* path: '../x.md' → 编译抛错，点名步骤 */ })

// guard-handlers.test.ts
test('required-output：能力缺失失败关闭、不满足报 missing、满足通过', async () => { /* 三个分支 */ })
```

（用例用这些文件里现有的构造 helper；`validate.test.ts` 现有的 document_contract 契约用例改为断言被拒，或移到 Task 4 的 legacy 夹具测试里。）

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run packages/kernel/src/workflow/parse.test.ts packages/kernel/src/workflow/serialize.test.ts packages/kernel/src/workflow/validate.test.ts packages/kernel/src/workflow/guard-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 按 Files 列表实现**

- [ ] **Step 4: 运行，确认通过**（同 Step 2 命令，加上 `packages/kernel/src/workflow/compile.test.ts packages/kernel/src/workflow/universal-guards.test.ts packages/kernel/src/workflow/stepGuard.test.ts`）

Expected: PASS；`npx tsc -p packages/kernel/tsconfig.json --noEmit` 无错误

---

### Task 4: kernel 计划分流、转换接入、模板改写与旧快照兼容

**Files:**
- Create: `tools/fixtures/legacy-default-workflow.yaml`（内容 = `git show f474225f:templates/workflows/default.yaml` 的原文，文件头加一行注释说明来源与用途）
- Modify: `templates/workflows/default.yaml`、`templates/workflows/design-system.yaml`（设计 §7 的逐条改写），然后 `npm run generate:default-workflow`
- Modify: `packages/kernel/src/workflow/document-contract.ts`（`documentGovernancePolicy()` 只在 `branch.documentContract !== undefined` 时返回策略）
- Modify: `packages/kernel/src/workflow/effective-plan-types.ts`、`effective-plan-build.ts`（`capabilities.documents = { governed: boolean; mode: 'contract' | 'observed'; profile?; policy? }`；`governed` = 选中分支的 `spec === 'openspec'`（工作流级视图没有分支时取顶层 `openspec`）；`mode` = 有 `documentPolicy` 为 `contract`）
- Modify: `packages/kernel/src/workflow/effective-plan.ts`（`resolveBoundEffectiveWorkflowPlan`：没有快照、绑定 `legacy-full`、而当前定义算出的计划没有策略时，用 `LEGACY_DOCUMENT_GOVERNANCE_POLICY`（`migrations/openspec-v1-document-policy.ts`）重建计划再走原有的 profile / 指纹核对）
- Modify: `packages/kernel/src/workflow/governed-lifecycle-policy.ts`（把 `file-exists plan`（spec>build）与 `file-exists verification_report`（verify>ship）挪进只在契约模式注入的表；其余照 `governed`。`effectiveLifecyclePolicy` / `governedLifecyclePolicy` 的第一个参数改成 `{ governed: boolean; contract: boolean }`，同步所有调用方：`step-graph-execution.ts`（两处：`readiness` 原来传 `policy !== undefined` 的改传 `{ governed, contract }`）、`packages/cli/src/commands/exitGuards.ts`、`packages/cli/src/commands/check.ts` 等——`grep -rn "effectiveLifecyclePolicy\|governedLifecyclePolicy" packages` 找全）
- Modify: `packages/kernel/src/workflow/step-exit-report.ts`（`mode === 'observed'` 时：`readStepOutputs(stepOutputsContextFor(changeDir), { live: false })` 的 `unreadInputs` 变成 `blocker('document', 'input-unread', \`本步输入 ${path}（${fromStep} 的产出）还没读；读完后执行 tenon document read <change> all\`, { subject: path })`，加进除放弃边以外所有出边（前进与回退）的阻断；`documents` 字段对观察模式返回 `undefined`）
- Modify: `packages/kernel/src/workflow/transition-application.ts`（观察模式：在 `documentPolicy` 那段之后、测试证据之前，`isAbandonEvent` 以外的事件先查未读输入，有就返回 `{ kind: 'document-evidence-failed', phase: from, blockers: [...] }`；在 `tx.commit` 之前调用 `recordStepExit(ctx, { runId: tx.run.id, sequence: tx.run.transitionSequence, step: from, event, to, at: deps.clock() })`，它内部吞掉 git 错误，不影响转换）
- Modify: `packages/kernel/src/state/workflow-run-repository.ts`、`state/default-openspec-scaffold.ts`（新任务：`mode === 'observed'` 且 `governed` 时只铺 `tasks.md`（给 `defaultOpenSpecScaffoldFiles` 加 `{ only: 'tasks' }` 选项或拆出 `defaultTasksScaffoldFile`），不写文档账本；`store.init` 发布之后、返回之前 `startStepVisit(stepOutputsContextFor(changeDir), { runId, sequence: 0, step: 第一步 }, clock())`）
- Modify: `packages/kernel/src/compress/ledger-context-bundle.ts`（及 `-contract.ts`）：观察模式用当前访问的交接输入作为包的输入（原因写「<上游步骤> 的产出」，摘要用记录的输出摘要或当前读取摘要），契约模式不变
- Delete: `packages/kernel/src/design-system/precondition.ts`、`precondition.test.ts`、`packages/kernel/src/infrastructure/design-precondition.ts`，删掉 `design-system/index.ts` 与 `src/index.ts` 里对应导出（CLI 侧接线在 Task 5 删）
- Test: `packages/kernel/src/workflow/{default-document-contract,default-yaml-rules,effective-plan,governed-lifecycle-policy,transition-application,step-exit-report-universal-guards,generate-default-workflow}.test.ts`、`packages/kernel/src/state/workflow-run-repository*.test.ts`、`packages/kernel/src/compress/ledger-context-bundle*.test.ts`

`default.yaml` 改写清单（设计 §7）：
- 删除 `pm` / `frontend` / `backend` 的 `document_contract` 块与所有步骤的 `inputs` / `outputs` / `artifacts`。
- `pm` / `frontend` / `backend` 的 `open` 步 `guards` 加 `- type: required-output` / `path: openspec/changes/{change}/proposal.md`。
- 三条重型分支的 `explore`：`- type: file-exists` / `field: design_doc` 换成 `- type: required-output` / `path: docs/superpowers/specs/*.md`。
- 三条重型分支的 `spec`：删 `file-exists plan`（含 `when: track_not_in: [pm]`）；加 `required-output openspec/changes/{change}/specs/*/spec.md`；`frontend` / `backend` 另加 `required-output docs/superpowers/plans/*.md`。
- 三条重型分支 `verify` 的 `verify-pass` 边：`file-exists verification_report` 换成 `required-output docs/superpowers/reports/{change}-verify.md`。
- `pm` 的 `ship` 保留 `file-exists prd_path`（交付值，不是文档契约）。
- `frontend` 的 `ship` 提示词删掉「登记 tenon document record "$TENON_CHANGE_NAME" design-md DESIGN.md --producer hue」这一句。
- `lite`：只删 `inputs` / `outputs`。
- 不改任何 `test_policy` / `tests` 键。

`design-system.yaml` 改写清单：删顶层 `openspec: true` 与 `document_contract`；删所有 `inputs` / `outputs` / `artifacts`；`direction` 步 `guards` 加 `required-output design/direction.md`，提示词删「登记：tenon artifact register …」一行；`generate` 步 `guards` 加 `required-output DESIGN.md`，提示词末句改为「运行 tenon design validate 直到通过。」。

**Interfaces:**
- Consumes: Task 2 全部应用层接口；Task 3 的守卫与校验。
- Produces:
  - `EffectiveWorkflowPlan['capabilities']['documents']['mode']: 'contract' | 'observed'`（CLI、server、dashboard 的唯一分流依据）。
  - 转换拒绝 `document-evidence-failed` 在观察模式的 blockers 文案以「本步输入 」开头。
  - `tools/fixtures/legacy-default-workflow.yaml`：Task 5/6/7 的测试用 `parseWorkflow(readFileSync(<repo>/tools/fixtures/legacy-default-workflow.yaml))` 构造带契约的旧快照（CLI 用 `integration-harness-legacy.ts` 的 `initLegacyChange`，`executionModel: 'step-graph'`、`openspecContract: true`）。

- [ ] **Step 1: 写失败测试**
  - `effective-plan.test.ts`：编译当前 `default`（backend）→ `capabilities.documents` 为 `{ governed: true, mode: 'observed' }` 且没有 `policy`；`lite` → `{ governed: false, mode: 'observed' }`；用 legacy 夹具编译出的定义冻结成快照再恢复 → `mode: 'contract'`、`policy.id === 'openspec-v1'`；没有快照、绑定 `legacy-full` 的运行按当前定义解析 → 得到 `LEGACY_DOCUMENT_GOVERNANCE_POLICY`，不抛「不可降级」。
  - `default-yaml-rules.test.ts`：四条分支的每一步都没有 `inputs` / `outputs` / `artifacts`，没有分支有 `documentContract`；上面清单里的每条 `required-output` 都在；`pm` / `frontend` / `backend` 的其余守卫与动作不变。
  - `default-document-contract.test.ts`：改成读 legacy 夹具，原断言保持（它测的是旧契约本身，供在途任务使用）。
  - `transition-application.test.ts`：观察模式任务（临时 git 仓库）在 spec 步有未读输入时 `spec-complete` 与 `requirements-changed` 都被拒且 blockers 以「本步输入」开头；放弃边不被拒；读完后转换成功且账本里出现 spec 访问的离开记录与下一次访问的检查点；`git` 不可用（非 git 目录）时转换照常成功。
  - `governed-lifecycle-policy.test.ts`：`{ governed: true, contract: false }` 时 spec>build 不注入 `file-exists plan`，verify>ship 不注入 `file-exists verification_report`，仍注入 `build-head-unchanged`、`spec-migration-applied`；`{ governed: true, contract: true }` 与改前一致。
  - `workflow-run-repository` 测试：新建 backend 任务只铺 `tasks.md`、没有 `.pipeline-documents.json`、有 `.pipeline-step-outputs.json` 且第一次访问 `sequence: 0`、`step: 'open'`；用 legacy 快照初始化的任务照旧铺三份并建账本。
- [ ] **Step 2: 运行，确认失败**：`npx vitest run packages/kernel/src/workflow packages/kernel/src/state packages/kernel/src/compress`（预期上面新增 / 改写的用例失败）
- [ ] **Step 3: 按 Files 与改写清单实现**；`npm run generate:default-workflow`
- [ ] **Step 4: 运行 kernel 全部测试**：`npx vitest run packages/kernel`，Expected: PASS
- [ ] **Step 5: 类型检查与生成物新鲜度**：`npx tsc -p packages/kernel/tsconfig.json --noEmit`；`npm run check:default-workflow-freshness`，Expected: 都通过

---

### Task 5: CLI 投影、命令与 next 动作

**Files:**
- Create: `packages/cli/src/commands/document-observed.ts`
- Modify: `packages/cli/src/commands/statusStepParts.ts`（`StepDocumentsView` 加 `mode` 与观察模式字段：`{ mode: 'observed'; observation; inputs: { path; from_step; skill; status: 'read' | 'unread' }[]; outputs: { path; change; skill }[]; required: { path; status: 'produced' | 'missing' }[]; reads: []; records: []; updates: [] }`；契约模式原三表加 `mode: 'contract'`；新增 `async function observedStepDocuments(deps, name, dir, plan, state, step)`：`readStepOutputs(…, { live: true })` + 当前步 `leaveGuards` 里的 `required-output` 逐条 `requiredOutputSatisfied`）
- Modify: `packages/cli/src/commands/statusStep.ts`（按 `plan.capabilities.documents.mode` 选择构造；`ownsDeltaSpec` / `ownsAppliedSpec` / `testConfigGaps` 的 planning 在观察模式按设计 §9 末条从 YAML 推出：`governed && 当前步离开条件里有 path 以 openspec/changes/{change}/specs/ 开头的 required-output`、`governed && 当前步离开条件含 spec-migration-applied`、`governed && step.test_policy?.plan === 'required'`；`finishedStatusStep` 的空 documents 加 `mode`）
- Modify: `packages/cli/src/commands/statusStepNext.ts`（观察模式的 `read-documents`：`documents` = 未读输入路径，`note` = 「读进上下文（不要丢弃输出）后再 tenon document read <change> all。这些是直接上游步骤的产出；本步可以修改它们，改动会记为本步产出。」，不带 `editable`；`skillDocumentActions` / `documentWriteActions` 在观察模式为空（契约为空自然如此，加断言测试））
- Modify: `packages/cli/src/commands/statusStepTestFlow.ts`（只改取报告路径：`documents.mode === 'observed'` 时用当前步前进边 `required-output` 里唯一不含 `*` / `?` 的模式渲染 `{change}` 后的路径；契约模式照旧取 `verification-report` 记录）
- Modify: `packages/cli/src/commands/document.ts`（`cmdDocumentRead` / `cmdDocumentStatus` 在观察模式委托 `document-observed.ts`；`cmdDocumentScaffold` / `cmdDocumentRecord` / `cmdDocumentRecordAll` / `cmdDocumentInit` / `cmdDocumentMigrateDelta` 在观察模式退出码 2，文案「本任务的产出由 Tenon 在离开步骤时自动记录，tenon document <子命令> 只服务升级前创建的任务」）
- Modify: `packages/cli/src/commands/artifact.ts`（冻结步骤没有声明该 artifact、且任务是观察模式时，报错改用同一句文案，退出码不变）
- Modify: `packages/cli/src/commands/check.ts`（观察模式把 `input-unread` 阻断渲染进 `documents` 段；`governedDocumentEvidence` 只在契约模式调用）
- Modify: `packages/cli/src/commands/review.ts`（verify-fail 就绪检查：观察模式不读 `verification_report` 字段，改为当前验证访问必须满足验证步前进边上的 `required-output`）
- Modify: `packages/cli/src/commands/init.ts` 与 `packages/cli/src/main.ts` / `deps.ts`（删 `creationPrecondition` 接线；`init` 不再为观察模式任务写文档语言文件——按 `workflow-run-repository` 的新行为核对）
- Modify: `packages/cli/src/i18n/*`（新增文案的中英文条目；按 `standard-messages.test.ts` 的规则补测试期望）
- Test: `packages/cli/src/commands/{statusStep,statusStepParts,statusStepTests,artifact}.test.ts` 增改用例；`packages/cli/src/i18n/*.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `readStepOutputs`、`recordInputReads`、`unreadInputs`、`requiredOutputSatisfied`、`stepOutputsContextFor`；Task 4 的 `capabilities.documents.mode`；`exitGuards.ts` 的 `leaveGuards`。
- Produces: `tenon status --json` 的 `step.documents` 观察模式形状（设计 §10）；`read-documents` 观察模式 payload；`document read` / `status` 观察模式输出（`status --json` 为 `{ change, workflow, mode: 'observed', observation, inputs, outputs, required }`，有未读输入或必须产出缺失时退出码 2）。

- [ ] **Step 1: 写失败的单元测试**（`statusStep.test.ts` / `statusStepParts.test.ts` 用现有的 step 构造 helper）：观察模式 `stepNextActions` 只发 `read-documents`（无 `editable`）且不发 `scaffold-document` / `record-document` / `register-field`；`ownsAppliedSpec` 在 ship 步为 true 从而发 `apply-spec`；`ownsDeltaSpec` 在 spec 步为 true 从而发 `validate-spec`；测试报告路径取 `docs/superpowers/reports/<change>-verify.md`。
- [ ] **Step 2: 运行，确认失败**：`npx vitest run packages/cli/src/commands/statusStep.test.ts packages/cli/src/commands/statusStepParts.test.ts packages/cli/src/commands/statusStepTests.test.ts`
- [ ] **Step 3: 按 Files 实现**；`document.ts` 保持 ≤ 400 行
- [ ] **Step 4: 运行，确认通过**（同 Step 2 + `npx vitest run packages/cli/src/commands/artifact.test.ts packages/cli/src/i18n`）
- [ ] **Step 5: 类型检查**：`npx tsc -b packages/kernel packages/automation packages/cli`，Expected: 无错误

---

### Task 6: CLI 测试迁移、端到端测试与工具

**Files:**
- Create: `packages/cli/src/observed-documents.integration.test.ts`
- Modify: `packages/cli/src/integration-harness-legacy.ts`（加 `initLegacyContractDefaultChange(deps, cwd, name, track, preset)`：`parseWorkflow(readFileSync(join(REPO_ROOT, 'tools/fixtures/legacy-default-workflow.yaml'), 'utf8'))`、`executionModel: 'step-graph'`、`openspecContract: true`；`integration-harness.ts` 暴露 `h.initLegacyContractDefault`）
- Modify: `packages/cli/src/integration-harness-documents.ts`（`defaultDocumentPolicy()` 改为读任务自己冻结计划的策略；`seedGovernedDocumentEvidence` / `recordBoundDocumentsForCurrentVisit` / `readGovernedDocumentsForCurrentVisit` 按 mode 分流：契约模式不变；观察模式只写文件（报告路径改为 `docs/superpowers/reports/${name}-verify.md`）并对当前访问执行 `recordInputReads(…, 'all')`——harness 项目默认不是 git 仓库，必须产出按存在判定）
- Modify: 依赖旧契约语义的测试（逐个判断）：
  - 测契约本身的（`document-record.integration.test.ts`、`skill-artifact-binding.integration.test.ts`、`step-run.integration.test.ts` 中 scaffold / record 部分、`spec-application-gate.integration.test.ts`、`artifact.integration.test.ts`、`check-transition-skill-agreement.integration.test.ts` 的文档部分、`next-action-runner.integration.test.ts`）改用 `h.initLegacyContractDefault`，断言不变，继续覆盖契约模式。
  - 只是借 default 任务走流程的（`transition-effects`、`advance`、`owner`、`handoff`、`review*`、`spec-apply`、`transition-afk`、`transition-concurrency`、`workflow-skill-orchestration`、`init-workflow`、`task-lifecycle`、`integration.test.ts` 等）依靠 mode 感知的 harness 继续用新 default；断言里写死 `document record` / `scaffold-document` / `.pipeline-documents.json` 的改成观察模式的等价断言。
  - `design.integration.test.ts`「立项前置条件」一组：改成断言「项目工作流声明 `document_contract` 时 `tenon init` 退出码 1 且报错含 `document_contract 已删除` 的替代说明」与「前端轨道没有 DESIGN.md 也能立项」。
- Modify: `tools/oracle/run.sh`（`bootstrap_new_document_contract`：观察模式任务只在任务目录与 `docs/oracle-document-contract/` 写当前步骤的必须产出文件并 `document read <change> all`，不再 `document init/record`）、`tools/oracle/fixtures/default-guard-errors.sh`（第 39 行期望改为观察模式立项步的必须产出文案「产出匹配 openspec/changes/t6-ge/proposal.md 的文件」）
- Modify: `tools/test-hooks.sh`（`strip_document_contract` 的调用方确认在新模板下仍成立；需要旧契约的夹具改读 legacy 夹具）
- Test: 上述文件

`observed-documents.integration.test.ts` 必须覆盖（每个用例在 harness 项目里 `git init` + 初次提交，技能加载走 `recordWorkflowPhaseSkill`）：
1. **新后端任务走完**：`init --track backend --preset full` → 每一步按 `status --json` 的 `next` 推进（写出该步的必须产出文件、加载声明的技能、按 harness 现有方式满足测试与评审者证据）直到 `finish`；断言：每次转换后账本里该步访问有 `exit` 且 `outputs` 含本步写出的文件、`skill` 为写入前加载的技能；`spec` 步的 `read-documents` 只列 explore 访问产出的文档；`read` 之前 `spec-complete` 被拒（退出码 1，含「本步输入」）；没写计划时 `spec-complete` 被拒（含「产出匹配 docs/superpowers/plans/*.md」）；全程 `next` 不出现 `scaffold-document` / `record-document` / `register-field`；`docs/superpowers/specs/` 里预先放一份旧文件，调研步不写新文件时被拒。
2. **新轻量任务走完**：`init --track lite` → open → build → verify → done，账本有三次离开记录，没有任何 `read-documents` 要求读代码文件。
3. **旧快照任务走完**：`h.initLegacyContractDefault('old', 'backend')` → 按 `next`（含 `scaffold-document` / `record-document` / `register-field` / 按 kind 的 `read-documents`）走到 `finish`；没有 `.pipeline-step-outputs.json` 被写出。
4. **Spec Kit 风格工作流**：`.pipeline/workflows/speckit.yaml`（平铺、`spec: none`，步骤 specify → plan → tasks → implement，必须产出 `specs/*/spec.md`、`specs/*/plan.md`、`specs/*/tasks.md`）→ specify 写 `specs/001-demo/spec.md` 离开后，plan 步 `read-documents` 正好列出它；plan 不写 `plan.md` 不能离开。
5. **观察模式旧命令被拒**：`document record` / `document scaffold` 退出码 2 且文案含「自动记录」。
6. **rebase 之后**：实现步里在 `main` 上加一个上游提交并把 `refs/remotes/origin/HEAD` 指过去，任务分支 rebase 后离开实现步，验证步的 `read-documents` 不含上游改的 Markdown。

- [ ] **Step 1: 写 `observed-documents.integration.test.ts`**，运行确认失败：`npx vitest run packages/cli/src/observed-documents.integration.test.ts`
- [ ] **Step 2: 改 harness 与迁移测试**
- [ ] **Step 3: 运行 CLI 全部测试**：`npx vitest run packages/cli`，Expected: PASS
- [ ] **Step 4: oracle 与 hook 套件**：`npm run oracle`；`npm run test:hooks`，Expected: 都通过（`test:hooks` 若依赖 `packages/cli/dist/tenon.mjs` 的新行为，先 `npm run bundle`）

---

### Task 7: server 与 Dashboard 显示真实产出

**Files:**
- Create: `packages/server/src/stepIo.ts`：

```ts
export interface StepIoFile {
  readonly path: string
  readonly change?: 'added' | 'modified' | 'deleted'
  readonly skill: string | null
  readonly fromStep?: string
  readonly read?: boolean
}
export interface StepIoEntry {
  readonly inputs: readonly StepIoFile[]
  readonly outputs: readonly StepIoFile[]
  readonly required: readonly { readonly path: string; readonly produced: boolean }[]
}
export type ChangeStepIo = Readonly<Record<string, StepIoEntry>>
export function changeStepIo(input: { root: string; changeDir: string; changeName: string; plan: EffectiveWorkflowPlan; state: PipelineState }): Promise<ChangeStepIo>
```

  观察模式：`readStepOutputs(ctx, { live: true })` 的 `steps` + 每步 `leaveGuards`（kernel 若无对应出口，就把 CLI `exitGuards.ts` 的 `leaveGuards` 逻辑下沉到 kernel 公共出口后两边共用）里的 `required-output` 与 `requiredOutputSatisfied`；契约模式：`.pipeline-documents.json` 记录按 `policy.outputsByStep` / `mutableByStep` 归属步骤进 `outputs`（`skill` = 记录的 `producer`），`policy.readsByStep` 的 kind 进对应步骤的 `inputs`（`read` = 当前访问有匹配回执），`required` 为空。不返回摘要、访问 id、正文或绝对路径。
- Modify: `packages/server/src/workflowOrchestration.ts`（`ChangeOrchestrationResponse.io` 换成 `stepIo: ChangeStepIo`；内部仍用 `planEffectiveIo(plan)` 喂 `buildOrchestration`（画布），不改画布）
- Modify: `packages/server/src/workflows.ts`、`packages/server/src/serverGetRoutes.ts`（工作流 API 不再返回 `effectiveIo` 与 `branches[].effectiveIo`）
- Modify: `packages/server/src/snapshotFingerprint.ts`（纳入 `.pipeline-step-outputs.json` 的指纹，与 `.pipeline-documents.json` 同法）
- Modify: `packages/server/src/test-support.ts`（`seedGovernedDocumentEvidence` 与 CLI harness 同样按 mode 分流；`makeProject` 里为前端轨道准备的 DESIGN.md 保留无妨）
- Modify (dashboard): `api/governanceTypes.ts`（删 `WbIoSlot` / `WbStepIo` / `WbEffectiveIo` / `WbDocumentContract` 中只服务 IO 表与契约编辑的类型；加 `WbStepIoFile` / `WbStepIoEntry`）、`api/workflowOrchestrationClient.ts`（解码 `stepIo`：缺省 → 空对象；形状不符 → 走现有错误路径）、`api/governanceDecoders.ts`、`workbench/workbenchApiDecoders.ts`、`api/governanceSchema.ts`、`api/governanceClient.ts`（去掉 `effectiveIo` / `documentContract` 读写）
- Modify (dashboard): `workspace/stageIo.ts`（重写为 `stageInputs(entry)` / `stageOutputs(entry)` / `gateProgress(gate, required, reviewSatisfied)` / `readableFiles` / `fileName`；删 `fallbackStepIo`、`ioRowOf` 的槽位逻辑与 `FILE_FIELDS`）、`workspace/StageIoPanel.tsx`（输入行：路径 · 来自 <步骤标签> · <技能 | 未知> · 已读 / 未读；输出行：路径 · 新增 / 修改 / 删除 · <技能 | 未知>；空态「本步没有输入」「本步还没有产出」）、`workspace/TaskDetailPane.tsx`（stage-io 块改读 `stepIo`；聚合视图没有 `stepIo` 时显示空态）、`workspace/EndedDetail.tsx`
- Modify (dashboard): `workflow/StageEditorPane.tsx`（只删 `stage-inputs` / `stage-outputs` 两段与相关 import、`inputAction` / `outputAction`；`GateSection` 的 `hasOutputs` 改为是否有 `required-output`）、`workflow/leaveConditions.ts`（`required-output` 显示为「必须产出 <path>」/ "Required output <path>"）、`workflow/lint.ts`（删 `draftEffectiveIo` 与契约 lint）、`workbench/useWorkflowEditor.ts`、`workbench/useStageMutations.ts`（删 `addDocumentOutput` / `removeDocumentSlot` / `setDocumentInputs`）、`workbench/workbenchDefinition.ts`、`workbench/draftChanges.ts`、`workbench/workbenchBranches.ts`、`workbench/workbenchClone.ts`、`workbench/workbenchTransitions.ts`、`workbench/useWorkflowCreate.ts`、`workbench/workflowEditorTypes.ts`、`workflow/WorkflowView.tsx`（去掉 `effectiveIo` / `documentContract` 引用）
- Delete (dashboard): `workflow/IoTable.tsx`、`workflow/IoTable.test.tsx`、`workbench/documentContractEdits.ts`（及其测试）
- Modify (dashboard): `i18n/translations.ts`（新增与删除的文案，中英文成对）
- Test: `packages/server/src/stepIo.test.ts`（新建）、`workflowOrchestration` / `workflows` / `server.test.ts` / `snapshotCache.test.ts` / `serverOrchestrationGraphRoutes.test.ts` 的相关断言；dashboard `workspace/{stageIo,TaskDetailPane,TaskDetailPaneTests,EndedTasks,WorkspaceEvidence}.test.tsx`、`workflow/{StageEditorPane,WorkflowView,GateSection,lint}.test.tsx`、`workbench/{workbenchDefinition,draftChanges}.test.tsx`、`api/{workflowOrchestrationClient,snapshotWorkflowDecoders,governanceSchema,serverIntegration}.test.tsx`、`model/ioSlots.test.tsx`（`ioSlots.ts` 若只剩 IO 表用途则连同测试删除）；e2e `e2e/dashboard/workspace-ended.spec.ts`（「input / output」断言改为真实产出行）、`e2e/dashboard/workflow.spec.ts`（门禁段出现「必须产出」，没有输入输出表）

**Interfaces:**
- Consumes: Task 2 的 `readStepOutputs`、`requiredOutputSatisfied`、`stepOutputsContextFor`；Task 4 的 `mode`。
- Produces: `GET /api/change/:name/orchestration` 响应的 `stepIo`（替代 `io`）。

- [ ] **Step 1: 写失败测试**：`stepIo.test.ts`（观察模式：临时 git 仓库里建任务、写文件、转换后 `stepIo.explore.outputs` 有该文件且 `skill` 正确，`stepIo.spec.inputs` 有它且 `read: false`；契约模式：legacy 夹具任务的 `stepIo.open.outputs` 含 proposal / design / tasks 记录）；dashboard `stageIo.test.tsx` / `TaskDetailPane.test.tsx` 新行为；`StageEditorPane.test.tsx` 断言没有 `io-inputs` / `io-outputs`。
- [ ] **Step 2: 运行，确认失败**：`npx vitest run packages/server/src/stepIo.test.ts`；`npx vitest run --config packages/dashboard-app/vitest.config.ts packages/dashboard-app/src/workspace/stageIo.test.tsx packages/dashboard-app/src/workflow/StageEditorPane.test.tsx`
- [ ] **Step 3: 实现 server 部分**，`npx vitest run packages/server` 通过
- [ ] **Step 4: 实现 dashboard 部分**，`npm run typecheck:web` 与 `npm run test:web` 通过
- [ ] **Step 5: 构建与 e2e**：`npm run build`；`npm run check:dashboard-dist-freshness`；`npm run test:e2e -- --project=chromium`，Expected: 全部通过（e2e 只写 `test-results/`、`playwright-report/`）

---

### Task 8: 技能与文档

**Files:**
- Modify: `skills/tenon/SKILL.md`：
  - 第 96–98 行 `tenon step run` 段：去掉「铺文档骨架、登记已经写好的文档」，改为「读取回执、生成测试计划初稿（升级前创建的任务还会铺文档骨架、登记已写好的文档）」。
  - 动作表 `read-documents` 行改为：「逐个读完 `documents` 列出的文件，把内容读进上下文（不得丢弃输出：`cat … >/dev/null` 这类读取不算读过），再 `tenon document read <c> all`。新任务里它们是直接上游步骤的产出：本步可以改，改动会记为本步产出；升级前创建的任务里它们是已登记的输入，只有 `editable` 里的 kind 本步可以改（改完照 `next` 重新登记），需求语义变了走 `requirements-changed` 回到规格步。tasks.md 只勾当前步骤标题下的复选框。」
  - `scaffold-document`、`record-document`、`register-field` 三行各在开头加「只出现在升级前创建的任务：」。
  - 「上游技能怎么用」一节改为：任务已存在时不要 `openspec new change`；技能按它自己的 SKILL.md 写文件，Tenon 在离开步骤时自动记录本步新增、修改、删除的文件与来源技能，不需要登记；步骤要求的「必须产出」（`required-output`）没写出时出口阻断会点名路径；升级前创建的任务照旧按 `step.documents` 的 `path` 写、经 `record-document` 登记；技能自带的提交 / 归档 / 推送等收尾只有 `next` 点名时才做；tasks 只勾当前步骤标题下的复选框。
  - 不改测试相关的动作行。
- Modify: `docs/usage/documents-skills-and-evidence.md` 与 `docs/usage/zh-CN/documents-skills-and-evidence.md`（整页按新机制重写：步骤产出、来源技能、直接上游交接、读取回执、必须产出、与规范无关、旧快照任务；保留 check-docs 要求的章节结构——先读 `tools/check-docs.mjs` 确认必需标题）
- Modify: `docs/usage/{custom-workflows-and-tracks,default-workflow,cli-reference,dashboard-and-local-api,routing-and-workflows,quickstart}.md` 与对应 `zh-CN/` 页：删 `document_contract` / `inputs` / `outputs` / `artifacts` 写法，换成 `required-output`；`gate: auto` 的新含义；`document` / `artifact` 命令的新口径；工作台与工作流页的显示变化
- Modify: `docs/usage/release-notes.md` 与 `zh-CN/release-notes.md` 的 Unreleased：新增「文档机制」段（Added / Retired and migration：旧键报错与替代、新任务不铺 proposal / design、`tenon document scaffold|record` 只服务旧任务、前端轨道不再要求立项前 DESIGN.md 就绪、`gate: auto` 不再由 outputs 推导、工作流 API 去掉 `effectiveIo`、编排接口 `io` 换成 `stepIo`）
- Modify: `docs/CONTRACT.md`（第 337–342 行附近的「文档治理」说明、第 470 行分支键闭集、第 592–602 行「必需技能 = 调用 + 本步绑定的产物」改为只适用于旧快照任务并补一条新机制说明）
- Test: `npm run check:docs`、`npm run check:document-templates`、`npm run check:repository-hygiene`、`bash tools/verify-skills.sh`

- [ ] **Step 1: 修改技能与文档**
- [ ] **Step 2: 运行**：`npm run check:docs`；`npm run check:document-templates`；`npm run check:repository-hygiene`；`bash tools/verify-skills.sh`，Expected: 全部通过

---

### Task 9: 收尾（主线执行）

- [ ] **Step 1:** `git fetch origin`，`git rebase origin/main`（工作区先由主线临时提交为 WIP 提交再 rebase，rebase 后用 `git reset --soft origin/main` 再 `git reset` 恢复为未暂存的改动，不用共享的 stash；冲突的生成物不手工合并，按 Step 2 重新生成）
- [ ] **Step 2:** `npm ci`（锁文件变了时）→ `npm run generate:default-workflow` → `npm run build`
- [ ] **Step 3:** 新鲜度：`npm run check:default-workflow-freshness`；`npm run check:dashboard-dist-freshness`；`npm run check:adapter-capabilities-freshness`
- [ ] **Step 4:** 会写文件的回归全部在这里跑完：`npm run test:e2e -- --project=chromium`；`npm run test:e2e -- --project=webkit`；`bash tools/test-bundle.sh`；`bash tools/verify-skills.sh`；`npm run oracle`；`npm run test:hooks`
- [ ] **Step 5:** 按 `next` 跑实现步测试（`tenon test run <change> --stage`），再写 `pre_verify_review_result`，最后 `build-complete`

---

## Self-Review

1. **Spec coverage**：观察与来源（step-output-lineage R1–R2）→ Task 1、2、4；交接与读取（R3）→ Task 2、4、5、6；必须产出（R4）→ Task 2、3、4；与规范无关（R5）→ Task 6 用例 4；CLI 投影（R6）→ Task 5、6；declarative-document-governance → Task 3、4；document-evidence-contract → Task 4、6；workflow-definition → Task 3；document-evidence-timeline 与 workflow-tracks → Task 7；effective-workflow-plan → Task 4；context-bundle-handoff → Task 4。
2. **Placeholder scan**：Task 7 的 `leaveGuards` 下沉写明了两种做法的判定条件（kernel 没有就下沉）；其余步骤都给了文件、接口与命令。
3. **Type consistency**：`StepOutputsContext` / `StepVisitRef` / `StepOutputsView` / `requiredOutputSatisfied(ctx, view, step, pattern)` 在 Task 2 定义，Task 3（守卫能力）、Task 4（转换、报告）、Task 5（CLI）、Task 7（server）按同一签名使用；`capabilities.documents.mode` 在 Task 4 定义。
4. **Review Focus**：五条分别在 Task 4（legacy 计划与无快照）、Task 1（rebase）、Task 2 / Task 4（unavailable）、Task 2（读后修改、输入被删）、Task 2 / Task 6（历史文件不算）有对应用例。
