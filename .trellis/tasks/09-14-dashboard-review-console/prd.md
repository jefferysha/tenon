# C：Dashboard review 决策台（暂停）

## 当前状态

暂缓启动。现有集成版存在真实流程阻塞：GET/POST pending projection 输入不一致，且 server acknowledge 编排存在提交顺序、错误映射和 binding 缺口。必须等待 F1、F2、H 完成并通过主线程验收后恢复。

## 范围

- pending review 列表与批准按钮；显示 `review-approval-required`、`revision-conflict`、`idempotency-conflict`。
- Dashboard 只调用 review adapter，不调用模型、不回答 Skill 问题、不写 AFK 决策。
- 驳回语义待用户裁决：终端专用，或新增只追加 rejected 记录的 decline 命令；未裁决前不得设计 UI。
- 位置待用户裁决：工作台右栏或独立视图；未裁决前不写 design。

## 验收

- [ ] F1/F2/H 前置任务已合入并由主线程复核。
- [ ] 真实 receipt + revision 流程可从列表批准并刷新为 consumed。
- [ ] 冲突、重复、过期 revision 强制刷新且不产生部分写入。
- [ ] 前端测试、类型检查、构建和真实浏览器 smoke 通过。
