# 关闭 review transition 旁路

## Goal

移除服务端 review transition 的无条件 `humanReviewApproved` 豁免，防止持有同用户 Dashboard token 的调用方绕过 canonical review receipt；保留普通 transition API。

## Scope

- 删除 `TransitionCommand.humanReviewApproved` 类型字段及 kernel 分支和 receipt-only fallback。
- 删除 server adapter 对该字段的传值和“Dashboard 点击等同 host-bound approval”的误导性注释。
- 保留 `POST /api/change/:name/transition` 路由；review-gated transition 无 exact receipt 或 binding 不匹配时由现有映射返回 HTTP 409 和 `{ ok:false, code:'review-approval-required', error }`。
- server 复用 kernel 导出的 binding reader/matcher，与 CLI 采用同一校验；不得导入 CLI 包。
- 不新增 Dashboard 审批 UI、不实现 B/C projection、不接大模型。
- 记录 `humanGateSatisfied: true` 为后续独立任务，不在本任务修改其 automation constraint 语义。

## Test inventory and fixture plan

受影响的 review route 样本只有以下几类：

- `packages/server/src/server.test.ts:1230`（spec-complete，含 `auto_enqueue: queued`）、`:1335`、`:1572`、`:1670`（explore-complete）：准备 exact pending→approved receipt 和匹配 binding。
- `packages/server/src/transition-concurrency.test.ts:81`：当前在第一次 `open→explore` breadcrumb 锁仍持有时启动第二次 `explore→spec`；不能在锁尾部机械写 receipt，否则会死锁。调整测试编排，或使用不带 review 门禁的自定义两步 workflow 保留并发锁目的；另增加独立的 approved+matching-binding server 200 样本。
- `packages/server/src/transition-concurrency.test.ts:126`（verify-fail）：已有 approved receipt，但必须补匹配 binding 后作为 server route 200 回归。
- kernel `transition-application.test.ts` 中所有 approved fixtures（研究清单包含 486、602、657、1016、1077、1122 等）也必须提供 binding verifier，或改用可复用的 approved+binding fixture；已有“删 binding 应拒绝”的 negative test 保留。

以下保持原样并运行回归确认：`packages/server/src/server.test.ts:1129` 的 `verify-build-revision-untrusted` 409 不依赖 review bypass；`packages/dashboard-app/src/api/serverIntegration.test.tsx:223` 是无 token 401，鉴权阶段失败，且该文件真正 transition 调用是非门禁的 `open-complete`。

CLI `packages/cli/src/commands/transition.ts:209` 的 `enqueueAfterSpecComplete` 链不依赖 server bypass，必须保持不变。

## Acceptance Criteria

- [ ] `humanReviewApproved` 从生产 command type、server adapter 和 kernel transition branch 完整删除。
- [ ] review-gated transition 无 receipt 返回 HTTP 409，body code 为 `review-approval-required`，不写 transition/history/projection。
- [ ] approved receipt 缺失 binding，或 binding 与当前 phase/event/revision/digest 不匹配时统一 fail closed，返回 HTTP 409 `review-approval-required`，不产生任何状态或历史副作用。
- [ ] 有 exact phase/event receipt + matching binding 时 CLI 和 server route 均可正常 transition；server 200 回归覆盖 `verify-fail`。
- [ ] 非 review transition 的 server 行为不变。
- [ ] 上述受影响测试逐一完成 fixture/编排调整；两项不受影响测试保持原断言并通过。
- [ ] 生产源码和生成 dist 中 `humanReviewApproved` 零命中；历史 `docs/superpowers/specs/2026-07-30-review-handshake-*.md` 保留并加入“字段已废弃、不可作为当前行为依据”的注记。
- [ ] `npm run build` 后 CLI 与 server dist 均重建；按 CI 原命令检查 `git diff --exit-code -- packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs`，再运行 `npm run check:dashboard-dist-freshness`。
- [ ] 回滚定义为整个提交回滚并停止发布，不恢复旁路参数。
