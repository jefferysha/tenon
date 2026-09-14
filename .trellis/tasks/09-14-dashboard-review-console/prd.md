# 实现 Dashboard review 决策台

## Goal

接入 pending decisions 与 review adapter；不调用大模型、不回答 Skill 问题

## Requirements

- 使用现有 `pending-decisions` GET 和 `/decisions` POST；请求必须携带 expected revision 与幂等 key。
- 只允许 review acknowledge；Skill question/AFK answer 不提供 Dashboard 写入口。
- 操作完成后刷新 projection，明确展示 loading、错误、冲突和已处理状态。

## Acceptance Criteria

- [ ] Dashboard 有可访问的 review 操作控件并覆盖成功、409、重复提交和空态。
- [ ] 前端 API 只走统一 client，不出现模型调用或 token 读取。
- [ ] `npm run test:web`、`npm run typecheck:web`、`npm run build:web` 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
