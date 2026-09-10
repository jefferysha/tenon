# 技能产出自动登记与每回合技能状态

## Goal

运行时：技能调用结束后自动检测其写出的文件并匹配当前阶段的输出槽位，自动登记到文档台账（producer=该技能），下一阶段的输入自动就绪；快照暴露每阶段每技能的调用状态（未开始 / 进行中 / 完成 / 失败、并行波次），工作台按此展示。

## Background

- 现状：文档登记靠技能 / 代理执行 `tenon document record <change> <kind> <path> --producer <skill>`；漏登记就出现「缺 proposal」。
- 已有基础：`hooks/skill-tracker.sh`（PostToolUse 记录 Skill 调用到 `.pipeline-history.jsonl`）、`kernel/skill-invocation`（调用事件 + 文档确认）、文档台账（`state/document-ledger`）、工作流定义的输出槽位（父任务物化 IO）。
- 父任务：`09-10-dashboard-workflow-schema-redesign` 提供定义规范与展示面；本任务只做运行时。

## Requirements

- R1 技能调用边界：PreToolUse(Skill) 记开始快照（工作树跟踪文件的 mtime/hash 摘要），PostToolUse(Skill) 记结束；两者之间新增 / 修改的文件为该技能的候选产出。Codex 的 `CodexSkillRead` 证据按同一方式处理。
- R2 匹配规则：候选文件按当前阶段的输出槽位匹配——文档 kind 用其规范路径模式（`openspec/changes/<change>/proposal.md`、`docs/superpowers/specs/*-design.md` …，来源 `documents/document-presentation-registry`）；值槽位不自动登记。匹配成功即写台账（producer = 该技能，附 hash），已有记录内容变化则更新为 stale→recorded。
- R3 不确定匹配（多文件命中同一槽位、路径不在模式内）不自动登记，进入「待确认」列表，由 `tenon document record` 或工作台之外的确认命令处理；绝不猜。
- R4 下一阶段输入就绪 = 上游槽位台账状态为 recorded；转换守卫沿用现有文档策略，无新守卫类型。
- R5 快照新增 `skillRuns`：按阶段列出每个技能的 `status: idle | running | done | failed`、开始 / 结束时间、所属并行波次（来自定义 `depends_on`）；工作台阶段视图按波次分列显示技能状态。
- R6 热路径约束：hooks 仍为纯 bash 快速路径，重活交给 `tenon` 内部命令；单次 PostToolUse 增量 ≤ 50ms（无候选文件时）。

## Acceptance Criteria

- [ ] AC1 在 default 工作流 explore 阶段执行 brainstorming 生成 `docs/superpowers/specs/x-design.md` 后，台账自动出现 `superpower-design`（producer=brainstorming），工作台该槽位显示「已登记」。
- [ ] AC2 同一技能写出两个匹配同一槽位的文件时不登记，快照 `documents.pending[]` 列出候选，工作台显示待确认。
- [ ] AC3 快照 `skillRuns` 对运行中的技能给出 running，结束后 done；并行技能处于同一波次。
- [ ] AC4 hooks 测试（`npm run test:hooks`）与 kernel / server 测试全绿；无候选文件时 PostToolUse 增量在预算内。

## Notes

- 依赖父任务的物化 IO 契约（`effectiveIo`）与输出槽位模型；父任务完成后再 `task.py start`。
