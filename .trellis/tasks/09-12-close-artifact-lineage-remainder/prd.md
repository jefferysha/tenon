# 收口剩余产物血缘与运行时可见性问题

## Goal

让变更级 runtime artifact store 在迁移、观察、展示和宿主归属边界上形成可审计、可重启、可验证的闭环。用户不需要在 workflow 定义期声明未知文件，但在有真实 change 上下文时能从编排页看到该阶段最近的运行时产物。

## Background and confirmed facts

- 当前 change-scoped namespace 已统一为 `change-<name>-<hash12>`，document、field、runtime subject 在生产路径可以收敛到同一个 `subject_id`。
- `openArtifactService()` 只在目标 `state.json` 不存在时复制 legacy `runtime-artifacts`；目标和 legacy 同时有数据时会静默跳过，且迁移 receipt 只在下一次 mutate 时写入。
- `StageArtifactRuntime.reconcile()` 已经合并重叠调用，但每个变更文件仍单独调用 `service.observe()`，一次 reconcile 会重复读写完整 `state.json`。
- 运行时产物面板已经存在于 progress detail；workflow 编排页目前没有运行时产物入口。编排页是全局定义编辑器，直接打开时可能没有 active change。
- Codex 宿主的 `command_execution` 事件通常没有可靠的结构化路径，因此 `managed-tool` 归属不能被伪造为已支持能力。
- dashboard web typecheck 目前仅剩 `packages/automation/dist/triage/*.d.ts` 中 `ErrorOptions` 的 lib 缺失错误。

## Requirements

### R1. Scope migration must be durable and fail-loud

1. 打开新的 change scope 时，在同一 scope lock 内检查 canonical 与 legacy store 的完整状态。
2. canonical 缺失且 legacy 有数据时，迁移 blobs、attempts、artifacts、events、reads、checks 和 subject mappings，并在本次 open/migration 操作中立即持久化唯一的 `legacy-scope` receipt；不依赖下一次业务 mutate。
3. canonical 和 legacy 都有数据时不得静默丢弃 legacy。若 legacy 包含 canonical 没有的记录，必须持久化可重启读取的未合并诊断（包含 canonical 路径、legacy 路径和保留策略），并让打开操作返回稳定的迁移冲突错误；两个目录均保留。
4. 若两边数据等价，允许建立幂等的已检查 receipt；重复打开不得重复复制、重复写 receipt 或改变已有内容。
5. receipt/诊断必须明确 legacy 目录暂时保留，只有显式运维确认后才可删除；本任务不自动删除 legacy 数据。

### R2. Reconcile uses one durable write per batch

1. 为 artifact service 增加批量 observe 边界；单次 `StageArtifactRuntime.reconcile()` 对所有 created/changed 文件最多产生一次完整 state mutate/save。
2. 批量路径必须保留每个文件的版本、事件幂等键、digest、source.path、disposition、declarationStatus 和删除行为；`observe()` 单文件调用继续兼容并复用同一实现。
3. 批量失败时不得部分更新 baseline；下一次 reconcile 仍能重试未提交的文件。

### R3. Workflow page exposes runtime evidence without requiring declarations

1. workflow 编排页在存在最近选择的 `{root, change}` 上下文时，按当前选中 stage 显示真实 `ArtifactCatalogPanel`，自动刷新并可渐进式打开版本内容。
2. 直接打开全局 workflow、没有 active change 时显示清晰的空状态，不请求伪造的 catalog，也不要求用户为未知文件预先声明 I/O。
3. UI 继续只读 artifact API；不因查看产物写 execution receipt，不改变 workflow 定义保存语义。

### R4. Record host attribution boundary

在 automation/kernel spec 中明确：Codex host 只有在 completion envelope 提供 allow-listed path 时才登记 `managed-tool`；无结构化 path 的 `command_execution` 只能进入一次受节流的 reconcile，observed source 不能升级为 managed-tool。为该边界补测试或证据说明。

### R5. Clear the dashboard typecheck blocker

修复 dashboard web typecheck 的 `ErrorOptions` lib 缺失，使 `npm run typecheck:web` 通过；不得通过关闭 strict/noUnused 或跳过 dist 声明来掩盖错误。

## Acceptance Criteria

- [x] AC1：测试构造“canonical 已有 n1、legacy 后写入 o1”的场景，open 返回稳定迁移冲突诊断，canonical 未被覆盖，legacy 未被删除，诊断/receipt 可从磁盘读取。
- [x] AC2：测试构造“canonical 缺失、legacy 有数据”的场景，单次 open 后立即能读到 `legacy-scope` receipt；第二次 open 不重复复制或追加 receipt；receipt 明确 legacy 保留路径。
- [x] AC3：批量 reconcile 测试用两个或以上文件变更证明 service 的持久化 mutate/save 只发生一次，同时每个文件仍有独立 artifact version/event，失败不会提前推进 baseline。
- [x] AC4：workflow UI 测试证明无上下文时渲染空状态；有上下文时使用当前 stage 传入真实 `ArtifactCatalogPanel`（由现有 panel/API 测试覆盖）。
- [x] AC5：spec 明确 Codex 无 path 时 source 仍是 reconcile/unknown，不能生成 managed-tool 归属。
- [x] AC6：`tsc -b packages/kernel packages/automation packages/cli packages/server --pretty false`、dashboard `npm run typecheck:web`、相关 Vitest、`git diff --check` 通过；architecture 检查未发现本任务新增违规。

## Out of scope and deferred

- 不自动删除 legacy `runtime-artifacts` 目录；只记录保留和后续人工确认条件。
- 不把开放生态 skill 强制改造成定义期可枚举的完整 I/O contract；未知文件仍由声明优先、reconcile 兜底。
- 不在本任务解决宿主侧缺少 path 的根因；只收紧归属声明和证据口径。
- 不重写 dashboard 既有 workflow 编辑模型或 progress artifact API。

## Blocking questions

无。按上述边界直接进入设计与实现；workflow 页无 change 时采用空状态，最近选择 change 作为只读 runtime context。
