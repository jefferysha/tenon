---
change: reduce-review-gate-friction
design-doc: docs/superpowers/specs/reduce-review-gate-friction-design.md
locale: zh-CN
---

# 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 轮次内回退边免人工确认、转换后清掉过期评审标记、gate 认只读组合命令并按标记种类给出准确提示。

**Architecture:** 豁免判定放在 CLI 与 Dashboard 共用的内核转换用例里，与轮次门共用一次轮次读取；`next` 投影同步。gate 的只读判定抽成 `hooks/lib/read-only-command.sh` 一个函数接口；提示在 `gate_check_marker` 里按 kind 分支。

**Tech Stack:** TypeScript（kernel / cli / server，vitest）、bash 3.2（hooks，`tools/test-hooks.sh`）、esbuild 打包产物入库。

**Spec:** `docs/superpowers/specs/reduce-review-gate-friction-design.md`；delta spec 在 `openspec/changes/reduce-review-gate-friction/specs/`（verify-round-limit、interaction-and-skill-provenance、document-evidence-contract、plugin-runtime）。

## Global Constraints

- 只在**受轮次约束的评审步**（`gate: review` 且有回退边）、**轮次未用完**、**回退边**（非前进、非放弃）上免回执；`roundsOf` 缺席时照旧要求回执。
- 前进边、放弃边、剩余阻断、测试豁免、`not-applicable` 的人工确认语义不变；`review request --event <回退>` 在轮次内仍被接受。
- 成功转换后删除**绑定本任务**的 `.pipeline-pending-review`；删除失败只警告，不回滚。
- 只读判定：段分隔只认引号外的 `|` `||` `&&` `;`；`cd` 段放行；剥离独立记号 `2>/dev/null` `1>/dev/null` `>/dev/null` `&>/dev/null` `2>&1`；长度上限 2048；引号外 `>` `<` 单个 `&` 反引号 换行 回车、单引号外的 `$(`、引号外的 `$'` 一律非只读；引号不闭合非只读。
- 收紧：`git status|diff|log|show` 带 `--output`、`rg` 带 `--pre`、`sed -n` 脚本不是 `^([0-9]+|\$)(,([0-9]+|\$))?p$` 或其后参数以 `-` 开头、`file` 带 `-C` / `--compile` → 非只读。
- 评审标记期间额外放行恰好 `tenon transition <change> <event>`（单段或前面带 `cd`，无元字符，change/event 只含 `[A-Za-z0-9_-]`）。
- hook 只用 bash 3.2 语法；不改 `pipeline_command_has_shell_metachars`。
- 改 `packages/*/src` 后必须 `npm run bundle` 与 `npm run build:server` 并提交 dist；改 Codex AGENTS 块文案后 `npm run generate:identity` 并 `npm run check:identity`。
- 改文件一律用 Edit / Write；shell 一次只做一件事；hook 套件用 `npm run test:hooks`；vitest 用 `npx vitest run <文件>`；被 hook 拦截就停下原样报告。

## Review Focus

- 前进评审待确认时用户要求回退：`tenon transition <c> verify-fail` 必须穿过 gate 并成功，且标记被删（Task 1 + Task 3 测试）。
- 升级前已 request 的回退边（pending）：`next` 直接 `transition`，转换成功、标记被删、canonical 回执清空（Task 1 集成测试）。
- 引号里的元字符：`grep "a|b" f`、`git status --short | grep -v "^M  \|^A  "` 放行；`cat "$(id)"`、`` cat `id` ``、`ls $'x'` 拦截（Task 3）。
- 2048 字符附近的长组合命令 3 秒内给出结论，不让 hook 超时溜过（Task 3）。
- 评审标记下自审批候选（dashboard token）嵌进只读组合仍被拦（Task 3）。

---

## 任务

- [ ] Task 1：内核轮次内回退免回执 + 转换后清评审标记（含两宿主告警渲染与相关测试）
- [ ] Task 2：`next` 对轮次内唯一回退边直接给 `transition`（含 CLI 单测 / 集成测试）
- [ ] Task 3：gate 只读组合判定库、评审期放行 `tenon transition`、按种类提示（含 hook 测试）
- [ ] Task 4：规则、契约与用户文档同步（含生成物）
- [ ] Task 5：合并后重打包 dist、全量测试

Task 1 → Task 2 串行（同一 worktree，同一执行者）；Task 3、Task 4 与之并行（各自独立 worktree）；Task 5 在全部合并后由主线做。

### Task 1：内核轮次内回退免回执 + 转换后清评审标记

**Files:**
- Modify: `packages/kernel/src/workflow/transition-rounds-gate.ts`
- Modify: `packages/kernel/src/workflow/transition-application.ts`（轮次门调用处约 :109-114；回执判定约 :187-208；提交后约 :218-250）
- Modify: `packages/kernel/src/workflow/transition-application-types.ts:95-107`（告警联合类型）
- Modify: `packages/cli/src/commands/transition.ts:222-236`（告警渲染）
- Modify: `packages/server/src/transitionResult.ts:37-47`（告警渲染）
- Test: `packages/kernel/src/workflow/transition-application.test.ts`（:877-909 一组）、`packages/kernel/src/workflow/transition-rounds-gate.test.ts`
- Test: `packages/cli/src/commands/review.integration.test.ts:123-128`
- Test: `packages/server/src/transition-concurrency.test.ts:175-215`
- Test（新增用例）: `packages/cli/src/transition-effects.integration.test.ts`

**Interfaces:**
- Produces: `backEdgeRounds(input) → Promise<BackEdgeRounds>`，`BackEdgeRounds = { kind: 'not-limited' } | { kind: 'within-budget' } | { kind: 'exhausted'; rejection: TransitionRejection }`（`transition-rounds-gate.ts` 导出）；告警新增 `{ kind: 'projection-write-failed'; projection: 'review-marker'; cause: unknown }`。
- Consumes: `clearReviewMarkerOfChange(root, change)`（`packages/kernel/src/state/markers.ts:133`）。

