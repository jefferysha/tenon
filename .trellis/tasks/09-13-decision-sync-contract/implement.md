# B 实施计划（设计/spec only）

1. 以 A 提交 `9f38926` 为基线，确认 receipt + binding、HTTP 409 和 CLI/server fail-closed 边界未漂移。
2. 更新本任务 PRD、设计和相关 `.trellis/spec`，冻结 canonical channel 字段影响面、AFK join、状态推导证据、HTTP/CLI 错误语义、共享 acknowledge application 抽取边界、模式切换事件和自审批告警契约。
3. 共享 application 的抽取、C 的待决 projection/命令适配和告警消费是后续实现责任；本任务不改业务 TypeScript、hooks、Dashboard 或 A 文件。
4. 运行 `python3 .trellis/scripts/task.py validate .trellis/tasks/09-13-decision-sync-contract`，检查 context 清单与 spec 路径；执行可用的 Markdown/文档 lint，并记录未实现的 `expired` 与 `humanGateSatisfied` 边界。
5. 只有设计评审通过且上述契约已被接受后，才允许启动 C。
