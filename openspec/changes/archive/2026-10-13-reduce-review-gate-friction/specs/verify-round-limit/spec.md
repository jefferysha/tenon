# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 轮次内回退 SHALL 不需要评审回执

受轮次上限约束的步骤（设了评审门且至少有一条回退边）上，当前轮次还没达到上限时，离开这一步的回退边 SHALL 不需要已批准的评审回执即可转换。

- 回退边指既不是前进边、也不是放弃边（如 `scope-expanded`）的出边。前进边、放弃边的人工确认要求不变。
- 判定 SHALL 在 CLI 与 Dashboard 共用的转换用例里、同一把 Change 锁内完成，与「上限用完后回退被拒」读同一份轮次。宿主没有提供轮次读取时，回退边 SHALL 照旧要求评审回执。
- `next` SHALL 对唯一的回退边直接给出 `transition`，不再给出它的评审请求或等待；有多条回退边时仍给出选择。
- 在轮次内对回退边执行 `tenon review request --event <回退事件>` SHALL 仍然被接受（兼容已有流程），但 `next` 不再给出它。
- 这次转换没有人工确认发生，SHALL NOT 记录「评审确认」类的交互效果。

#### Scenario: 第一轮验证不通过直接回到实现

- **GIVEN** `default` 工作流的 verify 步上限是 2，当前是第 1 轮
- **WHEN** 一个必需评审者在当前候选上不通过，读取 `tenon status <change> --json`
- **THEN** `next` 是 `transition verify-fail`
- **AND** 执行 `tenon transition <change> verify-fail` 成功回到 build，期间不需要评审请求与用户确认

#### Scenario: 前进边仍要确认

- **GIVEN** 同上，但所有必需测试与评审者都通过
- **WHEN** 没有已批准回执时执行 `tenon transition <change> verify-pass`
- **THEN** 转换被拒，要求先发起 `verify-pass` 的评审请求并由用户确认

#### Scenario: 宿主没有接线轮次读取

- **GIVEN** 一个调用转换用例却没有提供轮次读取的宿主
- **WHEN** 对受约束步骤的回退边发起转换且没有已批准回执
- **THEN** 转换被拒，要求评审回执

## MODIFIED Requirements

### Requirement: 上限用完后 SHALL 停止自动回退

当前轮次已达到上限、且必需测试或必需评审者不通过时：

- `next` MUST NOT 再给出这一步回退边的评审请求、选择或转换。
  - 不通过的只有评审者，或失败的必需测试都已登记豁免时，`next` SHALL 给出接受剩余阻断的评审请求（见下一条）。
  - 还有没登记豁免的失败必需测试时，`next` SHALL 给出 `stop`，说明可以先登记步骤测试豁免。
  - 两种情况都 SHALL 说明另外三条出路：用户决定调高上限后回退修复、经 `requirements-changed` 回到规格、终止任务。
  - 当前步骤没有直达规格的边时（`default` 的 verify 只有 `verify-pass` 与 `verify-fail`），回到规格这条出路 SHALL 写明真实路径：先由用户调高上限，经回退边回到回退目标步骤，再在那一步执行回到规格的事件。
- 回退边的 `tenon review request --event <事件>` 与 `tenon transition <事件>` SHALL 拒绝，并写出已用轮次、上限，以及调高上限的命令。
- 上限调高到高于当前轮次之后，回退边恢复可用，并且同样不需要评审回执；调到等于当前轮次仍算用完。
- 未达到上限时，回退边 SHALL 按「轮次内回退 SHALL 不需要评审回执」处理，其余行为与修改前一致。

#### Scenario: 第二轮仍不通过

- **GIVEN** verify 步上限是 2，当前是第 2 轮
- **WHEN** 一个必需评审者在当前候选上不通过
- **THEN** `next` 不再给出 `verify-fail` 的评审请求或转换，而是给出接受剩余阻断的评审请求，并列出其他出路

#### Scenario: 上限用完时回退被拒

- **GIVEN** 同上
- **WHEN** 执行 `tenon review request <change> --event verify-fail` 或 `tenon transition <change> verify-fail`
- **THEN** 命令拒绝，写出「已用 2 轮 / 上限 2」与 `tenon set <change> max_rounds <N>`

#### Scenario: 调高上限后可以回退

- **GIVEN** 同上，用户让 agent 执行 `tenon set <change> max_rounds 3`
- **WHEN** 重新读 `next`
- **THEN** `next` 恢复给出 `transition verify-fail`
- **AND** 执行它不需要评审回执

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
- **THEN** 请求照旧被拒，`next` 给出 `transition verify-fail`