- [ ] **Step 1：写失败的内核测试。** 在 `transition-application.test.ts` 的轮次 describe 里，把用例「未用完：回退边越过这道门…」改写，并新增两条：

```ts
test('未用完：回退边不需要评审回执，直接转换；前进边仍要回执且不读轮次', async () => {
  const root = await freshRepoRoot()
  const roundsOf = vi.fn(async () => ({ current: 1, max: 2, source: 'workflow' as const }))
  const deps = makeDeps({ roundsOf, reviewGateBinding: async () => false })
  const dir = await atVerify(deps, root)
  const app = createTransitionApplication(deps)
  expect(await app.execute(commandOf(root, dir, 'verify-pass'))).toMatchObject({ kind: 'review-approval-required', event: 'verify-pass' })
  expect(roundsOf).toHaveBeenCalledTimes(0)
  expect(await app.execute(commandOf(root, dir, 'verify-fail'))).toMatchObject({ kind: 'applied', from: 'verify', to: 'build' })
  expect(roundsOf).toHaveBeenCalledTimes(1)
})

test('成功转换删除绑定本任务的评审标记，不碰其他任务的标记', async () => {
  const roundsOf = vi.fn(async () => ({ current: 1, max: 2, source: 'workflow' as const }))
  const markerOf = (change: string) =>
    `pipeline-review-v2\nphase=verify\nchange=${change}\nevent=verify-pass\nrequested_at=2026-10-13T00:00:00Z\n`

  const otherRoot = await freshRepoRoot()
  const otherDeps = makeDeps({ roundsOf, reviewGateBinding: async () => false })
  const otherDir = await atVerify(otherDeps, otherRoot)
  await writeFile(join(otherRoot, '.pipeline-pending-review'), markerOf('other'))
  expect(await createTransitionApplication(otherDeps).execute(commandOf(otherRoot, otherDir, 'verify-fail')))
    .toMatchObject({ kind: 'applied' })
  expect(existsSync(join(otherRoot, '.pipeline-pending-review'))).toBe(true)

  const root = await freshRepoRoot()
  const deps = makeDeps({ roundsOf, reviewGateBinding: async () => false })
  const dir = await atVerify(deps, root)
  await writeFile(join(root, '.pipeline-pending-review'), markerOf('demo'))
  expect(await createTransitionApplication(deps).execute(commandOf(root, dir, 'verify-fail')))
    .toMatchObject({ kind: 'applied' })
  expect(existsSync(join(root, '.pipeline-pending-review'))).toBe(false)
})
```

  标记格式与 `packages/kernel/src/state/markers.ts` 的 `formatReviewMarker` 一致。`writeFile`（`node:fs/promises`）、`existsSync`（`node:fs`）、`join`（`node:path`）若本文件未导入则补导入。保留「用完后回退边被拒」「宿主没接线 roundsOf」两条原用例（后者期望仍是 `review-approval-required`）。

  在 `transition-rounds-gate.test.ts` 为 `backEdgeRounds` 补四个分支：前进边 → `not-limited` 且不调 `roundsOf`；放弃边 `scope-expanded` → `not-limited`；`roundsOf` 缺席 → `not-limited`；`{current:1,max:2}` → `within-budget`；`{current:2,max:2}` → `exhausted` 且 `rejection` 与原 `rejectOnRoundsExhausted` 的返回一致。原 `rejectOnRoundsExhausted` 的用例改为断言 `backEdgeRounds` 的 `exhausted.rejection`。

- [ ] **Step 2：运行确认失败。** `npx vitest run packages/kernel/src/workflow/transition-application.test.ts packages/kernel/src/workflow/transition-rounds-gate.test.ts`，期望新用例 FAIL（`backEdgeRounds` 未定义 / 回退仍被 `review-approval-required` 拒绝）。

- [ ] **Step 3：实现 `backEdgeRounds`。** 用下面的实现替换 `transition-rounds-gate.ts` 的 `rejectOnRoundsExhausted`（文件头注释同步改成三态说明；仓库内其他调用方用 Grep 找到一并改）：

```ts
export type BackEdgeRounds =
  | { readonly kind: 'not-limited' }
  | { readonly kind: 'within-budget' }
  | { readonly kind: 'exhausted'; readonly rejection: TransitionRejection }

/** 受约束步骤上回退边的轮次结论：不受约束（含宿主没接线）/ 轮次内（可免评审回执）/ 已用完（拒绝）。 */
export async function backEdgeRounds(input: {
  readonly deps: Pick<TransitionApplicationDeps, 'roundsOf'>
  readonly changeDir: string
  readonly workflowName: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly from: string
  readonly to: string
  readonly event: string
}): Promise<BackEdgeRounds> {
  const { deps, plan, from, event } = input
  if (deps.roundsOf === undefined || isAbandonEvent(event)) return { kind: 'not-limited' }
  if (isForwardExit(plan, from, input.to, event) || !isRoundsLimited(plan, from)) return { kind: 'not-limited' }
  const rounds = await deps.roundsOf({ changeDir: input.changeDir, plan, state: input.state, stepId: from })
  if (rounds === null) return { kind: 'not-limited' }
  if (!roundsExhausted(rounds)) return { kind: 'within-budget' }
  return {
    kind: 'exhausted',
    rejection: {
      kind: 'rounds-exhausted', workflowName: input.workflowName, stepId: from, event,
      current: rounds.current, max: rounds.max, source: rounds.source,
    },
  }
}
```

- [ ] **Step 4：接进转换用例。** `transition-application.ts`：

