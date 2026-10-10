# verify-round-limit Specification

## Purpose
工作流步骤声明验证轮次上限（默认 2，任务可覆盖），按进入次数计、回到规格重新计数；用完后停止自动回退，由用户接受剩余阻断或另选出路。

## Requirements
### Requirement: 工作流 SHALL 能声明步骤的验证轮次上限，任务可以覆盖

工作流的步骤 SHALL 能声明 `max_rounds: <N>`，表示这一步最多验证几轮：第 N 轮仍因必需测试或必需评审者不通过时，Tenon 不再自动回退。

- `N` MUST 是 1 到 20 之间的整数。
- 只有设了评审门（`gate: review`）且至少有一条回退边的步骤可以声明它，其余步骤声明时解析报错。没有评审门的步骤（如 build）不受上限约束，它的回退边（如 `requirements-changed`）始终可用。
- 取值越界或不是整数时，同样解析报错。
- 内置 `default` 工作流的每条轨道 SHALL 在 verify 步声明 `max_rounds: 2`。
- 这类步骤没有声明时（自定义工作流，或升级前已冻结的任务计划），SHALL 按内置默认值 2 处理。
- 上限 SHALL 随工作流计划冻结；任务开始后再编辑工作流文件，不改变在途任务的上限。
- Dashboard 读写工作流定义时 SHALL 保留 `max_rounds`，不得丢弃或拒绝。

任务 SHALL 能用 `tenon set <change> max_rounds <N>` 覆盖本任务所有受上限约束的步骤（设了评审门且有回退边）的上限。

- 取值同样是 1 到 20 的整数，越界拒绝。
- 写入记进任务历史。
- `tenon status --json` 的步骤块 SHALL 写出当前轮次、上限与上限来源（`workflow`、`default` 或 `task`）。
- 调高上限是用户的决定：agent MUST NOT 在没有用户明确指示时调高。

#### Scenario: 内置工作流默认两轮

- **WHEN** 用 `default` 工作流新建任务
- **THEN** verify 步的上限是 2，来源是 `workflow`

#### Scenario: 非法取值被拒绝

- **WHEN** 工作流的某一步声明 `max_rounds: 0`、`max_rounds: 21`、`max_rounds: two`，或在没有评审门、没有回退边的步骤上声明
- **THEN** 工作流解析失败，并点名该步骤与原因

#### Scenario: 任务覆盖上限

- **WHEN** 用户让 agent 执行 `tenon set <change> max_rounds 1`
- **THEN** 该任务 verify 步的上限变为 1，来源是 `task`
- **AND** 任务历史里有这次写入

### Requirement: 验证轮次 SHALL 按进入步骤的次数计算，回到规格后重新计数

受上限约束的步骤，当前是第几轮 SHALL 等于：自上一次重新计数以来，任务进入这一步的次数（含当前这次）。

- 重新计数：任务落到早于这一步所有回退目标的步骤时，计数清零。在 `default` 工作流里，就是经 `requirements-changed` 回到规格步。
- 计数 SHALL 取自 canonical 转换记录链。没有转换记录链的旧任务，退回读 `.pipeline-history.jsonl` 里的转换行；任务有转换记录链却读不到时 SHALL 报错，不退回读历史文件。
- 删除标记、重跑命令、换 agent MUST NOT 让计数清零。

#### Scenario: 第二次进入验证

- **GIVEN** 任务第一次验证失败，经 `verify-fail` 回到实现，又经 `build-complete` 进入验证
- **WHEN** 读取 `tenon status <change> --json`
- **THEN** verify 步的当前轮次是 2

#### Scenario: 回到规格后重新计数

- **GIVEN** verify 步已经验证过两轮
- **WHEN** 任务经 `requirements-changed` 回到规格步，再走到 verify 并读取 `tenon status <change> --json`
- **THEN** verify 步的当前轮次是 1

### Requirement: 上限用完后 SHALL 停止自动回退

当前轮次已达到上限、且必需测试或必需评审者不通过时：

- `next` MUST NOT 再给出这一步回退边的评审请求、选择或转换。
  - 不通过的只有评审者，或失败的必需测试都已登记豁免时，`next` SHALL 给出接受剩余阻断的评审请求（见下一条）。
  - 还有没登记豁免的失败必需测试时，`next` SHALL 给出 `stop`，说明可以先登记步骤测试豁免。
  - 两种情况都 SHALL 说明另外三条出路：用户决定调高上限后回退修复、经 `requirements-changed` 回到规格、终止任务。
  - 当前步骤没有直达规格的边时（`default` 的 verify 只有 `verify-pass` 与 `verify-fail`），回到规格这条出路 SHALL 写明真实路径：先由用户调高上限，经回退边回到回退目标步骤，再在那一步执行回到规格的事件。
