# C：Dashboard review 决策台

## 目标

让用户在工作台右栏批准一个已经由终端发起、绑定 exact event 的 review request。Dashboard 仍是只读控制台加 review 控制适配器，不承担任何大模型交互。

## 范围

- pending review 列表与批准按钮；显示 `review-approval-required`、`revision-conflict`、`idempotency-conflict`。
- Dashboard 只调用 review adapter，不调用模型、不回答 Skill 问题、不写 AFK 决策。
- 驳回和退回仍只在终端执行；本任务不新增 decline 命令。
- 位置固定为工作台右栏任务详情，不恢复旧 Inbox/AFK/Loops 页面。

## 验收

- [x] F1/F2/H 前置任务已合入并由主线程复核。
- [x] 真实 receipt + revision 流程可从列表批准；server 使用共享 GET/POST 投影输入并刷新列表。
- [x] 冲突、重复、损坏 idempotency ledger、binding 不匹配均有稳定错误映射且不产生 canonical 部分写入。
- [x] Dashboard 面板、API client、server route 有定向测试；`npm run typecheck:web`、`npm run test:web`、`npm run build:web` 在交付门禁中验证。
- [x] 面板代码不导入模型、Skill、AFK producer 或终端命令；架构检查通过。
