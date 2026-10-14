---
change: consolidate-workflow-tracks
design-doc: docs/superpowers/specs/consolidate-workflow-tracks-design.md
locale: zh-CN
---

# 实施计划：工作流收敛为一个 default，轻重与领域都用轨道表达

> **给执行者：** 按 Tenon 实现步的 `next` 执行；本计划逐任务列出文件、接口、测试与验收命令。复选框 `- [ ]` 用于跟踪。

**目标：** 内建只留 `default`（轻量 / 产品 / 前端 / 后端）与 `design-system`；default 按 YAML 执行；轨道只作为工作流分支；路由读工作流、开发请求先评估；任务结束一律归档；工作台「已结束」。

**架构：** 新建任务一律走 step-graph，旧 phase-manifest 引擎收进一个目录只服务旧快照；轨道解析、改动风险分类、路由表生成、任务归档、已结束列表各是一个深模块（设计文档 §6a 的 M1–M8），调用方只经各自的小接口。

**技术栈：** TypeScript（Node 22，npm workspace）、Vitest、bash 薄 shim（hooks）、React 18 + Vite（Dashboard）、OpenSpec CLI 1.6.0。

**规格：** `docs/superpowers/specs/consolidate-workflow-tracks-design.md`（§1–§7）、`openspec/changes/consolidate-workflow-tracks/specs/`（`workflow-tracks` 与 5 个修改能力）、`CONTEXT.md` 术语。

## 全局约束

- 在 worktree `.claude/worktrees/consolidate-workflow-tracks` 内工作；**不得**运行 `tenon setup --from-source`（会改全机共用运行时）；不得读写真实的 `~/.claude`、`~/.codex`、`~/Library/Application Support/tenon`，测试用 `TENON_RUNTIME_HOME` 与隔离 HOME。
- **不在任务中途提交**；提交只由 Tenon 交付步的 `next` 点名执行。每个任务结束时只勾 `openspec/changes/consolidate-workflow-tracks/tasks.md` 中「实现」下对应的复选框。
- 新增或修改的生产代码不得使用显式 / 隐式 `any`、非空断言、无校验断言；外部输入先以 `unknown` 接收。
- 组件 / hook 超 400 行、页面超 600 行必须拆分（`.agent-rules/FRONTEND.md`）；新增用户可见文本走中英文 i18n。
- hooks 保持 bash 薄 shim、零解释器依赖，macOS/BSD 与 GNU 工具都可运行。
- 受管理文本不得出现仓库卫生检查禁止的外部项目身份（`npm run check:repository-hygiene`）。
- 规则去留严格按设计 §1b：删除 `build_mode` / `isolation` / `direct_override`、`branch_status`、statefile、立项字面路径检查、coverage 矩阵、重复的 `verify_result` 检查；保留并通用化 任务已勾选 / 未在 AFK 排队 / 依赖已结束；其余原样写进 YAML。
- 离开条件失败一律「一次列出全部、退出码 2」；`tenon advance` 只走唯一的前进边。
- 任务结果取值固定为 `finished` | `escalated` | `terminated`（界面：完结 / 已升级 / 已终止）；工作台分类名「已结束」。
- 路由缓存版本 `router.v6`；轻量轨道 id `lite`、label「轻量」。

## Review Focus

1. **升级后的在途旧任务**：快照记着 phase-manifest 的任务（含 standard / simple / chat / free）执行 `status`、`check`、`transition`、`advance` 时必须按旧规则判定，不能因模板或登记表已删而报错——测试加在 Task 1、Task 4。
2. **用户在全局存储覆盖过的 default.yaml**（仍含 chat / free 分支或没有 lite）：加载照常；`tenon assess` 找不到 lite 的阈值时报「该轨道没有改动风险阈值」而不是崩溃——测试加在 Task 8。
3. **某个工作流 YAML 写坏了**：路由生成跳过该工作流并输出一行警告，内建分支照常路由，不能整体失效——测试加在 Task 9。
4. **同名任务同一天归档两次**（终止后重建同名任务又完结）：归档目录不得覆盖，追加 `-2`、`-3` 后缀——测试加在 Task 10。
5. **终止时工作区还有别的改动**（同一检出另有在途任务）：`terminate` 只提交被移动的任务目录这一条路径——测试加在 Task 10。

## 测试辅助函数（首次用到它的任务负责新增）

| 函数 | 位置 | 签名与含义 | 首次用于 |
|---|---|---|---|
| `defaultWithLiteBranch()` | `packages/kernel/src/workflow/test-support.ts` | `(): WorkflowDef`，现 default 加一条五步 `lite` 分支（spec: none） | Task 2 |
| `branchWith(over)` | 同上 | `(over: Partial<TrackBranchDef>): WorkflowDef`，单分支工作流 `demo` | Task 2 |
| `anyContract()` | 同上 | `(): DocumentContractDef`，含一个 proposal 槽的最小文档契约 | Task 2 |
| `compiledDefault()` | 同上 | `(): WorkflowIR`，编译后的新 `templates/workflows/default.yaml` | Task 3 |
| `compiledDesignSystem()` | 同上 | `(): WorkflowIR`，编译后的 `design-system.yaml` | Task 3 |
| `defaultIr()` | 同上 | `compiledDefault` 的别名，供 effective-plan 测试使用 | Task 4 |
| `legacyV4Snapshot()` | `packages/kernel/src/workflow/effective-plan.test.ts` 内 | `(): WorkflowPlanSnapshotV4`，从现有 `policy-snapshot.test.ts` 的 phase-manifest 夹具复制 | Task 4 |
| `restorePlanFromSnapshot(s)` | 生产代码现有导出（`effective-plan.ts:216-287` 的恢复函数），测试按其真实名称导入 | `(s: WorkflowPlanSnapshot): EffectiveWorkflowPlan` | Task 4 |
| `requiredSkillsFor(plan, step)` | `packages/kernel/src/workflow/test-support.ts` | `(plan: EffectiveWorkflowPlan, step: string): string[]`，取 `plan` 中该步的 `requiredSkillIds` | Task 4 |
| `initRunInTemp(opts)` | `packages/kernel/src/state/test-support.ts`（新增） | `(opts: { workflow: string; track: string }): Promise<{ files: string[] }>`，在临时目录初始化任务并列出任务目录文件 | Task 4 |
| `makeInput(fields, caps?)` | `guard-handlers.test.ts` 内现有函数，加第二参数 | `(fields?: Partial<Record<FieldName, string \| string[]>>, caps?: Partial<GuardInput>): GuardInput` | Task 5 |
| `tmpDeps(date)` | `packages/kernel/src/workspace/archive-task.test.ts` 内 | `(date: string): ArchiveDeps`，临时仓库根、固定 `now`、内存锁、`runOpenspecArchive` 默认抛错 | Task 10 |
| `readResult(dir)` / `recreateChange(name)` / `simulateOpenspecMove(name)` | 同上 | 读归档目录的任务结果字段 / 在临时仓库重建同名任务目录 / 模拟 openspec 把目录移入 archive | Task 10 |
| `wf(id, content)` | `packages/kernel/src/routing/router-table.test.ts` 内 | `(id: string, content: string): { id: string; ir: WorkflowIR; builtin: boolean }`，以给定 YAML 文本编译出的工作流 | Task 9 |

