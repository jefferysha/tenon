# 技能产出自动登记与每回合技能状态

## Goal

运行时：技能调用结束后自动检测其写出的文件并匹配当前阶段的输出槽位，自动登记到文档台账（producer=该技能），下一阶段的输入自动就绪；快照暴露每阶段每技能的调用状态（未开始 / 进行中 / 完成 / 失败、并行波次），工作台按此展示。

## Background

- 现状：文档登记靠技能 / 代理执行 `tenon document record <change> <kind> <path> --producer <skill>`；漏登记就出现「缺 proposal」。
- 已有基础：`hooks/skill-tracker.sh`（PostToolUse 记录 Skill 调用到 `.pipeline-history.jsonl`）、`kernel/skill-invocation`（调用事件 + 文档确认）、文档台账（`state/document-ledger`）、工作流定义的输出槽位（父任务物化 IO）。
- 父任务：`09-10-dashboard-workflow-schema-redesign` 提供定义规范与展示面；本任务只做运行时。

## Requirements

- R1 技能调用边界：PreToolUse(Skill) 写 `tool-start` 标记，PostToolUse(Skill) 写 `tool` 完成证据（已有）；完成回执落地后按当前阶段契约检查该技能应产出的规范路径。不做工作树 mtime/hash 快照（设计缩水：只认规范路径，不扫全树）。
- R2 匹配规则：文档 kind 用其规范路径模式（`openspec/changes/<change>/proposal.md`、`docs/superpowers/specs/<change>-design.md` …，来源 `documents/document-presentation-registry`）；值槽位不自动登记。存在且未登记 / 内容已变 → 写台账（producer = 该技能，附 hash）。
- R3 不在规范路径内的文件不自动登记、不猜；仍由 `tenon document record` 手工登记。不做「待确认」列表。
- R4 下一阶段输入就绪 = 上游槽位台账状态为 recorded；转换守卫沿用现有文档策略，无新守卫类型。
- R5 快照新增 `skillRuns`：按阶段列出每个技能的 `status: idle | running | done` 与所属并行波次（来自定义 `depends_on`）；矩阵技能按 change 轨道过滤；工作台阶段视图按波次分列显示。
- R6 热路径约束：hooks 仍为纯 bash 快速路径，重活交给 `tenon` 内部命令（登记发生在已有的 receipt 调用里，不新增 node 进程）。

## Acceptance Criteria

- [x] AC1 default 工作流 open 阶段 openspec-propose 回执后，台账自动出现 `proposal`（producer=openspec-propose）；工作台该槽位显示「已登记」（cli 集成测试 + 台账状态复用既有展示）。
- [x] AC2（改）非规范路径文件不登记；同一 kind 多规范路径（delta-spec 每 capability 一份）各自登记。
- [x] AC3 快照 `skillRuns` 对运行中的技能给出 running，结束后 done；并行技能处于同一波次。
- [x] AC4 hooks 测试（skill-start 用例）与 kernel / server / cli 相关测试全绿。

## Notes

- 依赖父任务的物化 IO 契约（`effectiveIo`）与输出槽位模型；父任务完成后再 `task.py start`。
