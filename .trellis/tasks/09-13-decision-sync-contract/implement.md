# B/C 实施记录

1. 以 A 提交 `9f38926` 为基线，确认 receipt + binding、HTTP 409 和 CLI/server fail-closed 边界未漂移。
2. 更新本任务 PRD、设计和相关 `.trellis/spec`，冻结 canonical channel 字段影响面、AFK join、状态推导证据、HTTP/CLI 错误语义、共享 acknowledge application 抽取边界、模式切换事件和自审批告警契约。
3. C 已落地共享 review application、待决 projection、review/Skill/AFK command adapter、HITL/AFK 模式切换、持久化幂等和脱敏自审批审计；Dashboard 仍无任何大模型交互。
4. 运行 `python3 .trellis/scripts/task.py validate .trellis/tasks/09-13-decision-sync-contract`，检查 context 清单与 spec 路径；执行构建、定向测试、web、hooks、架构和 tracked dist freshness 验证。
5. 保留两个明确后续边界：`expired` 尚无 canonical 依据；`humanGateSatisfied` 硬编码约束另立任务处理。