---

## 文件结构

| 区域 | 新建 | 修改 | 删除 |
|---|---|---|---|
| kernel / 执行模型 | `workflow/legacy-phase-manifest/`（收纳旧引擎）、`workflow/execution-seam.ts` | `workflow/transition-application.ts`、`transition-readiness.ts`、`step-exit-report.ts`、`implicit-completion.ts`、`effective-plan.ts`、`compile.ts` | — |
| kernel / 轨道 | `workflow/resolve-track.ts` | `workflow/parse.ts`、`compile.ts`、`ir.ts`、`types.ts`、`serialize.ts`、`validate.ts`、`document-contract.ts`、`document-contract-validation.ts`、`state/workflow-run-repository.ts`、`state/state-init.ts` | `tracks/builtins.ts`、`tracks/registry.ts`、`tracks/parse.ts`、`tracks/validate.ts`、`tracks/router-projection.ts`、`workflow/branch-track.ts`、`branch-track-lookup.ts`、`builtin-workflows.ts` 的 simple |
| kernel / 离开条件 | — | `workflow/guard-handlers.ts`、`ir.ts`（GuardInput）、`parse-primitives.ts` | — |
| kernel / 改动风险 | `workspace/change-risk.ts` | `workspace/diff-risk.ts`（只抽出阈值判定） | — |
| kernel / 路由 | `routing/router-table.ts` | — | — |
| kernel / 归档 | `workspace/archive-task.ts` | `workspace/task-lifecycle.ts` | `workspace/task-archive.ts` |
| CLI | `commands/assess.ts` | `commands/init.ts`、`task.ts`、`task-lifecycle.ts`、`statusStep*.ts`、`advance*.ts`、`check.ts`、`verdictFieldGate.ts`、`field-values.ts`、`artifact.ts`、`effective-artifacts.ts`、`triage.ts`、`gen-router.ts`、`test-diff-risk.ts`、`program.ts` | `archivedGuard.ts` |
| hooks | — | `hooks/router.sh`、`hooks/router-gen.mjs`、`tools/test-hooks.sh` | — |
| server | `endedTasks.ts` | `snapshotProjectScan.ts`、`snapshotFingerprint.ts`、`serverTaskLifecycleRoutes.ts`、`workflows.ts` | `routerPreview.ts`、`config.ts` 的技能矩阵接口、`serverPostChangesRoutes.ts` 的 `POST /api/changes` |
| automation | — | `starters/wiring.ts`、`skills/mandatory-invocability.ts` | — |
| Dashboard | — | `workflow/TrackDialog.tsx`、`GateSection.tsx`、`workspace/TaskListPane.tsx`、`taskModel.ts`、`api/governanceClient.ts`、`i18n/translations.ts` | `workbench/mandatoryState.ts`、`postCreateChange`、`postRouterPreview`、未用文案 |
| 模板 / 工具 | — | `templates/workflows/default.yaml`、`templates/manifest.yaml`、`tools/generate-default-workflow.mjs` | `templates/workflows/standard.yaml`、`tools/check-default-skill-matrix.mjs` |
| 技能 / 文档 | — | `skills/tenon/SKILL.md`、`docs/usage/**`、`docs/CONTRACT.md`、`docs/usage/release-notes.md` | — |

---

## 任务

### Task 1：旧引擎收进单一接缝

**Files:**
- Create: `packages/kernel/src/workflow/execution-seam.ts`、`packages/kernel/src/workflow/legacy-phase-manifest/`（移入 `transition-plan-default.ts`、`phase-exit-context.ts` 及 `flow/` 下只服务 phase-manifest 的入口）
- Modify: `packages/kernel/src/workflow/transition-application.ts:216-220`、`transition-readiness.ts:118-146`、`step-exit-report.ts:155-169,222-226`、`implicit-completion.ts:52-55`
- Test: `packages/kernel/src/workflow/execution-seam.test.ts`

**Interfaces:**
- Produces: `selectExecution(plan: EffectiveWorkflowPlan): ExecutionAdapter`；`interface ExecutionAdapter { planTransition(input: TransitionInput): Promise<TransitionPlanResult>; readiness(input: ReadinessInput): Promise<ReadinessReport>; exitReport(input: ExitReportInput): Promise<StepExitReport> }`。`plan.capabilities.execution.model === 'phase-manifest'` 时返回旧适配器，否则返回 step-graph 适配器。上述 4 个调用点只调 `selectExecution(plan).*`，不再自己判断模型。

- [ ] **Step 1：写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { selectExecution } from './execution-seam.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { legacyDefaultWorkflow } from './test-support.js'

