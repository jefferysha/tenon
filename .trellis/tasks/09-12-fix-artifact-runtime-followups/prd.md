# 修复产物目录噪声与生产接线缺口

## Goal

让产物运行时在真实 workflow 中只暴露业务产物，正确记录工具级观察、固定版本和运行中更新状态，并让 CLI/server 使用同一生产执行入口。用户不需要在编排阶段预填任意 Skill 的文件清单。

## Background / confirmed facts

- 最近一次真实七阶段 `ExecutionRuntimeV2 + createCodexSkillExecutorV2` 已证明 producer、dependency visibility、consumed、affected 和重启回放可以成立。
- 真实 evidence 中 97 个 observed 事件里约 90 个来自 `.orchestration-v2/` 账本文件，说明扫描范围污染了内部运行时目录。
- Codex JSONL adapter 的 `managed-tool` 路径在真实执行中没有命中，所有观察都退化为 reconcile；当前没有原始事件 fixture 可以证明事件字段映射正确。
- `ArtifactPolicy.pinned` 已通过 kernel、server 和 dashboard，但 `ArtifactService.catalog()` 尚未使用它。
- `catalog()` 和 `read()` 采用不同的可见性判断；无 producer 条目可被 catalog 广泛列出。
- `affected` 只在消费者 attempt 完成后计算，运行中的消费者没有 pending-update 状态。
- 生产执行没有默认注册 checker；真实 evidence 的质量全部为 `unchecked`。
- CLI `orchestration start` 与 server control route 只写 ledger，不调用 v2 production executor。

## Requirements

### R1. 清理扫描范围与增量观察

- `StageArtifactRuntime` 默认排除 `.orchestration-v2`，并将系统目录忽略项集中为可配置策略；忽略项不能被 catalog、reconcile 或 managed-tool 观察登记。
- Codex JSONL 解析器支持真实 `item.completed`、command/shell/write/tool 事件的路径提取；只有确认路径在 scope 内时才调用 `observePath`，无法解析路径时保留 bounded diagnostic，不把未知事件伪装成 managed-tool 观察。
- adapter 在测试和真实 evidence 中保存有界原始事件样本/类型计数，能区分 `managed-tool`、`explicit-publish`、`reconcile`。

### R2. 固定版本和目录语义

- attempt 创建时持久化可见 deliverable 的初始版本快照；`catalog({ pinned: true })` 只返回该快照版本，重启后仍可用。
- `StageArtifactRuntime.consume()` 优先使用显式版本，其次使用 attempt pinned snapshot；新版本不改变正在执行阶段已经选择的输入。
- 无 producer 版本的 catalog 判断必须复用 `visibleToAttempt()`，不能与 `read()` 分叉；相关 observed event 只能作为兼容旧数据的可见性提示。

### R3. 运行中更新状态

- catalog 在已消费版本存在后续 deliverable 版本时，完成阶段保持 `affected=true`；运行中的消费者返回独立的 `pendingUpdate=true`，避免把待处理更新误报为已经完成的影响。
- UI 显示 pending-update 和 affected 的区别；事件和 read receipt 仍以 exact version 为准。

### R4. 动态检查

- Artifact Service 接受 production checker 注册；至少提供 JSON 结构检查和文本/二进制 `not-applicable` 的明确结果，禁止把未检查伪装成 passed。
- checker 选择基于 exact artifact metadata/version，结果绑定 checker id/version；真实 workflow evidence 至少包含一次 passed、failed 或 not-applicable 检查事件。

### R5. CLI/server 生产接线

- 抽出单一 production runtime factory，统一解析 change 目录、ledger、artifact service、Codex executor、validator 和 worker identity。
- CLI 提供显式 `orchestration run <change>`（或等价明确命令）执行生产 V2 runtime；现有 `start` 控制语义保持兼容。
- server 提供受保护的 run 入口或将现有 start route 接到同一 factory，返回 run identity，并通过 snapshot/events 观察进度；不得维护第二套 executor。
- CLI/server 入口都使用 `createCodexRuntimeExecutor`，不得依赖 task-local driver 手动 reconcile/consume。

## Acceptance Criteria

1. 真实 workflow 的 catalog 不包含 `.orchestration-v2` 文件；UI 默认目录只展示业务 deliverable，includeCandidates 仍可显式查看候选。
2. 真实 Codex JSONL 至少有一条 managed-tool 观察；无法解析的事件产生 bounded diagnostic，且不会错误标记 producer。
3. 重启后 `catalog({ pinned: true })` 与执行阶段首次看到的版本一致；显式消费 v1 时即使存在 v2 也读取 v1。
4. `catalog()` 与 `read()` 对同一 attempt 的可见性结果一致，无关阶段不能读取或列出 deliverable。
5. 运行中的消费者显示 `pendingUpdate=true`，完成后的消费者显示 `affected=true`；未消费或无关阶段不显示任一状态。
6. 生产 checker 注册后，真实 artifact 至少产生一次 exact-version 的 passed/failed/not-applicable 结果，UI 能显示 quality。
7. CLI 与 server 生产入口都能启动同一 V2 runtime，并产生 artifact attempts/events/catalog；现有控制命令行为不回归。
8. 目标包 TypeScript、定向测试、架构检查和真实 backend workflow E2E 通过；任何预先存在的失败必须单独记录。

## Constraints / Out of scope

- 不要求 workflow 编辑器为 Skill 预填输入输出文件，也不让 UI 与模型直接协商 schema。
- 不重写现有 governed workflow、snapshot authority 或无关 dashboard 逻辑。
- 不把无法解析的 Codex 事件当成成功 managed observation；降级必须可诊断。
- 不删除 `pinned` 协议字段；本任务实现其持久化语义。

## Open questions

无。用户已明确要求创建并修复全部列出的缺口；CLI/server 采用显式生产 run 入口，保留现有 start 控制语义。