```ts
// 验证轮次：用完后受约束步骤的回退边被拒；轮次内的回退边不需要评审回执（`next` 只是投影）。
const backEdge = await backEdgeRounds({
  deps, changeDir: command.changeDir, workflowName, plan: effectivePlan, state: tx.state,
  from: prepared.from, to: prepared.to, event: command.event,
})
if (backEdge.kind === 'exhausted') return backEdge.rejection
const requiresReviewApproval = prepared.requiresReviewApproval && backEdge.kind !== 'within-budget'
```

  把后面两处 `prepared.requiresReviewApproval` 换成 `requiresReviewApproval`，并更新 :187-190 的注释（加一句「轮次内的回退边不消费回执」）。在 interaction 效果记录的 `try/catch` 之后、breadcrumb 之前加入：

```ts
// 任何成功转换都清空了本任务的评审回执，它在项目根上的待处理标记随之过期：删掉，免得 gate 继续拦、放行语也解不开。
try {
  await clearReviewMarkerOfChange(command.root, command.changeName)
} catch (error) {
  warnings.push({ kind: 'projection-write-failed', projection: 'review-marker', cause: error })
}
```

  `transition-application-types.ts` 的告警联合把 `'state-yaml' | 'breadcrumb' | 'history'` 扩成 `'state-yaml' | 'breadcrumb' | 'history' | 'review-marker'`。

- [ ] **Step 5：两宿主渲染新告警。** `packages/cli/src/commands/transition.ts` 的 `switch (w.projection)` 加：

```ts
case 'review-marker':
  deps.io.err(`WARN: 评审待处理标记清除失败（转换已提交，标记会在 30 分钟后失效）: ${errMsg(w.cause)}`)
  break
```

  `packages/server/src/transitionResult.ts` 的 `switch (warning.projection)` 加同义一行（用 `process.stderr.write(... + '\n')` 与 `errText`）。

- [ ] **Step 6：修正受影响的宿主测试并新增集成用例。**
  - `review.integration.test.ts:123-128`：pending 的是 `verify-pass` 时 `transition verify-fail` 现在应 exit 0、phase 变为 `build`、`.pipeline-pending-review` 不存在（原「先运行 tenon review request …」断言删除）。
  - `transition-concurrency.test.ts:175-215`：保留「绑定摘要不匹配 → 409 review-approval-required」的意图，改用前进边 `verify-pass` 构造；另加一条断言轮次内 `verify-fail` 在同样的绑定不匹配下返回 200。
  - `transition-effects.integration.test.ts` 新增：任务在 verify、对 `verify-fail` 先 `tenon review request`（模拟升级前遗留的 pending 请求），不确认直接 `tenon transition <c> verify-fail` → exit 0，标记文件被删，`tenon status --json` 的 `step.review.status` 为 `none`。夹具与 CLI 调用方式照该文件现有用例。

- [ ] **Step 7：运行通过。** `npx vitest run packages/kernel/src/workflow packages/cli/src/commands/review.integration.test.ts packages/cli/src/transition-effects.integration.test.ts packages/server/src/transition-concurrency.test.ts`，期望全部 PASS；再跑 `npx tsc -b`（或仓库 `npm run typecheck`，以 package.json 为准）无错误。

- [ ] **Step 8：提交。** `git add` 上述文件；`git commit -m "feat(kernel): skip review receipt for in-budget back edges and clear stale review marker on transition"`。

### Task 2：`next` 对轮次内唯一回退边直接给 `transition`

**Files:**
- Modify: `packages/cli/src/commands/statusStepExits.ts:30-51`（`gatedBackActions` 与文件头注释 :1-5）
- Test: `packages/cli/src/commands/statusStep.test.ts`（:138、:545-590 一组）、`statusStepRoundsNext.test.ts`（:83-88、:359）、`statusStepTests.test.ts:197`
- Test: `packages/cli/src/review-residual.integration.test.ts`（:122-130 辅助函数、:185-207、:258-274）、`packages/cli/src/next-action-runner.integration.test.ts:241-248`、`packages/cli/src/test-flow.integration.test.ts:471`、`packages/cli/src/integration-next-runner-test-support.ts:181-184`

**Interfaces:**
- Consumes: Task 1 的内核行为（轮次内回退边转换不要回执）；`roundsExhausted`（`@tenon/kernel`）；`StepRounds`（`./statusStepRounds.js`）。
- Produces: `gatedBackActions(input: { gate; review; rounds?: StepRounds | null }, back)`。

- [ ] **Step 1：写失败的单测。** `statusStep.test.ts` 中「评审门上唯一的回退边：先请求评审，再等待，再转换」改为两条：

```ts
test('评审门上唯一的回退边、轮次未用完：直接 transition，不请求评审', () => {
  const next = gatedBackActions(
    { gate: 'review', review: { status: 'none', event: null }, rounds: { current: 1, max: 2, source: 'workflow' } },
    [backExit('verify-fail')],
  )
  expect(next).toEqual([{ action: 'transition', event: 'verify-fail' }])
})

test('评审门上唯一的回退边、宿主没给轮次：照旧先请求评审（失败关闭）', () => {
  const next = gatedBackActions(
    { gate: 'review', review: { status: 'none', event: null } },
    [backExit('verify-fail')],
  )
  expect(next).toEqual([{ action: 'request-review', event: 'verify-fail' }])
})
```

  `backExit` 按该文件现有构造 `StepExit` 的方式写（direction `'back'`）。「回退时挂着的是前进边的评审回执 → 改为请求回退边的评审」改为：轮次内 → `transition verify-fail`。:138、`statusStepRoundsNext.test.ts:83-88,359`、`statusStepTests.test.ts:197` 中轮次未用完的场景期望改为 `[{ action: 'transition', event: 'verify-fail' }]`；用完后的期望不动。多条回退边仍 `choose-exit` 的用例不动。