describe('execution seam', () => {
  it('旧快照的 phase-manifest 计划走旧适配器', () => {
    const plan = compileEffectiveWorkflowPlan('default', legacyDefaultWorkflow(), { track: 'backend', executionModel: 'phase-manifest' })
    expect(selectExecution(plan).kind).toBe('legacy-phase-manifest')
  })
  it('step-graph 计划走新适配器', () => {
    const plan = compileEffectiveWorkflowPlan('custom-x', legacyDefaultWorkflow(), { track: 'backend' })
    expect(selectExecution(plan).kind).toBe('step-graph')
  })
})
```

- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/execution-seam.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3：实现** — 新建 `execution-seam.ts`，`ExecutionAdapter` 带只读字段 `kind: 'legacy-phase-manifest' | 'step-graph'`；把 4 个调用点改为经接缝调用；把只服务 phase-manifest 的模块整体移入 `legacy-phase-manifest/`，更新 import（`DEFAULT_EVENT_POLICY` 与 `taskCount` 仍被 step-graph 引用的部分留在原处，Task 5 / Task 6 完成后再迁出）。
- [ ] **Step 4：运行接缝测试与全部旧行为测试** — `npx vitest run packages/kernel/src/workflow/execution-seam.test.ts packages/kernel/src/workflow/transition-application.test.ts packages/kernel/src/flow`，然后 `npx vitest run packages/cli/src/transition-effects.integration.test.ts packages/cli/src/check-transition-skill-agreement.integration.test.ts`，预期全部 PASS（本任务不改行为）。
- [ ] **Step 5：架构检查** — `npm run check:architecture`，预期 PASS；在 `tasks.md` 勾「旧 phase-manifest 引擎收进…」。

### Task 2：分支新键与平铺工作流

**Files:**
- Modify: `packages/kernel/src/workflow/types.ts:310-331`（`TrackBranchDef`）、`ir.ts:241-246`、`parse.ts:388-432`、`compile.ts:338-369`（`TRACK_BRANCH_KEYS`）、`serialize.ts:213-225`、`validate.ts:230-263`、`document-contract-validation.ts:91,179-215`
- Test: `packages/kernel/src/workflow/parse.test.ts`、`compile.test.ts`、`serialize.test.ts`、`validate.test.ts`

**Interfaces:**
- Produces:

```ts
export type TrackSpec = 'openspec' | 'none'
export interface TrackRoute { readonly keywords: readonly string[]; readonly exclude: readonly string[]; readonly priority: number; readonly fallback: boolean }
export interface TrackAutomation { readonly eligible: boolean; readonly enqueueAfterSpec: boolean }
export interface TrackBranchDef {
  readonly label?: string
  readonly documentContract?: DocumentContractDef
  readonly steps: readonly WorkflowStepDef[]
  readonly spec?: TrackSpec
  readonly route?: TrackRoute
  readonly automation?: TrackAutomation
}
```

YAML 键：`spec`、`route: { keywords, exclude, priority, fallback }`、`automation: { eligible, enqueue_after_spec }`。`TRACK_BRANCH_KEYS = {label, documentContract, steps, spec, route, automation}`。

- [ ] **Step 1：写失败的测试**

```ts
it('分支新键 round-trip', () => {
  const src = `name: demo\nopenspec: true\ntracks:\n  lite:\n    label: 轻量\n    spec: none\n    route:\n      keywords: [修复, typo]\n      exclude: [迁移]\n      priority: 500\n    automation:\n      eligible: false\n      enqueue_after_spec: false\n    steps:\n      - id: open\n        gate: null\n        transitions: []\n`
  const ir = compileWorkflow(parseWorkflow(src))
  expect(ir.tracks?.lite?.spec).toBe('none')
  expect(ir.tracks?.lite?.route).toEqual({ keywords: ['修复', 'typo'], exclude: ['迁移'], priority: 500, fallback: false })
  expect(compileWorkflow(parseWorkflow(serializeWorkflow(ir)))).toEqual(ir)
})
it('分支未知键报错并点名', () => {
  expect(() => parseWorkflow('name: d\ntracks:\n  x:\n    steps: []\n    colour: red\n')).toThrow(/colour/)
})
it('default 的非七步分支通过存储校验', () => {
  expect(validateWorkflowForStorage('default', defaultWithLiteBranch())).toEqual([])
})
it('spec: none 的分支不能声明 document_contract', () => {
  expect(validateWorkflowForStorage('demo', branchWith({ spec: 'none', documentContract: anyContract() })))
    .toContainEqual(expect.stringMatching(/spec: none/))
})
```

（`defaultWithLiteBranch()`、`branchWith()`、`anyContract()` 加在 `packages/kernel/src/workflow/test-support.ts`，分别构造「default 加一条五步 lite 分支」「单分支工作流」「最小文档契约」。）
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/parse.test.ts packages/kernel/src/workflow/compile.test.ts packages/kernel/src/workflow/serialize.test.ts packages/kernel/src/workflow/validate.test.ts`。
- [ ] **Step 3：实现** — 解析 / 编译 / 序列化三个新键；存储校验：只对 `spec: openspec` 的 default 分支要求 OpenSpec 文档与规格步骤（spec 步、ship 步存在），不再要求恰好七步；`spec: none` 与 `document_contract` 互斥；`document_contract 需要 openspec: true` 改为「需要分支的 spec 为 openspec」。平铺工作流在编译时生成唯一隐式分支，`implicit: true`。
- [ ] **Step 4：运行确认通过**（同 Step 2 命令），再跑 `npx vitest run packages/kernel/src/workflow` 全目录无回归。
- [ ] **Step 5：** 勾 `tasks.md` 中「轨道解析 `resolveTrack`…」的前半部分不勾（Task 3 完成后再勾）。

### Task 3：`resolveTrack` 与删除路由登记表

**Files:**
- Create: `packages/kernel/src/workflow/resolve-track.ts`、`resolve-track.test.ts`
- Modify: `packages/cli/src/commands/init.ts:147-155,190-238`、`packages/cli/src/commands/tracks.ts`（`tenon tracks`）、`packages/server/src/serverPostChangesRoutes.ts:157-163`、`packages/automation/src/starters/wiring.ts:191-203`、`packages/kernel/src/workflow/effective-workflow.ts:16-34`、`transition.ts`（读 track 的位置）
- Delete: `packages/kernel/src/tracks/builtins.ts`、`registry.ts`、`parse.ts`、`validate.ts`、`router-projection.ts`、`packages/kernel/src/workflow/branch-track.ts`、`branch-track-lookup.ts`；`builtin-workflows.ts` 里的 simple 定义
- Test: `resolve-track.test.ts`、`packages/cli/src/init-workflow.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TrackBranchDef`。
- Produces:

```ts
export interface TrackBranch {
  readonly id: string
  readonly label: string
  readonly steps: readonly WorkflowStepIR[]
  readonly spec: TrackSpec
  readonly route?: TrackRoute
  readonly automation: TrackAutomation
  readonly documentContract?: DocumentContractIR
  readonly implicit: boolean
}
export class UnknownTrackError extends Error { readonly available: readonly string[] }
export function resolveTrack(workflow: WorkflowIR, trackId?: string): TrackBranch
```

平铺工作流：`trackId` 省略或等于工作流名时返回隐式分支（`id` = 工作流名）。有分支却省略 `trackId` 时抛 `UnknownTrackError`，`available` 列出全部分支 id。
- [ ] **Step 1：写失败的测试**

```ts
it('按 id 解析分支并带出规范与自动化', () => {
  const b = resolveTrack(compiledDefault(), 'pm')
  expect(b.spec).toBe('openspec')
  expect(b.automation).toEqual({ eligible: true, enqueueAfterSpec: true })
})
it('平铺工作流省略轨道得到隐式分支', () => {
  const b = resolveTrack(compiledDesignSystem())
  expect(b.implicit).toBe(true)
  expect(b.id).toBe('design-system')
})
it('不存在的轨道列出可选项', () => {
  expect(() => resolveTrack(compiledDefault(), 'chat')).toThrow(UnknownTrackError)
  try { resolveTrack(compiledDefault(), 'chat') } catch (e) {
    expect((e as UnknownTrackError).available).toEqual(['lite', 'pm', 'frontend', 'backend'])
  }
})
```

