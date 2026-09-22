# `tenon status <change> --json` 的 `step` 块

> 单个 `tenon` skill 每一步照做的全部输入。顺序只在一个函数里，不写在 skill 文案里。

---

## 1. Scope / Trigger

- 只有 `tenon status <name> --json`（带 change 名）才带 `step`。列表形态（`status --json` 无名、
  `list --json`）逐字不变，那两份输出是锚定的 schema。
- `step` 投影不可用时（工作流读不到、指纹不匹配等）写一行 `WARN: step 投影不可用: …` 到 stderr，
  `active_changes` 照常输出、exit 0 —— 读状态不该因为投影失败而失败。

## 2. Signatures

```ts
// packages/cli/src/commands/statusStep.ts
buildStatusStep(deps, name, state, plan): Promise<StepBlock>
stepNextActions(input: StepNextInput): readonly StepAction[]   // 纯函数，顺序的唯一真相源
// packages/cli/src/commands/stepExitReport.ts
evaluateStepExitReport(deps, name, dir, state, plan): Promise<StepExitReport>
// packages/cli/src/commands/statusStepParts.ts
stepSkills(deps, plan, stepId, completed) / stepDocuments(change, policy, stepId, items) / stepFields(state, step)
// packages/cli/src/commands/statusStepAgents.ts
agentStepViews(deps, name, dir, state, plan, stepId)
// packages/cli/src/commands/statusStepSpec.ts
specApplyReceiptFresh(repoRoot, changeDir): Promise<{ fresh: boolean; mode: string | null }>
```

## 3. Contracts

- 判定源一律复用既有的：技能证据 `completedWorkflowSkillsSinceStepEntry` + `resolveRequiredSkillSlots`，
  文档 `evaluateDocumentEvidence`，测试 `evaluateTestEvidence`，agent `projectStepAgents` /
  `nextAgentWave`，出口 guard `evaluateDefaultEventPreconditions`（default）或
  `evaluateWorkflowIrStepGuards` + `effectiveLifecyclePolicy`（自定义），评审回执 `reviewGateStatus`。
  这里只换形状，不新写一套 guard。
- `next` 是闭集：`stop`、`load-tenon`、`finish-change`、`read-documents`、`run-agent`、`load-skill`、
  `scaffold-document`、`record-document`、`register-field`、`set-field`、`validate-spec`、
  `apply-spec`、`run-test`、`fix`、`request-review`、`await-review`、`choose-exit`、`transition`、
  `complete`。第一条命中的规则返回，同一条规则内同波的项一起返回。
- 顺序：停（归档 / 引用已删除技能 / 步骤不在计划里）→ 重新加载 tenon → 状态机已归档（治理归档
  或停）→ 读输入文档 → 执行者 → 本步技能 → 应用规格 → 产出与登记文档 → 产出字段与门禁字段 →
  彩排规格 → 必需测试 → 评审者 → 结果字段 → 出口。
- 终态自边由 kernel 推导（`implicitCompletionTransition`），`default` 的 `archive` 也在内：它
  投影成 `direction: completion` 的出口，`next` 给 `complete`。走完之后 `archived=true`，
  `next` 只剩 `finish-change`（治理归档命令）；两条命令的先后因此写在数据里，而不是靠人记。
- 执行者失败可以重跑；评审者不通过不重跑——评审结论是证据，代码没改重跑只会得到同一份结论，
  该走的是回退边。
- 回退边只在必需评审者不通过、且本步真的有回退边时出现；否则给 `fix` 加上全部前进边阻塞原因的
  并集。回退边与前进边过同一道门：`gate: review` 的步骤上，唯一的回退边走
  `request-review → await-review → transition`（review 回执逐边绑定，一次「回到实现」的决定不能
  顺便授权 verify-pass），多条回退边仍然交给人 `choose-exit`。
- 文档动作按台账状态派：`missing` 的产出发 `scaffold-document` + `record-document` 一对（骨架
  只写文件，登记才推进台账）；`stale` 的（产出 / 可改 / 只读输入都算）发 `record-document`；
  `unread` 的才发 `read-documents`。`role: update` 的槽从没登记过时不发动作——它是「本步可以改
  它」，不是「本步必须产出它」，与文档取证层（update 槽不进 blockers）同一口径。
- 文档动作的 `producers` 恒取该文档在**当前步**合法的那组（`recordProducerCandidatesForPolicyStep`），
  读清单也不例外：登记命令认的就是这一组。当前步没有合法 producer 时不发登记动作，让出口 blocker
  如实说明。
- `mode`：`TENON_AFK=1` → `afk`；本任务有交互授权 → `continuous`；否则 `interactive`。

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| 当前用户已归档该任务 | `step.archived=true`，`next: [{action: stop, code: archived}]` |
| 计划引用已删除技能 | `next: [{action: stop, code: retired-skills}]`，文案与 CLI/HTTP 拒绝同一份 |
| 当前 step 不在计划里 | `next: [{action: stop, code: step-not-in-plan}]` |
| 本次步骤访问还没加载 `tenon` | `next: [{action: load-tenon}]`，先于一切 |
| 声明的输入文档未读（`unread`） | `read-documents` 带全部待读路径 |
| 已登记的文档被改（`stale`） | `record-document`，producer 取当前步接受的那组；不再发 `read-documents` |
| 本步产出还没有（`missing`） | `scaffold-document` + `record-document` 一对 |
| `role: update` 的槽还没登记过 | 不发动作（可以改 ≠ 必须产出） |
| 必需测试未通过 | `run-test`；失败的测试要先改代码再重跑 |
| `delta-spec` 归本步且回执不新鲜 | 文档登记完之后 `validate-spec` |
| `applied-spec` 归本步且回执不新鲜 | 先 `apply-spec`，再登记 |
| 评审门上必需评审者打回且只有一条回退边 | `request-review` → `await-review` → `transition` |
| 多条前进边就绪 | `choose-exit` |
| 字段由转换副作用落值（`archived` / `build_sha` / review 回执…） | 不发写入动作，走到那条转换 |

## 5. Tests

- `packages/cli/src/commands/statusStep.test.ts`：`stepNextActions` 的每条规则与相对顺序（纯输入）。
- `packages/cli/src/commands/status.test.ts`：列表与无名形态逐字不变。
- `packages/cli/src/spec-apply.integration.test.ts`：`spec apply` 的真实彩排与退出码。
- `packages/cli/src/next-action-runner.integration.test.ts`：验收锚——只照 `next` 做事的运行器把一个
  `default` 任务从 `open` 做到 `list --finished`，中途改掉一份已登记的文档、并被评审者打回一次。
  `next` 发出去却执行不了的动作会让它当场红。