- [ ] **Step 2：运行确认失败。** `npx vitest run packages/cli/src/commands/statusStep.test.ts packages/cli/src/commands/statusStepRoundsNext.test.ts packages/cli/src/commands/statusStepTests.test.ts`，期望改过的用例 FAIL。

- [ ] **Step 3：实现。**

```ts
/**
 * 回退边。受轮次上限约束的评审步上，轮次还没用完时唯一的回退边直接 transition：回退不越过任何质量门，代价由上限封顶，
 * 不需要评审回执（内核同一判定，见 transition-rounds-gate.ts）。没给轮次（宿主没接线）时照旧走 request → await → transition。
 * 多条回退边交给人选。
 */
export function gatedBackActions(
  input: {
    readonly gate: string | null
    readonly review: { readonly status: string; readonly event: string | null }
    readonly rounds?: StepRounds | null
  },
  back: readonly StepExit[],
): readonly StepAction[] {
  const choose: StepAction = { action: 'choose-exit', exits: back.map((exit) => exit.event) }
  if (input.gate !== 'review') return [choose]
  const only = back.length === 1 ? back[0] : undefined
  const withinBudget = input.rounds !== undefined && input.rounds !== null && !roundsExhausted(input.rounds)
  if (only !== undefined && withinBudget) return [{ action: 'transition', event: only.event }]
  const bound = back.find((exit) => exit.event === input.review.event)
  if (bound !== undefined) {
    if (input.review.status === 'pending') return [{ action: 'await-review', event: bound.event }]
    if (input.review.status === 'approved') return [{ action: 'transition', event: bound.event }]
  }
  return only === undefined ? [choose] : [{ action: 'request-review', event: only.event }]
}
```

  `roundsExhausted` 从 `@tenon/kernel` 导入（`statusStepRoundsActions.ts` 已这样用）。确认 `statusStepNext.ts:268` 与 `statusStepExits.ts:107` 两个调用点传入的 `input` 已带 `rounds`（`StatusStepNextInput` 有 `rounds?`），无需改调用点；文件头注释 :1-5 把「回退边也要过本步的人工确认门」改为新规则。

- [ ] **Step 4：修正集成测试。**
  - `review-residual.integration.test.ts` 辅助函数「前几轮都真实走完」：去掉 `review request … verify-fail` 与确认，直接 `tenon transition <c> verify-fail`。用例「第 1 轮、上限 2，评审者不通过：next 是 verify-fail 的评审请求…」改为期望 `transition verify-fail`；「verify-fail 的评审请求 → 确认 → 转换回实现」改为「轮次内直接转换回实现，不产生评审标记」；「设为 3 才恢复回退」改为期望 `next` 恢复给 `transition verify-fail`。用完后被拒的断言不动。
  - `next-action-runner.integration.test.ts:241-248`：轮次内的 `verify-fail` 现在是 `transition` 动作；运行器 `integration-next-runner-test-support.ts` 的 `transition` 分支已能执行它则只改断言。
  - `test-flow.integration.test.ts:471`：期望 `[{ action: 'transition', event: 'verify-fail' }]`。

- [ ] **Step 5：运行通过。** `npx vitest run packages/cli/src/commands/statusStep.test.ts packages/cli/src/commands/statusStepRoundsNext.test.ts packages/cli/src/commands/statusStepTests.test.ts packages/cli/src/review-residual.integration.test.ts packages/cli/src/next-action-runner.integration.test.ts packages/cli/src/test-flow.integration.test.ts`，全部 PASS。

- [ ] **Step 6：提交。** `git commit -m "feat(cli): next takes in-budget back edges directly"`。

### Task 3：gate 只读组合判定、评审期放行 `tenon transition`、按种类提示

**Files:**
- Create: `hooks/lib/read-only-command.sh`
- Modify: `hooks/gate.sh`（:591-629 只读判定迁出并改调用；:534-585 `is_review_control_command`；:631-681 `gate_check_marker` 顺序与提示；lib 加载处与 ack-command.sh 并列）
- Modify: `tools/verify-skills.sh:206-211`（登记新 lib）
- Test: `tools/test-hooks.sh`（:176-192、:208-235、:2676-2679、:4728 附近；新增一节）

**Interfaces:**
- Produces: `pipeline_command_is_read_only <命令>` → 0/1；`pipeline_transition_command_ok <段>` → 0/1。
- Consumes: `pipeline_review_marker_change` / `pipeline_review_marker_event`（`hooks/review-ack.sh`，gate 已加载为 `REVIEW_HELPER`）。

- [ ] **Step 1：写失败的 hook 测试。** 在 `tools/test-hooks.sh` 现有「Pending 决策不能阻断已知只读检查」一节之后新增一节（评审标记与交互标记各跑一遍矩阵），用文件里已有的 `gate_cmd` 风格（它对 `$proj` 运行 Bash 载荷）：