CLI 集成测试（`init-workflow.integration.test.ts` 追加）：
  - `tenon init x --workflow standard` 退出码 1，stderr 含 `--workflow default --track lite`；
  - `tenon init x --workflow default --track free` 退出码 1，stderr 列出 `lite, pm, frontend, backend`；
  - `tenon init x --workflow design-system --preset full` 不带 `--track` 成功；
  - 项目含 `.pipeline/tracks.yaml` 时 `tenon init` 成功且 stderr 有一行迁移提示。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/resolve-track.test.ts packages/cli/src/init-workflow.integration.test.ts`（CLI 集成测试先 `npm run build -w @tenon/cli` 或照现有 harness 用源码）。
- [ ] **Step 3：实现** — 所有原 `requireTrackForRoot` / `assertWorkflowAllowed` 调用点改为 `loadWorkflow` + `resolveTrack`；`tenon tracks list` 输出「工作流:轨道  label  routable」；检测到 `.pipeline/tracks.yaml` 输出一行 `tracks.yaml 已不再读取：把轨道写进工作流分支（见 docs/usage/zh-CN/custom-workflows-and-tracks.md）`。删除登记表相关文件与测试。
- [ ] **Step 4：运行确认通过**，再跑 `npx vitest run packages/kernel packages/cli` 处理因删除登记表失败的测试（逐个改为基于工作流分支的夹具，不得删测试断言的意图）。
- [ ] **Step 5：** 勾 `tasks.md`「轨道解析 `resolveTrack`…」。

### Task 4：生效计划只认分支（M3）

**Files:**
- Modify: `packages/kernel/src/workflow/effective-plan.ts:53-155,165-215,293-328`、`document-contract.ts:46-100`、`effective-skill-resolver.ts:94-104,207-230`、`state/workflow-run-repository.ts:107-143`、`state/state-init.ts:43-80`、`templates/manifest.yaml`（删 `mandatory_skills`）
- Delete: `tools/check-default-skill-matrix.mjs`、`package.json` 的 `check:default-skill-matrix`
- Test: `effective-plan.test.ts`、`document-contract.test.ts`、`effective-skill-resolver.test.ts`、`policy-snapshot.test.ts`

**Interfaces:**
- Consumes: `resolveTrack`。
- Produces: `compileEffectiveWorkflowPlan(workflowId: string, def: WorkflowIR, opts: { track?: string; executionModel?: ExecutionModel }): EffectiveWorkflowPlan`；新计划 `executionModel` 恒为 `'step-graph'`，只有从快照恢复时沿用快照值。`documentGovernancePolicy(workflow, workflowId, track)` 改为读 `resolveTrack(...).spec`。`capabilities.automation = branch.automation`。
- [ ] **Step 1：写失败的测试**

```ts
it('default 的 lite 分支不受文档治理，后端分支受治理', () => {
  expect(compileEffectiveWorkflowPlan('default', defaultIr(), { track: 'lite' }).capabilities.documents.governed).toBe(false)
  expect(compileEffectiveWorkflowPlan('default', defaultIr(), { track: 'backend' }).capabilities.documents.governed).toBe(true)
})
it('新计划一律 step-graph', () => {
  expect(compileEffectiveWorkflowPlan('default', defaultIr(), { track: 'backend' }).capabilities.execution.model).toBe('step-graph')
})
it('旧快照恢复保留 phase-manifest 且指纹仍校验', () => {
  const restored = restorePlanFromSnapshot(legacyV4Snapshot())
  expect(restored.capabilities.execution.model).toBe('phase-manifest')
})
it('步骤技能只来自 YAML，不叠加矩阵', () => {
  const plan = compileEffectiveWorkflowPlan('default', defaultIr(), { track: 'backend' })
  expect(requiredSkillsFor(plan, 'explore')).toEqual(['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design'])
})
it('lite 任务初始化不铺 proposal、不写文档台账', async () => {
  const run = await initRunInTemp({ workflow: 'default', track: 'lite' })
  expect(run.files).not.toContain('proposal.md')
  expect(run.files).not.toContain('.pipeline-documents.json')
})
```

- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/effective-plan.test.ts packages/kernel/src/workflow/document-contract.test.ts packages/kernel/src/workflow/effective-skill-resolver.test.ts packages/kernel/src/workflow/policy-snapshot.test.ts packages/kernel/src/state`。
- [ ] **Step 3：实现** — 按 Interfaces 修改；`workflow-run-repository.ts:109` 与 `state-init.ts:49,64` 传入任务的轨道；删除 manifest 叠加分支与矩阵；`effective-plan-snapshot-compat.ts` 不改（旧快照照旧解码）。
- [ ] **Step 4：运行确认通过**，并 `npm run oracle`（预期：phase-manifest 旧快照相关 fixture 仍通过；default 新任务相关差异在 Task 6 处理，记录当前失败列表）。
- [ ] **Step 5：** 勾 `tasks.md`「轨道解析…」中删除矩阵叠加部分（与 Task 3 同一项，两者都完成后再勾）。

### Task 5：三个通用离开条件

**Files:**
- Modify: `packages/kernel/src/workflow/types.ts:76-111`（guard 定义）、`ir.ts:67-92`（`GuardInput`）、`guard-handlers.ts`、`parse-primitives.ts`、`compile-guards.ts`、`packages/cli/src/guardContext.ts`、`packages/server/src/transition.ts:196-202`
- Test: `guard-handlers.test.ts`

**Interfaces:**
- Produces（YAML `type`）：`tasks-through-step`（无参数）、`not-afk-queued`（无参数）、`dependencies-ended`（无参数）。`GuardInput` 新增可选能力：

```ts
tasksThroughStep?: (step: string) => Promise<{ readonly complete: boolean; readonly unchecked: readonly string[] }>
afkQueued?: () => Promise<boolean>
dependencyStates?: () => Promise<readonly { readonly name: string; readonly ended: boolean }[]>
```

能力缺失时三者都**失败**（fail-closed），文案点名缺什么能力；`afkQueued` 在 `TENON_AUTOMATION_RUNNER=1` 时由调用方注入恒 false。
- [ ] **Step 1：写失败的测试**

```ts
describe('通用离开条件', () => {
  it('tasks-through-step：有未勾任务时失败并列出原文', async () => {
    const r = await evaluateGuards([{ type: 'tasks-through-step' }], makeInput({}, { tasksThroughStep: async () => ({ complete: false, unchecked: ['写测试 (build)'] }), currentStep: 'build' }))
    expect(r.failures).toEqual([expect.objectContaining({ type: 'tasks-through-step', detail: ['写测试 (build)'] })])
  })
  it('not-afk-queued：排队中失败', async () => {
    const r = await evaluateGuards([{ type: 'not-afk-queued' }], makeInput({}, { afkQueued: async () => true }))
    expect(r.failures).toHaveLength(1)
  })
  it('dependencies-ended：依赖未结束时失败并点名', async () => {
    const r = await evaluateGuards([{ type: 'dependencies-ended' }], makeInput({}, { dependencyStates: async () => [{ name: 'a', ended: true }, { name: 'b', ended: false }] }))
    expect(r.failures[0]?.detail).toEqual(['b'])
  })
  it('能力缺失时三者都失败', async () => {
    const r = await evaluateGuards([{ type: 'tasks-through-step' }, { type: 'not-afk-queued' }, { type: 'dependencies-ended' }], makeInput())
    expect(r.failures).toHaveLength(3)
  })
  it('一次列出全部失败', async () => {
    const r = await evaluateGuards([{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }, { type: 'not-afk-queued' }], makeInput({ pre_verify_review_result: 'pending' }, { afkQueued: async () => true }))
    expect(r.failures).toHaveLength(2)
  })
})
```

