# 实施计划

## 0. 准备

- 基线提交本任务规划文件；为 G/S/D/C 各建 worktree（`../tenon-local-dh-{gate,self,core,ui}`，分支 `codex/dh-*`），各自 `npm ci`。

## 1. 并行实施（trellis-implement，每包一个 agent，禁止 git commit）

| 包 | 主要文件 | 定向验证 |
|---|---|---|
| G | `packages/server/src/transition.ts`、`packages/cli/src/commands/transition.ts`、相关测试、decision-sync.md 安全节 | `npx vitest run packages/server/src/server.test.ts packages/server/src/transition-concurrency.test.ts packages/cli/src/commands/transition.test.ts packages/kernel/src/loops` |
| S | `hooks/gate.sh`、`packages/cli/src/commands/internalSelfApproval.ts`、`packages/kernel/src/decision/self-approval*.ts`、`tools/check-architecture.mjs`、hook 测试 | `bash tools/test-hooks.sh`；`npx vitest run packages/kernel/src/decision packages/cli/src/commands` 中相关文件；`npm run check:architecture` |
| D | `packages/kernel/src/decision/*`、`packages/server/src/serverPostDecisionRoutes.ts`、`decisionProjection.ts`、`packages/cli/src/commands/review*.ts`、`interaction-emitter.ts`、`packages/kernel/src/state/*`（import-legacy、codec 注释）、`serverPostExecutionRoutes.ts` 注释、spec A–K | `npx vitest run packages/kernel/src/decision packages/kernel/src/state packages/kernel/src/types.test.ts packages/kernel/src/workflow/transition-application.test.ts packages/server/src/serverDecisionRoutes.test.ts packages/server/src/server.test.ts packages/cli/src/commands/review.integration.test.ts packages/cli/src/commands/transition.test.ts` |
| C | `packages/dashboard-app/src/api/decisionClient.ts`、`transport.ts`、`workspace/ReviewDecisionPanel.tsx`、i18n、测试 | `npm run typecheck:web`、`npm run test:web`、`npm run check:design-scale` |

各包 agent 允许本地 `npm run build` 以跑测试，但交付前 `git checkout -- packages/cli/dist packages/server/dist packages/dashboard-app/dist`（dist 由主线程统一重建）。

## 2. 逐包检查与合入

- 每包 trellis-check → 主线程审阅 diff → 在包分支提交 → 按 D、G、S、C 顺序合入 `codex/decision-control-hardening`，解决冲突后重跑该包定向验证。

## 3. 统一重建与全量验证（CI 同等）

```
npm run build
git diff --exit-code -- packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs   # 先提交 dist 后再确认
npm run check:dashboard-dist-freshness
npm run check:openspec && npm run check:comments && npm run check:architecture && npm run check:identity
npm run check:repository-hygiene && npm run check:npx-package && npm run check:legacy-bridge && npm run check:default-workflow-freshness
npm run check:docs && npm run check:document-templates && npm run check:design-scale
npm run typecheck:web && npm run test:web
bash tools/test-hooks.sh && bash tools/test-adapters.sh && bash tools/verify-skills.sh && npm run test:migration-cas
npm test   # 失败文件单独重跑；与 f1635aa 基线日志对比，区分 新引入 / 基线已有 / flaky
golden oracle（tools/oracle/run.sh）
```

基线已有且与本任务无关的失败只记录，不在本任务修复。

## 4. 收尾

- trellis-update-spec：decision-sync.md（D/E/G/K 修订、human gate、观测）、hook-guidelines.md、server/kernel error-handling.md、CLI 退出码。
- 任务记录：父任务验收勾选与状态；`09-14-human-gate-server`、`09-14-review-self-approval-detection` 归档为被取代；`09-14-tenon-set-phase-review-bypass` 补 task.json 并归档；console 任务 `meta_status` 修正；S 任务设计引用修正。
- 提交后交付报告：每项修复对应提交、全量验证结果表、已知基线失败清单。
