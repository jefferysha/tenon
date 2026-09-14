# 修复 server human gate 语义

## Goal

移除 server transition 的 humanGateSatisfied 硬编码，与 CLI 统一并补回归测试

## Requirements

- `humanGateSatisfied` 不能写死为 true。HITL 模式只能在真实终端/委托 review receipt 已存在时满足；AFK 模式必须保持 false。
- server 与 CLI 使用同一可注入的模式/证据判定，不能读取 token 来假设人类身份。

## Acceptance Criteria

- [ ] server transition 不再包含 `humanGateSatisfied: true`。
- [ ] HITL/AFK 回归测试覆盖，且失败时零 transition/history 副作用。
- [ ] build、architecture、dist freshness 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