```bash
# ── 只读组合：待处理期间放行每段都只读的组合命令；任何一段可能写或执行就拦 ──
for ro_kind in review interaction; do
  proj="$TMP/gate-ro-chain-$ro_kind"
  mkdir -p "$proj"
  if [ "$ro_kind" = review ]; then write_v2_review_marker "$proj" ro-demo verify; else write_v2_interaction_marker "$proj"; fi
  allow_cmd "只读组合（${ro_kind}）：管道 grep" 'git status --short | grep -v "^M  \|^A  "'
  allow_cmd "只读组合（${ro_kind}）：cd 后 ls" 'cd sub && ls'
  allow_cmd "只读组合（${ro_kind}）：丢弃 stderr 再 head" 'rg x . 2>/dev/null | head -5'
  allow_cmd "只读组合（${ro_kind}）：分号串两条只读" 'ls; pwd'
  allow_cmd "只读组合（${ro_kind}）：|| 串两条只读" 'git log --oneline -3 || git status'
  allow_cmd "只读组合（${ro_kind}）：sed 行号打印" "sed -n '10,20p' hooks/gate.sh"
  allow_cmd "只读组合（${ro_kind}）：引号里的管道符" 'grep "a|b" f'
  refuse_cmd "只读组合（${ro_kind}）：管道进 sh" 'cat a | sh'
  refuse_cmd "只读组合（${ro_kind}）：分号后写" 'ls; touch y'
  refuse_cmd "只读组合（${ro_kind}）：命令替换" 'cat "$(id)"'
  refuse_cmd "只读组合（${ro_kind}）：反引号" 'cat `id`'
  refuse_cmd "只读组合（${ro_kind}）：ANSI-C 引号" "ls \$'x'"
  refuse_cmd "只读组合（${ro_kind}）：重定向到文件" 'cat a > b'
  refuse_cmd "只读组合（${ro_kind}）：后台执行" 'ls &'
  refuse_cmd "只读组合（${ro_kind}）：tee 写文件" 'grep x f | tee out'
  refuse_cmd "只读组合（${ro_kind}）：引号不闭合" "ls 'unclosed"
  refuse_cmd "收紧（${ro_kind}）：git diff --output" 'git diff --output=x'
  refuse_cmd "收紧（${ro_kind}）：rg --pre" 'rg --pre ./run.sh x .'
  refuse_cmd "收紧（${ro_kind}）：sed w 命令" "sed -n 'w out' f"
  refuse_cmd "收紧（${ro_kind}）：sed 后接 -i" 'sed -n 1p -i f'
  refuse_cmd "收紧（${ro_kind}）：file -C" 'file -C -m magic'
  long_chain="$(printf 'ls; %.0s' $(seq 1 520))ls"   # 520 × 4 + 2 = 2082 字符
  [ "${#long_chain}" -gt 2048 ] && ok "只读组合夹具：超长命令确实超过 2048" || bad "只读组合夹具：超长命令确实超过 2048" "长度 ${#long_chain}"
  ro_start=$SECONDS
  refuse_cmd "只读组合（${ro_kind}）：超过 2048 字符" "$long_chain"
  [ $((SECONDS - ro_start)) -le 3 ] && ok "只读组合（${ro_kind}）：超长命令 3s 内拦截" || bad "只读组合（${ro_kind}）：超长命令 3s 内拦截" "耗时 $((SECONDS - ro_start))s"
  near_chain="$(printf 'ls; %.0s' $(seq 1 500))ls"   # 500 × 4 + 2 = 2002 字符
  ro_start=$SECONDS
  allow_cmd "只读组合（${ro_kind}）：接近上限的长组合仍放行" "$near_chain"
  [ $((SECONDS - ro_start)) -le 3 ] && ok "只读组合（${ro_kind}）：接近上限 3s 内放行" || bad "只读组合（${ro_kind}）：接近上限 3s 内放行" "耗时 $((SECONDS - ro_start))s"
done
# 评审标记下放行 `tenon transition <change> <event>`，由 CLI 判定；交互标记下照拦。
proj="$TMP/gate-ro-chain-review"
allow_cmd "评审标记：tenon transition 交给 CLI" 'tenon transition ro-demo verify-fail'
allow_cmd "评审标记：cd 后 tenon transition" 'cd /tmp && tenon transition ro-demo verify-fail'
refuse_cmd "评审标记：tenon transition 后接写" 'tenon transition ro-demo verify-fail; touch x'
refuse_cmd "评审标记：tenon transition 多余参数" 'tenon transition ro-demo verify-fail extra'
proj="$TMP/gate-ro-chain-interaction"
refuse_cmd "交互标记：tenon transition 照拦" 'tenon transition ro-demo verify-fail'
```

  自审批：在 `self-approval:` 那一节「HITL pending review 下读取 token 仍拦截」后加一条：同一个评审标记下 `run_gate_self_approval '{"cwd":"…","tool_name":"Bash","command":"cat ~/s/dashboard-token.json | head -1"}' 0`，期望 exit 2 且含「禁止读取 dashboard token」。

  提示：把 :176-192 的循环改为按 kind 断言——confirm / interaction 仍断言含 `AskUserQuestion` 与 `ToolSearch 查询 "select:AskUserQuestion"`；review 断言含 `评审待确认`、`review-demo`（夹具里的 change 名）、`Dashboard`，并 `assert_not_contains … "AskUserQuestion"`。三者都断言含 `只读组合`。在 `GATE_UNLOCK_TEXT` 那行之后加：

```bash
GATE_REVIEW_UNLOCK_TEXT="$(grep -o '等用户回复「确认继续」.*放行语须是整条回复' "$ROOT/hooks/gate.sh")"
unlock_phrases_ok "gate 评审提示" "$GATE_REVIEW_UNLOCK_TEXT" "即确认这道评审门"
```

- [ ] **Step 2：运行确认失败。** `npm run test:hooks`，期望新增断言 FAIL（组合被拦、提示仍含 AskUserQuestion 等）。

- [ ] **Step 3：新建 `hooks/lib/read-only-command.sh`。**

