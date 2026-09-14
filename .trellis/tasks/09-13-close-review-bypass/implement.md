# A 实施计划

1. 在独立 worktree 基于启动时冻结 HEAD 建立分支，保存进入时的 HEAD、实际 dirty inventory 和构建版本；先运行 `npm ci`。
2. 全仓搜索 `humanReviewApproved`、`postTransition`、transition endpoint 和相关注释，区分生产源码/dist、测试与历史 spec 的删除或 deprecated 注记范围。
3. 删除 command 字段、kernel 分支、server 传值及误导性注释；删除 kernel 的 receipt-only fallback，令 binding 成为所有 review-gated caller 的必需条件。
4. server 复用 kernel 的 binding reader/matcher，不得导入 CLI；补齐 `verify-fail` 的 sidecar binding，并为 `explore-complete` 并发测试采用不持锁写 receipt 的编排（或 non-review custom workflow），另测 approved+matching-binding 的 server 200。更新所有 kernel approved fixtures，保留缺 binding 的 negative test。
5. 保持 CLI transition 和 `enqueueAfterSpecComplete` 链不变，新增/更新非 review transition 回归。
6. 运行定向 Vitest；运行 `npm run build` 同时重建 CLI/server dist；执行 `git diff --exit-code -- packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs`，再运行 `npm run check:dashboard-dist-freshness`。
7. 主线程逐项检查 diff，确认没有删除 route、没有修改 `humanGateSatisfied`、没有混入父任务 B/C。

## 验证

- `npx vitest run packages/kernel/src/workflow/transition-application.test.ts packages/server/src/server.test.ts packages/server/src/transition-concurrency.test.ts packages/dashboard-app/src/api/serverIntegration.test.tsx`
- `npx vitest run packages/cli/src/commands/review.integration.test.ts packages/cli/src/commands/transition.test.ts`
- `npm run build`
- `git diff --exit-code -- packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs`
- `npm run check:dashboard-dist-freshness`
- `npm run test:web`
- `bash tools/test-hooks.sh`
- CI 同款 architecture checks（以仓库脚本实际名称为准）

## 回滚点

提交级回滚并停止发布；不恢复任何 `humanReviewApproved` 参数或分支。