（`makeInput` 现有签名只有字段参数，本任务给它加第二个可选参数 `caps: Partial<GuardInput>`。）
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/guard-handlers.test.ts`。
- [ ] **Step 3：实现** — 三个 handler；CLI `guardContext.ts` 与 server `transition.ts` 注入能力（任务勾选读 tasks.md + Todo 投影，复用 `taskPlanTasksThroughPhaseForChange` 的口径；AFK 读 `automation` 字段与 `TENON_AUTOMATION_RUNNER`；依赖读 `depends_on` 与归档目录 / 规范状态）。
- [ ] **Step 4：运行确认通过**，再跑 `npx vitest run packages/kernel/src/workflow packages/server/src/transition*.test.ts`。
- [ ] **Step 5：** 本任务不单独勾 tasks.md（并入 Task 6 那一项）。

### Task 6：default.yaml 重写、轻量轨道、删除旧模板

**Files:**
- Modify: `templates/workflows/default.yaml`（删 chat / free；pm / frontend / backend 写入 §1b 全部离开条件与动作；新增 lite）、`templates/manifest.yaml`、`tools/generate-default-workflow.mjs:223,340-343`、`packages/kernel/src/workflow/default-workflow.generated.ts`（生成）
- Delete: `templates/workflows/standard.yaml`；`packages/cli/src/standard-lane.integration.test.ts` 迁移为 `lite-track.integration.test.ts`
- Test: `packages/kernel/src/workflow/generate-default-workflow.test.ts`、`packages/cli/src/transition-effects.integration.test.ts`、`packages/cli/src/lite-track.integration.test.ts`、`tools/oracle/fixtures/default-guard-errors.sh`（改写或退役）

**Interfaces:**
- Consumes: Task 2 的分支键、Task 5 的通用离开条件。
- Produces：backend 分支 build 步的出边（pm / frontend 同构；pm 的 `plan` 检查用 `when: { track_not_in: [pm] }` 去掉）：

```yaml
      - id: build
        label: 实现
        gate: null
        skills: [{ id: test-driven-development }]
        outputs: [{ field: build_sha, type: string }]
        guards:
          - type: tasks-through-step
          - type: not-afk-queued
          - type: dependencies-ended
        transitions:
          - event: build-complete
            to: verify
            guards:
              - type: field-equals
                field: pre_verify_review_result
                value: pass
            actions:
              - type: freeze-build-sha
          - event: requirements-changed
            to: spec
            actions:
              - type: reset-pre-verify-review
```

lite 分支：

```yaml
  lite:
    label: 轻量
    spec: none
    route:
      keywords: [修复, 修正, 修改, 调整, 新增, 添加, 删除, 重构, 优化, 错别字, typo, 文案, 注释]
      exclude: [架构, 跨模块, 迁移, migration, schema, 数据库, 鉴权, 认证, 权限, auth, 依赖升级, 发布, 部署, 全栈, 前后端]
      priority: 500
    automation: { eligible: false, enqueue_after_spec: false }
    steps:   # open / build / verify / done / escalated，内容照搬 templates/workflows/standard.yaml 的同名步骤
```

pm `automation: { eligible: true, enqueue_after_spec: true }`；frontend / backend `automation: { eligible: true, enqueue_after_spec: false }`；backend `route.fallback: true`。

- [ ] **Step 1：写失败的测试**
  - `generate-default-workflow.test.ts`：断言分支集合为 `['lite','pm','frontend','backend']`，lite 五步、其余七步，chat / free 不存在。
  - `transition-effects.integration.test.ts` 追加（新建 default backend 任务）：
    - 未设 `pre_verify_review_result=pass` 且 tasks.md 有未勾项时 `tenon transition <c> build-complete` 退出码 2，stdout 同时含两条失败；
    - 不设 `build_mode` / `isolation` 也能 `build-complete`（其余条件满足时）；
    - `verify-pass` 不要求 `branch_status`；
    - `tenon advance` 在 build 步走 `build-complete`。
  - `lite-track.integration.test.ts`（由 standard-lane 测试迁移，断言不变）：≤ 25 次 tenon 调用、2 次用户回复；完结后目录在 `openspec/changes/archive/` 且提交消息为 `chore(tenon): finish <c>`；探针超限只给 `scope-expanded`。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workflow/generate-default-workflow.test.ts packages/cli/src/transition-effects.integration.test.ts packages/cli/src/lite-track.integration.test.ts`。
- [ ] **Step 3：实现** — 改写 `default.yaml`；`node tools/generate-default-workflow.mjs` 重新生成；删除 `standard.yaml` 与 manifest 的 `mandatory_skills`；`tools/oracle/fixtures/default-guard-errors.sh` 改为断言「一次列出全部失败、退出码 2」，旧版逐字对比部分删除并在 fixture 头注释写明原因（设计 §1b Q10）。
- [ ] **Step 4：运行确认通过**，再跑 `npm run check:default-workflow-freshness`、`npm run oracle`、`npx vitest run packages/cli`。
- [ ] **Step 5：** 勾 `tasks.md`「`default.yaml` 写入全部离开条件与动作…」。

### Task 7：CLI 配套通用化

**Files:**
- Modify: `packages/cli/src/commands/statusStep.ts:117-134`、`statusStepParts.ts:72,201-238`、`statusStepNext.ts:182-188,271`、`verdictFieldGate.ts:37-59`、`check.ts:117-182,294-324`、`advance.ts:85-152,229-269`、`advance-support.ts`、`field-values.ts:36-62`、`artifact.ts:69-130`、`effective-artifacts.ts:40-43`、`review.ts:92-156`、`transition-legal-events.ts`、`packages/cli/src/commands/triage.ts:174-184`
- Test: `packages/cli/src/status-step-projection.integration.test.ts`、`verdict-field-gate.integration.test.ts`、`commands/advance.test.ts`、`check-transition-skill-agreement.integration.test.ts`

**Interfaces:**
- Produces：字段投影与结论字段写入闸读取「步骤 guards ∪ 当前步所有出边 guards」；`advance`：当前步非回退出边只有一条且其离开条件满足时自动走它；`field-values.ts` 删除 `build_mode`、`isolation`、`direct_override`、`branch_status` 的推荐与可选值；artifact 产出策略统一 `effective-step-skills`；triage 以 `{ workflow: 'default', track: 'backend' }` 调用 `loadEffectiveWorkflowPlan`。
- [ ] **Step 1：写失败的测试**
  - status 投影：backend build 步的 `fields` 里出现 `pre_verify_review_result`（来自出边 guard），不再出现 `build_mode`、`isolation`。
  - advance：build 步两条出边（build-complete 前进、requirements-changed 回退），条件满足时 `tenon advance <c>` 执行 `build-complete`。
  - triage：自动修复任务的快照 `workflow-plan` 选中分支为 `backend`（读 `.pipeline-workflow-plan.json` 断言）。
