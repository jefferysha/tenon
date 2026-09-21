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
- `next` 是闭集：`stop`、`load-tenon`、`read-documents`、`run-agent`、`load-skill`、
  `scaffold-document`、`record-document`、`register-field`、`set-field`、`validate-spec`、
  `apply-spec`、`run-test`、`fix`、`request-review`、`await-review`、`choose-exit`、`transition`、
  `complete`。第一条命中的规则返回，同一条规则内同波的项一起返回。
- 顺序：停（归档 / 引用已删除技能 / 步骤不在计划里）→ 重新加载 tenon → 读输入文档 → 执行者 →
  本步技能 → 应用规格 → 产出与登记文档 → 产出字段与门禁字段 → 彩排规格 → 必需测试 →
  评审者 → 结果字段 → 出口。
- 执行者失败可以重跑；评审者不通过不重跑——评审结论是证据，代码没改重跑只会得到同一份结论，
  该走的是回退边。
- 回退边只在必需评审者不通过、且本步真的有回退边时出现在 `choose-exit` 里；否则给 `fix` 加上
  全部前进边阻塞原因的并集。
- `mode`：`TENON_AFK=1` → `afk`；本任务有交互授权 → `continuous`；否则 `interactive`。

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| 当前用户已归档该任务 | `step.archived=true`，`next: [{action: stop, code: archived}]` |
| 计划引用已删除技能 | `next: [{action: stop, code: retired-skills}]`，文案与 CLI/HTTP 拒绝同一份 |
| 当前 step 不在计划里 | `next: [{action: stop, code: step-not-in-plan}]` |
| 本次步骤访问还没加载 `tenon` | `next: [{action: load-tenon}]`，先于一切 |
| 声明的输入文档未读 / 过期 | `read-documents` 带全部待读路径 |
| 必需测试未通过 | `run-test`；失败的测试要先改代码再重跑 |
| `delta-spec` 归本步且回执不新鲜 | 文档登记完之后 `validate-spec` |
| `applied-spec` 归本步且回执不新鲜 | 先 `apply-spec`，再登记 |
| 多条前进边就绪 | `choose-exit` |

## 5. Tests

- `packages/cli/src/commands/statusStep.test.ts`：`stepNextActions` 的每条规则与相对顺序（纯输入）。
- `packages/cli/src/commands/status.test.ts`：列表与无名形态逐字不变。
- `packages/cli/src/spec-apply.integration.test.ts`：`spec apply` 的真实彩排与退出码。