```bash
# shellcheck shell=bash
# 只读放行（CONTEXT.md「只读放行」）：待处理标记存在时，哪些 shell 命令仍然放行。
# 接口：pipeline_command_is_read_only <已解码的命令> → 0 只读 / 1 不是。
# 失败关闭：超长、引号没闭合、出现重定向 / 命令替换 / 后台执行 / ANSI-C 引号、任何一段不在名单里，都判非只读。
# bash 3.2；线性扫描，长度上限让 hook 在宿主超时前给出结论（超时会被宿主当成非阻断错误）。

PIPELINE_READ_ONLY_MAX_CHARS=2048
PIPELINE_RO_SED_PRINT='^([0-9]+|\$)(,([0-9]+|\$))?p$'

# 丢弃输出的重定向不写任何文件：作为独立记号（前后是空格）时先去掉。
pipeline_ro_strip_discards() { # $1=command → _PIPELINE_RO_TEXT
  local text=" $1 " before=''
  while [ "$text" != "$before" ]; do
    before="$text"
    text="${text// 2>\/dev\/null / }"
    text="${text// 1>\/dev\/null / }"
    text="${text// >\/dev\/null / }"
    text="${text// &>\/dev\/null / }"
    text="${text// 2>&1 / }"
  done
  _PIPELINE_RO_TEXT="$text"
}

# sed -n 只认行号区间打印；脚本后的参数不许是选项（GNU sed 会把 -i 之类重排进来）。
pipeline_ro_sed_ok() { # $1=segment → 0 = 只读
  local script i=3
  local -a words
  read -r -a words <<< "$1"
  [ "${#words[@]}" -ge 3 ] || return 1
  script="${words[2]}"
  script="${script#\'}"; script="${script%\'}"
  script="${script#\"}"; script="${script%\"}"
  [[ "$script" =~ $PIPELINE_RO_SED_PRINT ]] || return 1
  while [ "$i" -lt "${#words[@]}" ]; do
    case "${words[$i]}" in -*) return 1 ;; esac
    i=$((i + 1))
  done
  return 0
}

pipeline_ro_segment_ok() { # $1=去掉首尾空白的段 → 0 = 只读
  local s="$1"
  case "$s" in
    cd|cd\ *|pwd|pwd\ *|ls|ls\ *|grep\ *|head\ *|tail\ *|wc\ *|cat\ *|stat\ *|realpath\ *|\
    test\ *|'['\ *|command\ -v\ *)
      return 0 ;;
    rg\ *)
      case "$s" in *--pre*) return 1 ;; esac
      return 0 ;;
    file\ *)
      case "$s" in *-C*|*--compile*) return 1 ;; esac
      return 0 ;;
    sed\ -n\ *|sed\ --quiet\ *|sed\ --silent\ *)
      pipeline_ro_sed_ok "$s"
      return ;;
    find\ *)
      case "$s" in
        *" -delete"*|*" -exec"*|*" -execdir"*|*" -ok"*|*" -okdir"*|*" -fprint"*|*" -fls"*) return 1 ;;
      esac
      return 0 ;;
    git\ status|git\ status\ *|git\ diff|git\ diff\ *|git\ log|git\ log\ *|git\ show|git\ show\ *)
      case "$s" in *--output*) return 1 ;; esac
      return 0 ;;
    git\ rev-parse\ *|git\ branch\ --show-current|git\ worktree\ list|git\ worktree\ list\ *)
      return 0 ;;
    tenon\ list|tenon\ list\ *|tenon\ status\ *|tenon\ get\ *|tenon\ inbox|tenon\ inbox\ *|tenon\ document\ status\ *)
      return 0 ;;
  esac
  return 1
}

pipeline_command_is_read_only() { # $1=decoded command → 0 = 只读
  local command="${1:-}" len i=0 ch nx state=plain seg='' segments='' any=1
  [ -n "$command" ] || return 1
  [ "${#command}" -le "$PIPELINE_READ_ONLY_MAX_CHARS" ] || return 1
  pipeline_ro_strip_discards "$command"
  command="$_PIPELINE_RO_TEXT"
  len="${#command}"
  while [ "$i" -lt "$len" ]; do
    ch="${command:i:1}"
    nx="${command:i+1:1}"
    case "$state" in
      single)
        seg="$seg$ch"
        if [ "$ch" = "'" ]; then state=plain; fi
        ;;
      double)
        case "$ch" in
          '\') seg="$seg$ch$nx"; i=$((i + 1)) ;;
          '`') return 1 ;;
          '$') if [ "$nx" = '(' ]; then return 1; fi; seg="$seg$ch" ;;
          '"') seg="$seg$ch"; state=plain ;;
          *) seg="$seg$ch" ;;
        esac
        ;;
      *)
        case "$ch" in
          "'") seg="$seg$ch"; state=single ;;
          '"') seg="$seg$ch"; state=double ;;
          '\') seg="$seg$ch$nx"; i=$((i + 1)) ;;
          '$') case "$nx" in '('|"'") return 1 ;; esac; seg="$seg$ch" ;;
          '`'|'>'|'<'|$'\n'|$'\r') return 1 ;;
          '|') segments="$segments$seg"$'\n'; seg=''; if [ "$nx" = '|' ]; then i=$((i + 1)); fi ;;
          '&') if [ "$nx" != '&' ]; then return 1; fi; segments="$segments$seg"$'\n'; seg=''; i=$((i + 1)) ;;
          ';') segments="$segments$seg"$'\n'; seg='' ;;
          *) seg="$seg$ch" ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
  [ "$state" = plain ] || return 1
  segments="$segments$seg"
  # 引号里的换行会把一段拆成几行：每一行都得过名单，第一行仍以真正的命令名开头，所以只会更严。
  while IFS= read -r seg; do
    while [ "${seg# }" != "$seg" ]; do seg="${seg# }"; done
    while [ "${seg#	}" != "$seg" ]; do seg="${seg#	}"; done
    while [ "${seg% }" != "$seg" ]; do seg="${seg% }"; done
    while [ "${seg%	}" != "$seg" ]; do seg="${seg%	}"; done
    [ -n "$seg" ] || continue
    pipeline_ro_segment_ok "$seg" || return 1
    any=0
  done <<< "$segments"
  return "$any"
}
```

- [ ] **Step 4：接进 gate.sh。**
  1. 在加载 `hooks/lib/ack-command.sh` 的同一处按同样方式加载 `lib/read-only-command.sh`；缺失时定义 `pipeline_command_is_read_only() { return 1; }`（失败关闭：只读也拦），并在注释里说明。
  2. 删除 gate.sh 里的 `pipeline_command_is_strict_read_only`（:591-618，已迁入 lib）；`pipeline_tool_is_read_only` 改调 `pipeline_command_is_read_only "$command"`；它上方的注释改为指向 lib。
  3. `is_review_control_command` 的 `case` 加分支（放在 `tenon dashboard --open` 分支之后）：

```bash
      # 评审待确认期间回退（或用户要求回去改）要能执行：transition 由 CLI 判定，CLI 照旧拒绝没有回执的前进边与
      # 上限用完后的回退边，这里只放行这一种精确形态，不顺带放行任何别的写。
      tenon\ transition\ *)
        pipeline_transition_command_ok "$segment" || return 1
        found=0 ;;