- [ ] **Step 2：运行确认失败**（列出的测试文件）。
- [ ] **Step 3：实现**（按 Interfaces）。
- [ ] **Step 4：运行确认通过**，再 `npx vitest run packages/cli`。
- [ ] **Step 5：** 勾 `tasks.md`「CLI 配套…」。

### Task 8：`classifyChange` 与 `tenon assess`（M4）

**Files:**
- Create: `packages/kernel/src/workspace/change-risk.ts`、`change-risk.test.ts`、`packages/cli/src/commands/assess.ts`、`packages/cli/src/assess.integration.test.ts`
- Modify: `packages/cli/src/commands/test-diff-risk.ts`、`packages/cli/src/program.ts`、`packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `assessDiffRisk(changes: readonly PathChange[], protectedTestFiles: number): DiffRiskMetrics`（`packages/kernel/src/workspace/diff-risk.ts:49`）、test runner 的 `pass.metrics` 判定（`packages/cli/src/test-runner/classify.ts`，本任务把判定函数下沉到 kernel `change-risk.ts`，两处共用）。
- Produces:

```ts
export interface MetricThreshold { readonly name: string; readonly max?: number; readonly min?: number }
export interface ChangeRiskVerdict { readonly metrics: DiffRiskMetrics; readonly exceeded: boolean; readonly reasons: readonly string[] }
export function classifyChange(changes: readonly PathChange[], protectedTestFiles: number, thresholds: readonly MetricThreshold[]): ChangeRiskVerdict
export function riskThresholdsFor(branch: TrackBranch): readonly MetricThreshold[] | undefined   // 取该分支实现步 direction=diff-risk 测试的 pass.metrics
```

CLI：`tenon assess --files <p…> [--workflow default] [--track lite] [--json]`；路径必须是仓库内相对路径（拒绝绝对路径与 `..`），每个路径按「存在 = modified，不存在 = added」构造 `PathChange`；退出码：0 不超限、3 超限、1 用法 / 无阈值错误。
- [ ] **Step 1：写失败的测试**

```ts
it('与探针对同一组改动结论一致', () => {
  const changes = [{ path: 'packages/server/src/auth/login.ts', status: 'modified' as const }]
  const t = [{ name: 'files_changed', max: 8 }, { name: 'auth_files', max: 0 }]
  const v = classifyChange(changes, 0, t)
  expect(v.exceeded).toBe(true)
  expect(v.reasons).toEqual(['auth_files 1 > 0'])
  expect(v.metrics).toEqual(assessDiffRisk(changes, 0))
})
it('分支没有 diff-risk 测试时没有阈值', () => {
  expect(riskThresholdsFor(resolveTrack(compiledDefault(), 'backend'))).toBeUndefined()
})
```

`assess.integration.test.ts`：`--files ../etc/passwd` 退出码 1；全局存储覆盖了一个没有 lite 的 default 时，`tenon assess --files a.ts` 退出码 1，stderr 含「该轨道没有改动风险阈值」；三个普通文件退出码 0；`tenon test diff-risk` 对同一组已提交改动给出与 `assess` 相同的 `metrics`。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workspace/change-risk.test.ts packages/cli/src/assess.integration.test.ts`。
- [ ] **Step 3：实现**；`test-diff-risk.ts` 改用 `classifyChange`。
- [ ] **Step 4：运行确认通过**，再 `npx vitest run packages/kernel/src/workspace packages/cli/src/commands`。
- [ ] **Step 5：** 勾 `tasks.md`「`classifyChange` 与 `tenon assess`…」。

### Task 9：路由表从工作流生成（M5）

**Files:**
- Create: `packages/kernel/src/routing/router-table.ts`、`router-table.test.ts`
- Modify: `hooks/router-gen.mjs`、`hooks/router.sh:306,578-601,606-682,684-761,784-821,876-982`、`packages/cli/src/commands/gen-router.ts`、`tools/test-hooks.sh`
- Delete: `packages/server/src/routerPreview.ts`

**Interfaces:**
- Consumes: `loadWorkflow`（项目 → 全局 → 模板）、`resolveTrack`。
- Produces:

```ts
export interface RouterRow { readonly workflow: string; readonly track: string; readonly label: string; readonly priority: number; readonly keywords: readonly string[]; readonly exclude: readonly string[]; readonly fallback: boolean; readonly builtin: boolean }
export interface RouterTable { readonly schema: 'router.v6'; readonly sourceDigest: string; readonly rows: readonly RouterRow[]; readonly warnings: readonly string[] }
export function buildRouterTable(workflows: readonly { readonly id: string; readonly ir: WorkflowIR | Error; readonly builtin: boolean }[]): RouterTable
```

`sourceDigest` 为全部工作流文件内容的 SHA-256；`router.sh` 每次加载比较 digest（经 `router-gen` 计算），不同就重建。dispatch 新增字段 `assess: required` 与 `candidate: workflow=..;track=..`（多条）；`selection_required: true` 条件改为「最高分并列」或「最高分行 `builtin=false`」。
- [ ] **Step 1：写失败的测试**

```ts
it('只收带 route 的分支，坏工作流跳过并警告', () => {
  const t = buildRouterTable([{ id: 'default', ir: compiledDefault(), builtin: true }, { id: 'broken', ir: new Error('parse'), builtin: false }])
  expect(t.rows.map((r) => `${r.workflow}:${r.track}`)).toEqual(['default:lite', 'default:frontend', 'default:backend', 'default:pm'])
  expect(t.warnings).toEqual([expect.stringMatching(/broken/)])
})
it('工作流内容变化改变 digest', () => {
  expect(buildRouterTable([wf('a', 'x')]).sourceDigest).not.toBe(buildRouterTable([wf('a', 'y')]).sourceDigest)
})
```

