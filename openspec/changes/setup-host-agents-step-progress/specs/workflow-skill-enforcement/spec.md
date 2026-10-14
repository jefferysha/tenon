# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Hook and transitions SHALL reject a missing current-visit phase Skill

default Hook、CLI transition 与 HTTP transition SHALL 使用同一 effective required/available
projection。除精确根编排入口 `tenon` 外，当前 phase requirement 未完成时，Hook SHALL 拒绝 overlay
Skill 及未声明的可选 Skill；phase requirement 本身 SHALL 可作为首个调用。CLI 与 HTTP transition
SHALL 在缺少同 Change、同 phase、当前 step visit 的完成态 receipt 时以相同 incomplete-Skill reason
拒绝。离开步骤的退回边（direction 为 back）SHALL NOT 要求本步中归属执行者或评审者 agent 的 Skill
（这类 Skill 只能在该 agent 运行期间加载）；不归属任何 agent 的主线 Skill 在退回边上仍按上述规则要求。
`tenon status` / `tenon check` 的出口报告 SHALL 与 transition 的判定一致。

#### Scenario: Hook 负例不能由可选 Skill 绕过

- **GIVEN** free/default 当前 visit 尚无 `test-driven-development` receipt
- **WHEN** 调用任一非根入口 Skill
- **THEN** Hook 返回拒绝并指出缺少 `test-driven-development`
- **WHEN** 当前 visit 产生有效 `test-driven-development` receipt
- **THEN** 未受其他 DAG 约束的可选 Skill 可继续调用。

#### Scenario: CLI 与 HTTP transition 同时失败关闭

- **GIVEN** free/default 当前 phase 的 documents、review 与其他 guards 已满足
- **BUT** 当前 visit 缺少 phase Skill receipt
- **WHEN** CLI 或 HTTP 请求离开该 phase
- **THEN** 两条路径均拒绝且不写 canonical state
- **AND** 旧 visit、其他 phase 或其他 Change 的 receipt 均不能满足要求。

#### Scenario: 退回边不要求执行者的 Skill

- **GIVEN** default 工作流的任务刚进入实现步，`test-driven-development` 归执行者 `builder`，本 visit 尚未开始任何 builder 运行
- **WHEN** 通过 CLI 或 HTTP 执行 `requirements-changed`
- **THEN** 流转成功，回到规格步
- **AND** 前进边 `build-complete` 仍因缺少 `test-driven-development` 而被拒绝
