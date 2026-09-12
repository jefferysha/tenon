# 技术设计：收口剩余产物血缘与运行时可见性

## 1. 边界

`packages/automation/src/artifacts/service.ts` 继续拥有 runtime state、blob、subject mapping 和迁移 receipt 的持久化；`StageArtifactRuntime` 只负责快照差异和调用 service port。迁移不会把 legacy store 合并成第二个 live store，也不会删除旧目录。dashboard 只消费已有的 catalog/subjects/read API。

## 2. Scope migration

打开 change scope 时使用现有 `scopeMigrationLocks`，在锁内执行以下步骤：

1. 读取 canonical `state.json`（若不存在视为空）和 legacy `runtime-artifacts/state.json`（若不存在则无迁移）。同时检查各自的 blobs 目录。
2. 计算 legacy 中 attempts、artifacts、events、reads、checks、subjectMappings 的稳定摘要，以及 canonical 是否已经覆盖这些记录。canonical 缺失时把 legacy store 原子复制到目标临时目录，再 rename 到 canonical 目录。
3. canonical 缺失且完成复制：在 canonical state 中直接追加一次 `legacy-scope` receipt，receipt id 按 `runtime-artifacts -> scopeId` 确定，增加可选的保留说明字段或等价诊断 metadata，随后立即 `atomicReplaceFile` 保存；`openArtifactService()` 返回前即可读到 receipt。
4. canonical 已存在：若 legacy 有 canonical 没有的 revision/record/blob，写入幂等的 `legacy-scope-unmerged` 诊断（复用 migration receipt 的 durable state 或专用 sidecar），并抛出稳定错误码/消息。不得覆盖 canonical，不得删除 legacy。若摘要等价，则只写一次 `legacy-scope` checked receipt。
5. 迁移成功和冲突都保留 legacy 路径，在 receipt 中记录“保留待人工确认”；只有显式后续运维动作才允许清理。

实现上避免在模块初始化阶段调用业务 `mutate()` 递归加载；增加一个迁移专用的 locked state read/write helper，所有 JSON 先经过现有 decoder。receipt 写入与复制绑定在同一个 scope lock 内，重复 open 通过 receipt id 和摘要判断幂等。

## 3. Batch reconcile

`ArtifactService` 增加 `observeBatch(stageAttemptId, inputs): Promise<readonly ArtifactVersion[]>`；`observe()` 委托给长度为 1 的批量实现。批量实现只调用一次 `mutate()`，在同一个 state 中逐项执行现有 idempotency、blob 写入、`versionFor` 和 event 逻辑，按输入顺序返回版本。单个输入失败时整个 mutate 不保存，调用方 baseline 保持旧值。

`ArtifactServicePort` 暴露可选 `observeBatch`，以便注入的测试/兼容 service 仍能只实现 observe。`StageArtifactRuntime.reconcileNow()` 收集非删除变更后优先调用 batch；没有 batch 时逐项 fallback。删除继续在同一 reconcile 中执行，但服务端若没有批量删除能力仍保持现有行为。只有所有观察和删除成功后才赋值 `this.baseline = next`。

## 4. Workflow runtime panel

`WorkflowView` 增加只读 props `runtimeRoot?: string`、`runtimeChange?: string`。`AppShell` 记录最近一次真实选择的 `{currentRoot, selectedChange}`，进入全局 workbench 时把它作为历史 runtime context；没有上下文则传空值。`StageEditorPane` 增加可选 `runtimeContext`，在输入/技能/输出/门禁之后渲染：

- 有 root + change：复用 `ArtifactCatalogPanel`，传入当前 `step.id`，由 server 选择该 stage 最近 attempt；保留 5 秒轮询、subject 分组和渐进式内容读取。
- 无上下文：渲染 `data-testid="workflow-runtime-artifacts-empty"` 的说明卡，说明需要从 progress 选择一个 change 后再回到 workflow 查看运行时证据；不调用 artifact API。

这只展示运行结果，不把 runtime 记录写回 workflow 定义，也不在 UI 侧推断新的 I/O 槽位。

## 5. Host attribution specification

扩展 `.trellis/spec/automation/backend/orchestration.md` 与 kernel skill-output protocol：`managed-tool` 需要 allow-listed completion path；pathless Codex `command_execution` 只能触发一次 bounded reconcile，并保留 `unknown`/`reconcile` source。测试断言 source、节流和最终 stage-end reconcile，不声称能从宿主事件恢复精确归属。

## 6. Typecheck

dashboard-app 的 TypeScript `lib` 增加 `ES2022.Error`（保留 ES2020 target），使依赖的 automation declaration 中 `ErrorOptions` 可解析。若仓库的 TypeScript 版本要求完整 ES2022 lib，则仅增加对应 Error lib，不降低严格检查。

## 7. Compatibility and rollback

- 旧 state 没有 migration receipts 时按空数组兼容；新字段采用可选/解码默认值。
- 迁移冲突采用 fail-loud，用户可修复或确认旧目录后再次打开；不会破坏任何一侧数据。
- batch API 是可选 port，旧注入 service 自动走单文件 fallback。
- UI runtime context 缺失时只显示空状态，progress 既有面板和 API 不变。