```

     并在该函数之前加：

```bash
pipeline_transition_command_ok() { # $1=segment → 0 = 恰好 `tenon transition <change> <event>`
  local rest="${1#tenon transition }" change event
  case "$rest" in ''|*[!A-Za-z0-9_\ -]*) return 1 ;; esac
  change="${rest%% *}"
  event="${rest#* }"
  [ -n "$change" ] && [ "$change" != "$rest" ] && [ -n "$event" ] || return 1
  case "$event" in *' '*) return 1 ;; esac
  return 0
}
```

  4. `gate_check_marker`：把 review kind 的自审批拦截块（`if [ "$kind" = "review" ] && [ -n "$SELF_APPROVAL_CANDIDATE" ]; then … exit 2; fi`）移到 `AskUserQuestion|request_user_input|ToolSearch` 放行之后、`pipeline_tool_is_read_only "$TOOL" && return 0` 之前。
  5. 末尾提示按 kind 分支（单行 printf，便于测试 grep）：

```bash
    if [ "$kind" = "review" ]; then
      local review_change review_event
      review_change="$(pipeline_review_marker_change "$m" 2>/dev/null || true)"
      review_event="$(pipeline_review_marker_event "$m" 2>/dev/null || true)"
      printf '【Tenon 门】评审待确认（任务 %s，事件 %s），%s 已被拦截：现在不要改文件或推进前进状态。把产出与结论摆给用户，等用户回复「确认继续」「继续执行」「同意继续」，或简短同意「继续」「可以」「同意」「好的」「按推荐」「按你的推荐」即确认这道评审门；拒绝（「不可以」「不同意」）、带条件（「继续，但……」）或其他回复不算，放行语须是整条回复。用户也可以在 Dashboard 确认（tenon dashboard --open）；agent 不能自己确认。等待期间只读工具与只读组合命令（用 |、&&、||、; 连接、每段都只读）不受拦截；轮次内的回退可以直接 tenon transition <change> <回退事件>。\n' \
        "${review_change:-?}" "${review_event:-?}" "$TOOL" >&2
      exit 2
    fi
```

     confirm / interaction 的原提示保留，只把「等待期间 Read/Grep/Glob 等只读工具不受拦截」改为「等待期间只读工具与只读组合命令（用 |、&&、||、; 连接、每段都只读）不受拦截」，并保持「没有提问工具时…解封后再重发」这段在同一行内（`GATE_UNLOCK_TEXT` 依赖它）。`pipeline_review_marker_change` / `pipeline_review_marker_event` 定义在 `hooks/review-ack.sh:15,34`，gate 已把它作为 `REVIEW_HELPER` 加载。

- [ ] **Step 5：登记 lib。** `tools/verify-skills.sh` 仿照 :206-211 加：

```bash
  [ -f "$ROOT/hooks/lib/read-only-command.sh" ] \
    || add_fail "缺失 hook 辅助脚本: hooks/lib/read-only-command.sh" "hooks/gate.sh" "把 hooks/lib/read-only-command.sh 纳入发布包"
