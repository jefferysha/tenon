# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 失败的必需步骤测试 SHALL 只能经评审批准的计划豁免放行

工作流在步骤里声明的测试（步骤测试，如验证步的 `code-size`）失败时，任务的测试计划 SHALL 能登记一条针对该测试 id 的豁免（键 `test:<id>`），与种类豁免、追溯条目豁免同一机制：豁免写在测试计划里，`approved_by` 只由同一次评审确认写入。

- 豁免 SHALL 只覆盖该测试在当前候选上的**新鲜失败记录**：
  - 已批准：失败不再阻塞出口；判定里该测试显示为「已豁免」，并保留失败原因与豁免理由。
  - 未批准：以「豁免待批准」阻塞代替「测试失败」阻塞。评审请求时放行并把这条豁免连同理由列给用户；转换时仍要求它已批准。
- 豁免 MUST NOT 放行未运行、运行中或已过期的步骤测试：这些情况照旧阻塞，要求先在当前候选上跑一次。
- 批准 SHALL 绑定被批准时那条失败记录所在的代码候选。
  - `tenon review request` 冻结清单时记下该失败记录的候选；用户确认时，候选随批准人一起写进测试计划。
  - 之后代码变了、同一测试再次失败，豁免 MUST 回到「待批准」，而不是继续放行。
  - 旧版本留下、没有候选的批准，同样按「待批准」处理。
  - 比较口径与测试新鲜度判定相同：失败记录的候选、宿主当前候选或它的可移植孪生，任一相等即为同一份代码。
- 批准与被批准的候选都不计入测试计划的摘要，所以批准本身不会让之前的运行过期。
- 委托确认（`--delegated`）MUST NOT 批准任何豁免。
- 没有豁免的步骤测试，失败时的行为 SHALL 与修改前一致。

#### Scenario: 已批准的豁免放行新鲜的失败

- **WHEN** 验证步的必需测试 `code-size` 在当前候选上失败（`metric-threshold`），且计划里 `test:code-size` 的豁免已经评审批准
- **THEN** 该测试不构成出口阻塞
- **AND** 判定与报告把它显示为已豁免，并写出失败原因与豁免理由

#### Scenario: 未批准的豁免随评审请求列出

- **WHEN** 同一失败的测试有豁免、但尚未批准
- **THEN** 出口阻塞是「豁免待批准」而不是「测试失败」
- **AND** `tenon review request` 列出 `test:code-size` 与理由
- **AND** 用户确认这道评审门之前，`tenon transition` 拒绝前进

#### Scenario: 豁免不免除运行

- **WHEN** 测试有已批准的豁免，但没有运行记录、正在运行或记录已过期
- **THEN** 照旧以未运行或过期阻塞，并给出重跑命令

#### Scenario: 批准后代码变了要重新批准

- **GIVEN** `test:code-size` 的豁免已在候选 A 上批准，评审已确认
- **WHEN** 代码改成候选 B，重跑 `code-size` 仍然失败
- **THEN** 豁免回到待批准，转换被拒
- **AND** `next` 给出 `fix`，点名先用 `tenon review revoke` 撤回这次确认；随后的 `review request` 再次列出 `test:code-size`，用户确认后写入候选 B

#### Scenario: 没有豁免时行为不变

- **WHEN** 必需步骤测试失败且计划里没有它的豁免
- **THEN** 阻塞仍是「测试失败」，`next` 仍要求改代码后重跑

### Requirement: 步骤测试豁免 SHALL 通过 `tenon test waive --test` 登记并校验测试 id

`tenon test waive <change> --test <id> --reason <理由>` SHALL 只接受本任务冻结工作流计划里某个步骤声明的测试 id，否则以退出码 2 拒绝并列出可用的 id。

- `--test`、`--kind`、`--covers` SHALL 恰好给一个；`--reason` 必填，长度上限与其他豁免相同。
- `tenon test unregister <change> --waiver test:<id>` SHALL 撤销这条豁免。
- `tenon test plan <change>` SHALL 显示它的批准状态与理由。

#### Scenario: 登记步骤测试豁免

- **WHEN** 执行 `tenon test waive <c> --test code-size --reason "<理由>"`，且 `code-size` 是冻结计划里的步骤测试
- **THEN** 测试计划新增未批准的 `test:code-size` 豁免

#### Scenario: 未知的测试 id 被拒绝

- **WHEN** 给出的 id 不是任何步骤声明的测试
- **THEN** 命令以退出码 2 拒绝并列出可用的 id，计划不变

#### Scenario: 与其他豁免互斥

- **WHEN** `--test` 与 `--kind` 或 `--covers` 同时给出
- **THEN** 命令拒绝执行，计划不变

### Requirement: 步骤编排 SHALL 把带豁免的失败步骤测试导向评审而不是重跑

步骤编排（`tenon status` 的 `next`）SHALL 把带豁免的失败步骤测试交给评审处理，而不是要求重跑：

- 必需步骤测试新鲜失败、且有豁免时，`tenon status` 的 `next` MUST NOT 再要求 `run-test`，也 MUST NOT 把它算作「必需证据失败」而只给回退边。
  - 豁免待批准：照常走后续动作（评审者、评审请求），评审请求列出这条豁免。
  - 豁免已批准且评审已确认：可以转换。
- 读测试结果的评审者（`reads_tests`）的派发提示里，SHALL 在该测试结果下写明豁免的状态（已批准 / 待评审批准）与理由；没有豁免时提示词不变。
- 豁免理由由登记者写，常是执行者 agent。它出现在评审者提示与 `test-waived` 提示里时，SHALL 做以下处理：
  - 标注为「登记者自述、未经核实」；
  - 折成单行，超过 200 个字符截断并加 `…`；
  - 反引号与尖括号换成全角字符，不能伪造代码块或标签。
- Dashboard 的测试快照 SHALL 带上豁免状态：已豁免算完成，待批准算等待，不再显示为失败。

#### Scenario: 待批准豁免不再卡在重跑

- **WHEN** 验证步的 `code-size` 新鲜失败且豁免待批准，其余证据齐备
- **THEN** `next` 给出评审者或 `request-review`，不是 `run-test code-size`
- **AND** `request-review` 的待批准豁免里有 `test:code-size`

#### Scenario: 代码规模评审者看到豁免

- **WHEN** 派发读 `code-size` 结果的代码规模评审者，且计划里有 `test:code-size` 豁免
- **THEN** 提示词的测试结果下有一行写明豁免状态与理由，并标注理由为登记者自述、未经核实

#### Scenario: 理由不能伪造提示结构

- **WHEN** 豁免理由含换行、反引号或尖括号，且长于 200 个字符
- **THEN** 评审者提示里的豁免行只有一行，反引号与尖括号已换成全角，超出部分截断并以 `…` 结尾
