# 父任务实施编排

## 顺序

1. 更新并审阅父任务与 A/B/C 子任务 artifacts。
2. 为 A 选择基于启动时冻结 HEAD 的独立 worktree，先运行 `npm ci`，再启动 A；父任务当前 checkout 不写业务代码。
3. A 完成后由主线程检查字段删除、调用方 inventory、binding 强制校验、HTTP 错误映射、CLI/server bundle freshness 和回归测试。
4. A 通过后启动 B，只更新设计/spec，不写实现；B 必须冻结共享 acknowledge application 的抽取边界、两种用户模式/三种内部策略映射、模式切换事件、AFK join 和自审批告警契约。
5. B 评审通过后启动 C，实现 projection/adapter；不带入后续 UI。
6. A/B/C 分别验证后再做父任务整体验收。

## 不属于本父任务

产物 diff、决策台、Change 回放、流程体检，以及 `humanGateSatisfied` 的独立策略修正。

## 发布与验证原则

- 本父任务不会在当前工作区直接提交业务代码；具体 dirty inventory 以启动时记录为准。
- A 的回滚是整个提交回滚且不得发布，不把恢复旁路作为正常回滚方案。
- 任何 kernel 变更都必须 `npm run build`，并通过 CLI/server dist 逐字节 freshness 检查。