`tools/test-hooks.sh` 新增 / 改写夹具：
  - 「修复登录页报错」→ dispatch `assess: required`，候选 `default/lite` 与 `default/frontend`；
  - 「给后端加数据库迁移」→ 直接 `track: backend`，无 assess；
  - 「用后端轨道 修一下」→ `track_basis: user-named`，无 assess；
  - 全局存储放一个带关键词的自定义工作流后，命中它的消息 `selection_required: true` 且候选含该工作流；
  - 只命中轻量排除词 → 兜底 `backend`；
  - 解释类消息不出 dispatch；
  - 修改工作流文件后下一条消息使用新数据；
  - 旧 `router.v5` 缓存被丢弃重建。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/routing/router-table.test.ts`、`npm run test:hooks`。
- [ ] **Step 3：实现**；删除 `routerPreview.ts` 及其路由注册与测试。
- [ ] **Step 4：运行确认通过**（同 Step 2），再 `bash tools/test-adapters.sh`。
- [ ] **Step 5：** 勾 `tasks.md`「路由表从工作流分支生成…」。

### Task 10：`tenon task finish` / `terminate` 与归档（M6）

**Files:**
- Create: `packages/kernel/src/workspace/archive-task.ts`、`archive-task.test.ts`
- Modify: `packages/kernel/src/workspace/task-lifecycle.ts`、`packages/cli/src/commands/task.ts:224-226`、`task-lifecycle.ts`、`statusStepFinish.ts:81-111`、`statusStepNext.ts:141`、`finishedLabel.ts`、`packages/server/src/serverTaskLifecycleRoutes.ts`
- Delete: `packages/kernel/src/workspace/task-archive.ts`、`packages/cli/src/archivedGuard.ts`（及引用）
- Test: `archive-task.test.ts`、`packages/cli/src/task-lifecycle.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export type TaskResult = 'finished' | 'escalated' | 'terminated'
export interface ArchivedTask { readonly change: string; readonly result: TaskResult; readonly archivedDir: string; readonly endedAt: string }
export interface ArchiveDeps { readonly repoRoot: string; readonly now: () => Date; readonly runOpenspecArchive: (change: string) => Promise<void>; readonly lock: <T>(fn: () => Promise<T>) => Promise<T> }
export function archiveTask(deps: ArchiveDeps, change: string, result: TaskResult, spec: TrackSpec): Promise<ArchivedTask>
```

顺序：锁内写任务结果字段 → `spec: openspec` 调 `runOpenspecArchive`（`openspec archive <c> --skip-specs --yes --json`）/ `spec: none` 原子 rename → 目标名冲突时追加 `-2`、`-3` → 写归档位置。CLI：`tenon task finish <c>`（只接受终态 done / escalated）、`tenon task terminate <c>`（任意非终态）；`terminate` 之后执行 `git add -A -- <archivedDir> <原目录>` 与 `git commit -m "chore(tenon): terminate <c>"`，只这两个 pathspec。`next.finish-change.command` 恒为 `tenon task finish <c>`；`tenon task archive / unarchive` 退出码 1 并提示 `terminate`。
- [ ] **Step 1：写失败的测试**

```ts
it('spec none 原子移动并记录结果', async () => {
  const r = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'finished', 'none')
  expect(r.archivedDir).toBe('openspec/changes/archive/2026-10-11-fix-a')
  expect(readResult(r.archivedDir)).toBe('finished')
})
it('同日同名追加后缀', async () => {
  await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'terminated', 'none')
  recreateChange('fix-a')
  expect((await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'finished', 'none')).archivedDir).toBe('openspec/changes/archive/2026-10-11-fix-a-2')
})
it('spec openspec 委托 openspec archive', async () => {
  const calls: string[] = []
  await archiveTask({ ...tmpDeps('2026-10-11'), runOpenspecArchive: async (c) => { calls.push(c); simulateOpenspecMove(c) } }, 'feat-b', 'finished', 'openspec')
  expect(calls).toEqual(['feat-b'])
})
```

`task-lifecycle.integration.test.ts`：工作区另有未提交文件 `other.txt` 时 `tenon task terminate x` 后 `git status --short` 仍含 `other.txt`，最新提交只含 `openspec/changes/...x` 路径；`tenon task archive x` 退出码 1 且提示 `terminate`。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/kernel/src/workspace/archive-task.test.ts packages/cli/src/task-lifecycle.integration.test.ts`。
- [ ] **Step 3：实现**；删除隐藏存储与 `archivedGuard`，以及 Dashboard 之外的引用。
- [ ] **Step 4：运行确认通过**，并在一个临时仓库副本上把 lite 任务完结后跑 `npm run check:openspec`（`lite-track.integration.test.ts` 内断言）。
- [ ] **Step 5：** 勾 `tasks.md`「`tenon task finish` / `terminate` 与归档模块…」中 CLI 部分。

### Task 11：已结束任务列表（M7）

**Files:**
- Create: `packages/server/src/endedTasks.ts`、`endedTasks.test.ts`
- Modify: `packages/server/src/snapshotProjectScan.ts:110-160`、`snapshotFingerprint.ts:175-190`、`types.ts`、`tools/bench/`（`bench-snapshot` 夹具）
- Test: `endedTasks.test.ts`、`snapshot.test.ts`、`npm run bench:snapshot`

**Interfaces:**
- Produces:

```ts
export interface EndedTaskSummary { readonly name: string; readonly workflow: string; readonly track: string; readonly result: TaskResult | 'unknown'; readonly endedAt: string; readonly prUrl?: string; readonly owner?: string; readonly archivedDir: string }
export function listEndedTasks(readRoot: string, cache: EndedTaskCache): Promise<readonly EndedTaskSummary[]>
```

只读各归档目录的 `.pipeline-run/current.json` 摘要字段；缓存键为「归档目录名 + 该目录 mtime」；旧归档没有结果字段时 `result: 'unknown'`，界面显示「完结」。快照 `ProjectSnapshot.ended` 承载列表；单任务详情接口接受归档目录。
- [ ] **Step 1：写失败的测试** — 60 个归档目录夹具：列表长度 60、按 `endedAt` 倒序；第二次调用不再读文件（spy `readFile` 次数为 0）；`.hidden` 与非目录项被忽略。
- [ ] **Step 2：运行确认失败** — `npx vitest run packages/server/src/endedTasks.test.ts`。
- [ ] **Step 3：实现**；`bench-snapshot` 夹具每项目加 60 个归档任务。
- [ ] **Step 4：运行确认通过**，并 `npm run bench:snapshot`，预期 p95 < 1.5 s。
- [ ] **Step 5：** 勾 `tasks.md`「`tenon task finish` / `terminate` 与归档模块；删除「隐藏」；服务端已结束任务列表」。

### Task 12：AFK 设置来自分支

**Files:**
- Modify: `packages/cli/src/commands/afk-workflow-authority.ts:37-40`、`packages/automation/src/lifecycle/spec-complete.ts:55-66`、`packages/automation/src/starters/wiring.ts:343-370`、`packages/automation/src/skills/mandatory-invocability.ts:107`、`templates/manifest.yaml`（`skill_action_authority` 改为不分 profile）
- Test: `packages/automation/src/lifecycle/spec-complete.test.ts`、`packages/cli/src/afk-workflow-authority.test.ts`

**Interfaces:**
- Consumes: `plan.capabilities.automation`（Task 4）。
- Produces：AFK 资格只读 `automation.eligible`；规格完成自动入队只读 `automation.enqueue_after_spec`。
- [ ] **Step 1：写失败的测试** — lite 任务 `tenon afk enqueue` 被拒并说明「该轨道不可进入 AFK」；pm 任务 `spec-complete` 后自动入队；backend 不自动入队。
- [ ] **Step 2：运行确认失败**（列出的测试）。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行确认通过**，再 `npx vitest run packages/automation`。
- [ ] **Step 5：** 勾 `tasks.md`「CLI 配套…」中 AFK 部分（与 Task 7 同项，两者都完成再勾）。

### Task 13：Dashboard

