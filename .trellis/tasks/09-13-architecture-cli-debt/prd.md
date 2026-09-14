# 处理架构门禁 CLI 边界与维护债务

## Goal
让 `npm run check:architecture` 在不降低规则强度的前提下通过，同时保持 CLI、server、kernel、automation 和 dashboard 的现有公共行为。

## Background and confirmed facts

- 当前全量功能测试已通过：437 个文件、7129 个测试通过，15 个 honest-skip。
- 当前架构门禁仍报告 35 条历史违规；违规集中在 workflow identity capability 重建、7 个生产非空断言、7 个超长文件，以及 1 个 kernel domain 模块导入 Node API。
- 本轮功能修复没有新增这些违规；但 CI 在 `.github/workflows/ci.yml` 中把架构检查作为硬门禁，因此“deferred”不能作为当前分支的合并状态。
- 架构检查器已经提供 `packages/kernel/src/workflow/identifier.ts` 的 `isDefaultWorkflowName` 作为集中身份判断点，并对少数确有协议兼容含义的比较提供逐项 allowlist；本任务不放宽 allowlist 作为替代修复。
- 当前超长文件与违规文件均可由真实源码、现有测试和公开导出边界回答，不需要引入新框架、数据库或包管理器。

## Requirements

### R1. 消除 35 条架构门禁违规

- 将生产代码中的 workflow identity capability 重建统一收敛到 kernel 的身份/编译兼容入口；调用方通过公开导出或显式边界适配，不再在 dashboard、server、kernel、automation 中散落字面比较。
- 移除 `workflow-pipeline-v2.ts`、`workbenchDefinition.ts`、`SkillFlow.tsx`、`auto-register.ts`、`branch-track.ts`、`effective-plan.ts`、`validate.ts` 中的生产非空断言，改用显式收窄或稳定错误路径。
- 拆分超阈值文件：`planner-v2.ts`、`runtime-v2.ts`、`SkillFlow.tsx`、`v2-codec.ts`、`types.ts`、`effective-plan.ts`、`parse.ts`；拆分后保持公开导出、序列化形状和执行顺序不变。
- 将 `global-store.ts` 的 Node 文件系统访问移到 infrastructure adapter，通过 domain/application port 保持 workflow 领域纯度。

### R2. 保持 CLI 与跨层契约

- 保留 `tenon get` 对不存在 Change 的稳定错误码/退出码，并为边界补定向测试。
- 不修改现有 API 路径、YAML/JSON/JSONL 格式、workflow identity 保留字语义或默认 workflow 兼容行为。
- 不通过新增 architecture baseline、扩大 allowlist、`continue-on-error` 或关闭检查来取得假绿。

### R3. 债务记录与分批验收

- 将拆分、身份收敛、domain/infrastructure 分离、CLI 边界和 OpenSpec/Trellis 处置拆为可独立回归的子批次。
- 每批次记录受影响文件、回滚点和真实测试证据；任何暂时保留的兼容比较必须有具体 allowlist 原因和到期/后续任务。

## Acceptance criteria

- [x] `npm run check:architecture` 通过，且没有新增或扩大的例外；runtime import graph 仍为零运行时环。
- [x] 35 条违规逐条归零：20 条 identity、7 条 non-null、7 条 size、1 条 Node infrastructure import。
- [x] 受影响 kernel/automation/server/dashboard/CLI 测试通过，行为和持久化契约不回归。
- [x] `npm run build:packages`、`npm run typecheck:web`、`npm run bundle`、`npm run build:server` 通过。
- [x] `tenon get` 不存在 Change 的错误契约、workflow 默认保留字和现有 OpenSpec/Trellis 记录均有回归证据。
- [x] 未修改架构规则阈值、未加入无期限 baseline、未使用 `continue-on-error` 掩盖失败。
