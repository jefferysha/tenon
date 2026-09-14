# C 设计：Dashboard review 决策台

## 已裁决边界

- Dashboard 只展示现有 pending review，并调用 server 的 review adapter 批准；不调用大模型，不创建 prompt，不回答 Skill 问题，不写 AFK 决策。
- 驳回和退回继续由终端完成。当前 receipt 只绑定一个 exact event，Dashboard 不新增 decline 协议，也不伪造 rejected 状态。
- 决策台放在工作台右栏的任务详情中，与该 Change 的产物和阶段上下文同屏；不恢复旧 Inbox/AFK/Loops 页面。

## 数据流

1. `GET /api/change/:name/pending-decisions?root=` 通过共享 `readPendingDecisionProjection` 读取 canonical revision、interaction、invocation 和 transition chain。
2. 页面只选择 `type=review` 且 `status=pending` 的条目，显示 exact phase/event、证据和当前 revision。
3. 批准调用 `POST /api/change/:name/decisions`，请求包含 root、ref、expected_revision 和一次性 idempotency key。server 在 Change lock 内调用共享 review application，channel 固定为 `dashboard`。
4. 成功后重新 GET 并刷新任务快照；409 只显示服务端稳定 code 并要求刷新，不在浏览器本地推断或改写 canonical 状态。

## 安全与一致性

- POST 只接受 review acknowledge；没有 pending receipt、binding 不匹配、revision 冲突或 idempotency 冲突都不会写 canonical approval。
- server 复用 CLI 的 binding verifier 和共享 application；marker 清理失败只返回 200 + deferred warning。
- Dashboard 使用同源 token 作为 API 鉴权凭证，但 token、模型调用和 agent 对话不进入 Dashboard 代码路径。

## 当前实现映射

- API：`packages/dashboard-app/src/api/decisionClient.ts`
- 面板：`packages/dashboard-app/src/workspace/ReviewDecisionPanel.tsx`
- 工作台接入：`packages/dashboard-app/src/workspace/TaskDetailPane.tsx`
- server adapter：`packages/server/src/serverPostDecisionRoutes.ts`
- 共享应用：`packages/kernel/src/decision/review-application.ts`