**Files:**
- Modify: `packages/dashboard-app/src/workflow/TrackDialog.tsx`、`GateSection.tsx`、`workspace/TaskListPane.tsx`、`workspace/taskModel.ts:244-260`、`workspace/TaskCard.tsx`、`model/workflowModel.ts:66-78,229,318`、`api/governanceClient.ts`、`api/governanceSchema.ts:99`、`i18n/translations.ts`
- Delete: `workbench/mandatoryState.ts`、`postCreateChange`、`postRouterPreview`、`workspace/taskCommands.ts` 的 `INIT_COMMAND`、`translations.ts:652-702` 未引用的 `workflow.test_*` 与 `track_chat` / `track_simple` / `track_free`
- Test: `workflow/TrackDialog.test.tsx`、`GateSection.test.tsx`、`workspace/TaskListPane.test.tsx`、`e2e/dashboard/workflow.spec.ts`、`e2e/dashboard/projects.spec.ts`

**Interfaces:**
- Consumes: 服务端快照的分支 `spec` / `route` / `automation`、`ProjectSnapshot.ended`（Task 11）、`POST /api/workflows/:name` 保存。
- Produces：轨道设置的「规范」单选（OpenSpec / 无）与「关键词」输入（逗号分隔，写入 `route.keywords`）；门禁段下只读离开条件列表（每条一行，文案见 i18n `workflow.leave_conditions.*`）；工作台分类 `TaskStatus = 'all' | 'needs-you' | 'running' | 'ended'`，卡片结果标记 完结 / 已升级 / 已终止；空态只保留 `/tenon` 提示词。
- [ ] **Step 1：写失败的测试**
  - TrackDialog：改规范为「无」并填关键词 `修复, typo` 后保存，提交体含 `spec: none` 与 `route.keywords: ['修复','typo']`；
  - GateSection：backend build 步渲染「实现前评审通过」「本阶段任务已勾选」「依赖任务已结束」三行且无编辑控件；
  - TaskListPane：分类按钮为 全部 / 需要你 / 进行中 / 已结束；`ended` 里一条 `terminated` 卡片显示「已终止」；不再渲染「已归档」开关。
- [ ] **Step 2：运行确认失败** — `npx vitest run --config packages/dashboard-app/vitest.config.ts packages/dashboard-app/src/workflow packages/dashboard-app/src/workspace`。
- [ ] **Step 3：实现**；派前端子代理时把用户的 UI 偏好原样写进提示（见记忆「工作流唯一真相 + 零废话」与「UI 偏好须写进派发说明」）：名称只显示一个、不换行、无 emoji、段头一行、无多余说明句。
- [ ] **Step 4：运行确认通过**，再 `npm run typecheck:web`、`npm run build` 后 `npm run test:e2e -- --project=chromium`（先排除已知干扰：webkit `english.spec.ts:200` 偶发、`dashboard-e2e` 与 chromium 套件共用服务时的评审批准用例），并按 `.agent-rules/COMMON.md` 的浏览器复用规则对工作流页与工作台各截一张图。
- [ ] **Step 5：** 勾 `tasks.md`「Dashboard：…」。

### Task 14：技能、文档与契约

**Files:**
- Modify: `skills/tenon/SKILL.md:55-70,120-121`（选通道改为「以 dispatch 为准；`assess: required` 时先 `tenon assess` 再由用户确认；手动 `/tenon` 同样先评估」；删除 standard / simple / build_mode / isolation / direct_override 相关句；`finish-change` 说明改为执行 `tenon task finish`）、`docs/usage/routing-and-workflows.md`、`docs/usage/zh-CN/routing-and-workflows.md`、`default-workflow.md`、`custom-workflows-and-tracks.md`、`cli-reference.md`、`dashboard-and-local-api.md`、`docs/CONTRACT.md`（task / assess / finish / terminate、退出码 2、`router.v6`）、`docs/usage/release-notes.md`（退役与迁移）
- Test: `npm run check:docs`、`npm run check:instruction-templates`、`npm run check:document-templates`、`bash tools/verify-skills.sh`

- [ ] **Step 1：** 先跑上述检查记录当前结果。
- [ ] **Step 2：** 修改技能与文档。
- [ ] **Step 3：** 再跑检查，预期全部 PASS；`grep -rn "standard 通道\|--track standard\|--track free\|--track chat\|task archive" skills docs/usage` 无结果（release-notes 的退役说明除外）。
- [ ] **Step 4：** `npm run check:repository-hygiene` PASS。
- [ ] **Step 5：** 勾 `tasks.md`「同步 `skills/tenon/SKILL.md`…」。

### Task 15：整体回归与产物

- [ ] **Step 1：** `npm run build`（含 CLI / server bundle 与 Dashboard dist），确认 `check:dashboard-dist-freshness` 与 bundle freshness 通过。
- [ ] **Step 2：** `npm test`、`npm run test:web`、`npm run test:hooks`、`bash tools/test-adapters.sh`、`bash tools/test-bundle.sh`、`npm run oracle`。
- [ ] **Step 3：** 本地跑齐 `check:*`：`check:openspec`、`check:default-workflow-freshness`、`check:repository-hygiene`、`check:docs`、`check:architecture`、`check:comments`、`check:dependencies`、`check:identity`、`check:agents`、`check:design-scale`、`check:document-templates`、`check:instruction-templates`、`check:adapter-capabilities-freshness`、`check:dashboard-dist-freshness`、`check:release-workflows`、`check:legacy-bridge`、`check:npx-package`。
- [ ] **Step 4：** 用一个升级前创建的 default 任务快照与一个 standard 任务快照（夹具），各执行一次 `status` / `check` / `transition`，确认按旧规则判定（Review Focus 1）。

## 验证

- 每个任务的 Step 4 命令全部通过；Task 15 的全量命令与 `check:*` 全部通过。
- 规格覆盖：`workflow-tracks` 的 12 条需求分别由 Task 2–13 覆盖（分支键 T2/T3、内建工作流 T3/T6、按 YAML 执行 T5/T6/T7、旧快照 T1/T4/T15、轻量轨道 T6、评估 T8/T9、路由 T9、结束归档 T10、已结束 T11/T13、工作流页 T13、AFK T12、技能来源 T4）；5 个修改能力的场景由 T2（workflow-definition）、T1/T4（effective-workflow-plan）、T4（declarative-document-governance）、T3/T9（simple-task-routing、normal-chat-routing）覆盖。
- 验证步的评审者（spec-consistency、backend-quality、security、architecture、code-size）按设计文档与本计划逐条核对。

## 回滚

- 全部改动在分支 `worktree-consolidate-workflow-tracks` 上，未合并前直接丢弃分支即可回滚。
- 合并后发现问题：在途任务不受影响（旧快照仍走旧引擎）；可整体 revert 本任务的合并提交恢复 standard / simple / 登记表；归档目录的移动是普通文件改动，随 revert 一并恢复。
- 用户侧已安装的运行时由 `tenon update --to-stable` 或回滚机制恢复，与本任务无额外耦合。
