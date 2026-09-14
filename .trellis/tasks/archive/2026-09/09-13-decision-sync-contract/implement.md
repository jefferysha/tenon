# B 实施计划（设计/spec only）

1. 以 A 提交 `9f38926` 为基线，确认 receipt + binding、HTTP 409 和 CLI/server fail-closed 边界未漂移。
2. 更新本任务 PRD、设计和相关 `.trellis/spec`，冻结 B1-B5：canonical channel 字段顺序与迁移、投影判定与 AFK join、幂等/错误/唤醒同步、终端回答采集、模式和身份边界。
3. 使用 `task.py create` 登记 B6 的两个独立子任务：P1 review pending 自审批检测、P0 `tenon set phase` review bypass。共享 application 抽取、C 的 projection/adapter 属于后续任务；本任务不改业务 TypeScript、hooks、Dashboard 或 A 文件。
4. 运行 `python3 ./.trellis/scripts/task.py validate .trellis/tasks/09-13-decision-sync-contract` 和 `npm run check:docs`，检查 context 清单与 Markdown 链接；明确 `expired` 与 `humanGateSatisfied` 仍未实现。
5. 只有设计评审通过且上述契约已被接受后，才允许启动 C。