```

  再用 Grep 查 `ack-command.sh` 在打包 / 所有权清单里的其它出现处（`tools/`、`packages/`、`templates/`、`adapters/`），有就同样登记新文件。

- [ ] **Step 6：运行通过。** `npm run test:hooks` 全部 PASS（含原有 `rg -n pipeline .; touch changed` 仍拦、`tenon transition demo build-complete` 在交互标记下仍拦、受保护写入各形态不变）；`bash -n hooks/gate.sh`、`bash -n hooks/lib/read-only-command.sh` 无输出；`bash tools/verify-skills.sh`（或 package.json 中对应脚本）通过。

- [ ] **Step 7：提交。** `git commit -m "feat(hooks): read-only command chains, transition under pending review, per-kind gate hints"`。

### Task 4：规则、契约与用户文档同步

**Files:**
- Modify: `templates/workflow.md:10-15,23-24`
- Modify: `skills/tenon/SKILL.md`（模式表 interactive 行；「出口」条；动作表 `request-review` / `await-review` 行只在提到回退边处改）
- Modify: `tools/generate-product-identity.mjs`（`renderCodexAgentsBlock` 的评审门句子）→ 生成 `templates/generated/codex-agents-block.md`、`packages/kernel/src/instructions/codex-agents-block.generated.ts`、仓库根 `AGENTS.md` 的 `PIPELINE:CODEX` 块
- Modify: `docs/CONTRACT.md`（:161、:266-272、:696-720）、`adapters/contract.md:64`
- Modify: `docs/usage/default-workflow.md:314-327`、`docs/usage/zh-CN/default-workflow.md:159`（及同文件描述 verify-fail 需确认之处）、`docs/usage/zh-CN/cli-reference.md:138`、`docs/usage/cli-reference.md`（轮次段 :202-223 如有冲突）、`docs/usage/zh-CN/index.md:30`、`docs/usage/troubleshooting.md:355`（及 zh-CN 对应文件如有）
- Modify: `docs/usage/release-notes.md`、`docs/usage/zh-CN/release-notes.md`（顶部新增一条）

- [ ] **Step 1：改规则文本。** 统一说法（中文）：「受轮次上限约束的步骤（评审门且有回退边）上，轮次还没用完时走回退边不需要评审回执，直接 `tenon transition`；前进边、剩余阻断与测试豁免仍只认人工确认。」英文：「On a step limited by verification rounds (a review gate with a back edge), taking the back edge while rounds remain needs no review receipt: run `tenon transition` directly. Forward edges, residual blockers and test waivers still need a human confirmation.」
  - `templates/workflow.md`「评审是出边级的」条末尾加上述中文一句。
  - `skills/tenon/SKILL.md`：模式表 interactive 行在「每次 `transition` / `complete` 前展示…等用户说「继续」」后加「（受轮次约束的评审步上轮次内的回退除外：直接 transition，用一句话告诉用户为什么回退）」；「出口」条把「回退边只在它的含义成立时走（…）；interactive 先问」改为「回退边只在它的含义成立时走（…）；受轮次约束的评审步上，轮次内的回退边 `next` 会直接给 `transition`，不需要评审回执，任何模式都直接走并用一句话说明；评审待确认时用户要求回去修改，同样直接 `tenon transition <c> <回退事件>`」。**不要改**「能确认这道门的回复是…（拒绝或带条件的回复不算）」这一句（`tools/test-hooks.sh:2683-2689` 守它）。
  - `tools/generate-product-identity.mjs`：评审门句子改为「评审门（`gate: review`）离开前须对确切 transition event 取得人类显式确认（受轮次上限约束的步骤上，轮次内的回退边除外：直接 transition）」，其余不动。

- [ ] **Step 2：生成并核对。** `npm run generate:identity`，然后 `npm run check:identity`，期望通过；`git diff --stat` 应只多出三处生成物（模板、`.generated.ts`、`AGENTS.md` 的块）。

- [ ] **Step 3：契约与用户文档。** 按上表逐处改为新规则：`CONTRACT.md:266-272` 的「CLI 永远要求显式选择 event」改为说明轮次内回退免回执、用完后被拒；`:161` 补「轮次内回退边除外」；`:696-720` 写明未用完时回退边不要回执。`default-workflow.md:314-327` 的「If verification fails」示例改为直接 `tenon transition <change-name> verify-fail`，并保留「a verify-pass receipt cannot approve another event」的意思但改举前进边。`zh-CN/cli-reference.md:138`「上限没用完时一切照旧…」改为「上限没用完时回退边照常给出，直接转换，不需要评审回执」。`zh-CN/index.md:30`、`troubleshooting.md:355` 同步。发布说明新增一条（中英各一）：标题「Back edges within the round limit no longer need a review receipt; the gate allows read-only command chains」，列三点（回退免确认与标记清理、只读组合与收紧项、按种类提示与评审期放行 `tenon transition`）。

- [ ] **Step 4：校验。** `npm run test:hooks` 中关于 SKILL.md 文本的断言仍 PASS（只跑 hook 套件即可，它包含这些断言）；Grep `回退边.*确认|verify-fail.*review request|review request.*verify-fail` 于 `docs/ skills/ templates/ adapters/`，确认剩下的出现都是「轮次用完后」或历史发布说明。

- [ ] **Step 5：提交。** `git commit -m "docs: in-budget back edges skip review receipts; read-only chains under pending markers"`。

### Task 5：合并后重打包与全量测试（主线）

- [ ] **Step 1：合并。** 把 Task 1+2、Task 3、Task 4 的分支依次合并进 `tenon/reduce-review-gate-friction`，解决冲突（预期只有 `CONTEXT.md` 之外的文档无交叉）。
- [ ] **Step 2：重打包。** `npm run bundle`；`npm run build:server`；如有 `check:dashboard-dist-freshness` / `check:default-workflow-freshness` 一类检查一并跑。
- [ ] **Step 3：全量测试。** `npx tsc -b`（以 package.json 的 typecheck 脚本为准）、`npm test`、`npm run test:hooks`、`npm run check:identity` 全部通过。
- [ ] **Step 4：提交 dist。** `git commit -m "build(dist): rebuild bundles"`。

## 验证

- 内核、CLI、Dashboard：`npm test` 全绿；新用例覆盖「轮次内回退免回执」「前进边仍要回执」「用完后回退仍拒」「roundsOf 缺席仍要回执」「转换删本任务标记、不碰别的」「升级前遗留的回退请求直接转换」。
- Hook：`npm run test:hooks` 全绿；新矩阵覆盖组合放行 / 拦截、收紧形态、超长与接近上限的耗时、评审期 `tenon transition`、自审批候选在组合里仍拦、两条提示的放行语一致性。
- 手工：在本 worktree 用源码 CLI 对一个测试任务走一遍：verify 失败 → `next` 是 `transition verify-fail` → 执行成功、无标记；评审待确认时 `git status --short | grep x` 不被拦。

## 回滚

- 代码：`git revert` 本任务的提交（内核、CLI、hooks、文档各自独立提交，可单独回退）；回退后需重新 `npm run bundle` / `build:server` 与 `npm run generate:identity`。
- 行为：回退后轮次内回退重新需要评审回执；已免回执完成的历史转换不受影响（只是少了评审确认的交互效果记录）。