- 回退边的 `tenon review request --event <事件>` 与 `tenon transition <事件>` SHALL 拒绝，并写出已用轮次、上限，以及调高上限的命令。
- 上限调高到高于当前轮次之后，回退边恢复可用；调到等于当前轮次仍算用完。
- 未达到上限时，行为 SHALL 与修改前一致。

#### Scenario: 第二轮仍不通过

- **GIVEN** verify 步上限是 2，当前是第 2 轮
- **WHEN** 一个必需评审者在当前候选上不通过
- **THEN** `next` 不再给出 `verify-fail` 的评审请求，而是给出接受剩余阻断的评审请求，并列出其他出路

#### Scenario: 上限用完时回退被拒

- **GIVEN** 同上
- **WHEN** 执行 `tenon review request <change> --event verify-fail`
- **THEN** 命令拒绝，写出「已用 2 轮 / 上限 2」与 `tenon set <change> max_rounds <N>`

#### Scenario: 调高上限后可以回退

- **GIVEN** 同上，用户让 agent 执行 `tenon set <change> max_rounds 3`
- **WHEN** 重新读 `next`
- **THEN** `next` 恢复给出 `verify-fail` 的评审请求

#### Scenario: 还有未登记豁免的失败测试

- **GIVEN** verify 步上限用完，必需测试 `code-size` 失败且计划里没有它的豁免
- **WHEN** 读取 `next`
- **THEN** `next` 给出 `stop`，说明可以先登记步骤测试豁免，以及调高上限、回到规格、终止三条出路

### Requirement: 用户 SHALL 能在上限用完后接受剩余阻断

上限用完的步骤上，前进边的 `tenon review request` SHALL 在必需评审者不通过时仍然放行。它把当前候选上结论为不通过的必需评审者，连同各自的阻断级发现，冻结为「待接受的剩余阻断」（键 `reviewer:<agent>`），并逐条列给用户。

- 用户确认这道评审门，就接受了这些剩余阻断：
  - 接受 SHALL 绑定当前代码候选与评审者那次运行。
  - 任务历史 SHALL 记下接受的评审者、运行与发现（发现数与冻结时的摘要）。
  - 列给用户与写进历史的发现摘要 SHALL 是单行、截短的，并去掉控制字符与双向覆盖字符。
- 接受之后，前进边的转换 SHALL 不再因这些评审者不通过而被拒。
- 代码变了，或评审者在新候选上重跑得出新结论，原来的接受 MUST NOT 继续生效。
- 委托确认（`--delegated`）与 AFK MUST NOT 接受剩余阻断；有待接受的剩余阻断时，委托确认 SHALL 被拒，评审保持待确认。
- 剩余阻断只覆盖评审者。失败的必需测试仍由步骤测试豁免（`tenon test waive --test`）处理，并可以在同一次评审请求里一起列出。
- 上限未用完时，必需评审者不通过，前进边的评审请求 SHALL 照旧被拒。

#### Scenario: 接受剩余阻断后前进

- **GIVEN** verify 步上限用完，`security` 评审者在当前候选上不通过
- **WHEN** 执行 `tenon review request <change> --event verify-pass`
- **THEN** 请求放行，并列出 `reviewer:security` 与它的阻断级发现
- **AND** 用户回复放行语确认后，`tenon transition <change> verify-pass` 前进到交付步
- **AND** 任务历史记下这次接受

#### Scenario: 委托确认不能接受剩余阻断

- **WHEN** 有待接受的剩余阻断时执行 `tenon review acknowledge <change> --delegated`
- **THEN** 命令拒绝，评审保持待确认

#### Scenario: 代码变了接受失效

- **GIVEN** 剩余阻断已被接受
- **WHEN** 代码改动产生新候选，评审者在新候选上重跑仍不通过
- **THEN** 前进边重新被这个评审者阻断，需要再次接受

#### Scenario: 上限未用完不放行

- **GIVEN** verify 步上限是 2，当前是第 1 轮
- **WHEN** 必需评审者不通过时执行 `tenon review request <change> --event verify-pass`
- **THEN** 请求照旧被拒，`next` 照旧给出 `verify-fail` 的评审请求

