# default 对话轨补齐 OpenSpec 契约技能

## Goal

让内建 `default` 的 `chat` 轨满足它自己在运行时已被施加的 OpenSpec 文档契约，从而「复制 default」能成功新建工作流，并且工作流页上 chat 轨的「来源技能」列不再是空的。

## 复现

工作流页 → ⋯ → 新建工作流 → 选「复制 default」→ 取名 → 创建。

`POST /api/workflows/copy-test` 返回 400：

```
tracks.chat: openspec_contract: required 要求 'open' 声明 OpenSpec proposal skill（允许: openspec-propose | opsx:propose）
tracks.chat: ... 'explore' ... Superpower brainstorming skill（允许: brainstorming | superpowers:brainstorming）
tracks.chat: ... 'spec' ... OpenSpec delta proposal skill / Superpower plan skill
tracks.chat: ... 'verify' ... Superpower verification skill
tracks.chat: ... 'ship' ... OpenSpec apply skill
```

只有 `chat` 报错；`pm` / `frontend` / `backend` / `free` 四条轨都已声明这些技能。空白模板新建正常。

## 根因

`default` 是**按名字**受治理的：`packages/kernel/src/workflow/document-contract.ts:141` 对 `workflowName === 'default'` 直接套用 OpenSpec 文档契约。因此 default 的 YAML 里本来就没有 `openspec_contract: required` 这一行，`validateOpenSpecContractWorkflow` 也从不对它跑（`document-contract-validation.ts:267` 只在该字段等于 `'required'` 时校验）。

复制时 `packages/dashboard-app/src/workbench/workbenchDefinition.ts:276` 显式写入 `openspecContract: 'required'` 以保住治理，校验这才第一次真跑——于是暴露出 `chat` 轨从来没满足过它运行时已经在承担的契约。

佐证：`GET /api/workflows/default` 的 `effectiveIo.open.outputs` 里，`proposal` / `openspec-design` / `tasks` 的 `producers` 已经是 `['openspec-propose', 'opsx:propose']`，但 chat 的 `open` 阶段只声明 `tenon-open`，所以工作流页输出表的「来源技能」列显示「—」。

## 方案选择

两个选项：A) 在 chat 轨补齐契约技能；B) 复制时不写 `openspec_contract: required`。

**先选了 A，实测证伪，改为 B。**

### A 为什么错

kernel spec `workflow-track-branches.md:64` 写着 default 的 **`chat` 轨是有意的 drivers-only 流程**，并且因此是「无轨道语境下的代表分支」。给它加 6 个契约技能撑大了它的技能面，`npx vitest run` 直接多出 12 个失败：

```
packages/cli/src/commands/afk.test.ts                 10 个
packages/automation/src/runner/runner.test.ts          2 个（另有其因，见下）
```

典型报错：

```
phase "ship" 的 skill 槽「openspec-apply-change」在当前安装面均无法定位
（候选：openspec-apply-change）：skill 'openspec-apply-change' 在给定的 20 个根目录里都不存在
```

即：chat 轨被大量测试当作代表分支跑，加技能等于给所有这些路径强加了新的安装面要求。这是设计决策，不是遗漏。

我当初的两条理由都不成立：

1. 「default 按名字受治理，chat 运行时已承担同一份契约」——受治理的是**文档契约**（哪些文档必须存在），不是技能清单。`effectiveIo` 里 `producers: ['openspec-propose']` 来自文档契约的固定表，不是来自轨道技能；工作流页「来源技能」显示「—」正是已知的 kernel gap（技能本身没有 IO 声明），不能当作 chat 该声明这些技能的证据。
2. 「另外 4 条轨都声明了」——那 4 条不是 drivers-only 轨道，chat 的定位本就不同。

### B 为什么对

`copyWorkflowDef` 补盖 `openspec_contract: required`，等于替源定义断言了一件 default 自己做不到的事（chat 轨不满足）。default 受治理靠的是**名字**（`document-contract.ts:141` 对 `name === 'default'` 直接套契约），它的 YAML 里从来没有这一行，`validateOpenSpecContractWorkflow` 也从不对它跑——所以这个矛盾一直藏着，直到复制时校验第一次真跑才炸成 400。

副本不再叫 default，也就不再按名字受治理。复制时如实不写该字段即可；要 OpenSpec 治理的用户自己在 YAML 里写 `openspec_contract: required` 并补齐各轨技能。default 的形状一个字节没动。

## Requirements

- `copyWorkflowDef` 不再写 `openspecContract: 'required'`；`producerPolicy` 仍从 `effective-phase-skills` 改为 `effective-step-skills`（custom 契约不允许前者）。
- 不改 default 模板、不改校验器、不放宽契约。

## Acceptance Criteria

- [x] 工作流页「复制 default」成功（`POST /api/workflows/copy-check` 200），页面切到副本，全局 · 5 轨道 · 7 阶段，无错误
- [x] `templates/workflows/default.yaml` 与生成常量零改动，chat 轨仍是 drivers-only
- [x] `workbenchDefinition.test.tsx` 断言改为 `openspecContract` 为 undefined，8/8 绿
- [x] 先前被 A 方案打挂的 `afk.test.ts` 10 个失败全部回到绿

## 实际改动

| 文件 | 改动 |
|---|---|
| `packages/dashboard-app/src/workbench/workbenchDefinition.ts` | `copyWorkflowDef` 去掉 `openspecContract: 'required'`，并把上面那段推理写进函数注释 |
| `packages/dashboard-app/src/workbench/workbenchDefinition.test.tsx` | 断言由 `toBe('required')` 改为 `toBeUndefined()`，标题与注释说明为何 |

## 踩坑记录

- 改 `templates/workflows/default.yaml` 后必须 `node tools/generate-default-workflow.mjs` 重新生成常量，并 `npx tsc -b` 重建 kernel 的 `dist`——dashboard server 走 `packages/kernel/dist`，只跑 `npm run build:server` 会看到服务端仍返回旧内容。（该路径最终被撤销，但结论对以后改模板仍然有效。）
- `packages/automation/src/runner/runner.test.ts` 的 2 个失败与本任务无关：把**全部**改动 stash 后仍然一模一样地失败，属交接文档第 3 节第 6 条列出的其他会话（sandcastle / `tenon-afk-run.sh`）。
