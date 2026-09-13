# 冻结决策同步契约

## Goal

在不新增第二套持久化决策真相的前提下，冻结 review、Skill interaction、recommended-default 和 AFK 的记录域、只读待决策投影、命令映射、同步语义和归因规则。

## Scope

只更新设计/spec，不实现 Dashboard projection、HTTP command adapter 或 UI。

必须明确：

- `review_gate_status` 仍为 `pending | approved`；
- superseded/迟到回答由追加事件和 projection 推导；
- expired 明确为 deferred，未定义 canonical 依据前不进入实现；
- review receipt 的渠道字段是否作为 canonical state 新增字段，并同步 FieldName、`.pipeline.yaml` 投影和 golden fixtures；
- AFK source 通过 decision → invocation 关联取得，不能假设 decision event 自带 `adapter.kind`；
- Dashboard review adapter 未来必须调用与 CLI `review acknowledge` 同一个 application 函数，且只能消费已有 exact pending receipt；
- 该共享 application 层是 C 的前置设计约束，必须承载 binding、receipt、marker、interaction、history 和 rejected acknowledgement 的一致语义；CLI/server 只做适配，禁止 server→cli 依赖或复制编排；
- 用户模式映射为 HITL=`interactive` 或 `recommended-defaults`、AFK=`afk`；模式切换追加事件并明确生效边界，不能把切换当作回答；
- 冻结 token 威胁模型和 hook 检测信号：门禁 pending 期间读取 token/调用本地控制 API 产生脱敏告警，明确由 C 实现告警或登记独立安全子任务；
- `humanGateSatisfied: true` 单列为后续任务，不在本任务顺手修。

本任务以 A 的提交 `9f38926` 为输入；A 已关闭 transition 旁路并要求 receipt 与 binding 同时成立。B 不回退 A 的 fail-closed 语义，也不把 Dashboard 当成新的大模型交互面。

## Acceptance Criteria

- [ ] 完成记录域责任矩阵和 PendingDecisionView 推导表。
- [ ] 完成 pending/answered/consumed/superseded 的类型化判定；review consumed 必须引用 TransitionRecord 与 interaction 链，不能因 receipt 字段清空就判定 consumed；expired 为 deferred。
- [ ] 完成 expected revision、幂等、HTTP/CLI 错误语义和宿主唤醒分档。
- [ ] 明确 `review_acknowledged_via` 等 canonical 字段的影响面和迁移策略。
- [ ] 明确 AFK invocation 关联到 decision projection 的 join anchor。
- [ ] 明确两种用户模式到三种内部策略的映射、模式切换事件和待决请求行为。
- [ ] 明确同用户 bearer token 的自审批威胁模型、检测信号、告警事件 schema 和 C/后续任务的实现责任。
- [ ] 将 CLI acknowledge 编排抽取为共享 application 的接口、依赖注入和迁移顺序写入 spec，禁止 server→cli 依赖或双实现。
- [ ] 明确 C 负责共享 application 的落地、待决 projection/命令适配和告警消费；hook 侧告警写入若不能随 C 完成，登记独立 P1 安全子任务。
- [ ] 更新 kernel、server、cli hook、cross-layer 和 error-handling 相关 spec。
- [ ] 通过设计评审后，才允许启动 C。
