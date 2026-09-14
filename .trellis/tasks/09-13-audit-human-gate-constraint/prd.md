# 审计 humanGateSatisfied 自动化约束语义

## Goal

确认 server transition context 中固定 `humanGateSatisfied: true` 是否符合 loop/automation policy，避免把 automation constraint 的人类门禁误判为始终满足。

## Requirements

- 只审计 `packages/server/src/transition.ts`、kernel automation constraint evaluator 及其调用方/测试。
- 明确该字段与 review receipt 的边界。
- 若语义不成立，另行设计 fail-closed 修复；不在 review-bypass、decision projection 或 Dashboard 任务中顺带修改。

## Acceptance Criteria

- [ ] 给出当前固定值的调用链、适用 policy 和测试证据。
- [ ] 明确是否需要改为真实 capability/receipt 输入。
- [ ] 若需要实现，形成独立设计和验证计划；若无需修改，记录理由和不变量。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
