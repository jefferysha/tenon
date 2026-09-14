# 实现 pending review 自审批检测

## Goal

实现 token/local API pending review 检测、脱敏审计信号和 hook 测试

## Requirements

- 仅在 pending review 期间匹配 token 文件读取和 localhost 控制写请求；禁止宽泛匹配普通文本或任意网络请求。
- 产生脱敏 append-only 信号，包含 Change、phase/event、request anchor、channel、process/host hash、时间和 operation；绝不记录 token 内容。

## Acceptance Criteria

- [ ] 精确匹配、误报、过期/缺失 marker、损坏输入均有测试。
- [ ] 写入复用 Change lock，信号失败不放行 review，也不改变 canonical receipt。
- [ ] Dashboard 不调用模型或 Skill answer API。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
