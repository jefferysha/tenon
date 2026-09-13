# 接通 workflow 到 V2 pipeline 的运行产物映射

## Goal

让自定义 workflow 在真实 V2 executor 路径中生成可被 dashboard 关联的运行产物，并让历史参考展示准确的运行身份与开始时间。

## Background（代码核实）

- `materializeWorkflowPipelineV2()` 在没有外部 blueprint 时把自动阶段的 `stage_id` 设成 `workItemId`（如 `work-req-backend-api`）。这与 workflow 编辑器的 step id（如 `build`、`verify`）不是同一命名空间。
- `runtime-v2.ts` 通过 `pipelineStageIdFor()` 使用 pipeline stage id 创建 artifact attempt；server snapshot 目前只保留 `stageId` 与 `stageAttemptId`，丢失 artifact attempt 已有的 `workflowRunId` 与 `startedAt`。
- 上一任务已禁止 dashboard 在无法关联时猜测 stage id，并增加历史参考徽标；当前生产自动派生 pipeline 因此会稳定落入“无可关联产物”空态。
- server 与 CLI 现在都有独立的 `freeze-pipeline` 写入入口。server 支持携带 request/context/catalog、workflow definition、track 和 mapping，由 planner 在 assessment 后解析并冻结；CLI 继续支持完整、可校验的 pipeline JSON 写入。两者都不猜测缺失的 step 映射。
- 本任务已把 `AutonomousOrchestratorV2` 作为持有这些前置记录的生产自动化调用方：它接收 workflow definition、track 和显式 step→work-item mapping，在规划阶段构造并冻结 blueprint；server/CLI 独立入口仍需其真实 request/context/catalog 来源就绪后接入。
- `projectSelectionModel.ts` 已允许“有 compatibility issue 且无 error”的项目进入，`CanonicalStateVersionNotice` 已使用琥珀色样式；本任务将固化这个现状，不重新修复不存在的红色阻塞。

## Requirements

### R1. workflow → pipeline identity

不修改自动任务分解分支，也不向 `PipelineStageV2` 增加字段。由真正持有 workflow 定义的 planner/server 构造 `pipelineBlueprintFromWorkflowDef(def, track)`：只有显式映射到 work item 的可执行 step 成为 blueprint stage，`stage_id = step.id`；终态和 gate-only step 不进入执行阶段。阶段依赖按可执行 step 的线性前序生成，忽略 transitions 中表达退回/回流的边。冻结 pipeline 时走已有显式 blueprint 分支；外部 frozen pipeline 继续原样保留 `stage_id`。没有 workflow 定义的纯 auto-plan 请求保持不可关联空态。

### R2. provenance 完整传递

`ChangeSnapshot.artifactAttempts` 及 dashboard decoder 必须保留每个最新 attempt 的 `workflowRunId` 与 `startedAt`，并继续保留 `stageId`、`stageAttemptId`。历史参考徽标使用真实 run id 和 attempt 开始时间，不得用 attempt id 伪装 run id，也不得用第一个产物的创建时间代替运行时间。

### R3. 编排页真实关联

工作流编辑器按 workflow step 查找对应的真实 runtime attempt，并以 `stageAttemptId` 调用 catalog。自动派生 pipeline、外部 frozen pipeline、旧快照缺少映射三种形态都要有测试；无法关联时继续显示明确空态，不发起猜测请求。

### R4. compatibility issue 口径与投影重建

compatibility issue 增加显式 `severity: 'blocking' | 'warning'`。`project.ok` 的语义改为“不存在 blocking issue”；decoder 对未知或缺失 severity 按 blocking 处理，避免旧 dashboard 把 `ok:true + warning` 判成整份 snapshot 无效。lineage-only 冲突为 warning，canonical state 不可读仍为 blocking。投影重建只保留安全热路径：canonical target 缺失时从 legacy 复制；两边都有数据时只读并存、展示历史血缘，不做热路径重编号合并；复杂合并另做显式、可备份、可失败的 `tenon artifact merge-legacy-scope --confirm` 命令。

### R5. 真实链路验证

补齐 pipeline blueprint materialization、runtime attempt projection、server snapshot、dashboard panel 的回归测试，并运行真实 workflow blueprint → executor → artifact service → snapshot/catalog → workflow editor 链路；纯 auto-plan 路径继续验证为明确空态。

## Out of scope

- 不改开放 skill 的输入输出声明模型。
- 不覆盖外部调用方自定义错误 stage id 的历史数据迁移；只提供明确不可关联诊断。
- 不删除或重写已有 artifact attempt；仅在新运行和投影层补齐身份。

## Acceptance Criteria

- [ ] workflow blueprint 的 stage id 与 step id 一致，真实 executor 产物可在编排页按 step 找到；纯 auto-plan 无 workflow 时保持明确空态。
- [ ] snapshot attempt 包含真实 `workflowRunId` 与 `startedAt`，UI 历史参考显示准确出处。
- [ ] 外部 frozen pipeline 的显式 stage id 行为不回归，旧快照无映射时不发起错误 catalog 请求。
- [ ] severity 分级、`ok` 不变量和 decoder 保守降级有测试；lineage-only issue 不隐藏 change，项目可导航且告警为 warning。
- [ ] 双 store 并存时可通过只读 legacy lineage 视图查看旧数据，并明确标记“未合并”；默认热路径不重编号、不静默合并。
- [ ] 相关类型检查、单测和真实后端/dashboard 链路通过，并记录证据。

## Decision

- lineage-only issue 采用 warning 级别；`project.ok` 只由 blocking issue 决定。
- “全部重建”限定为 canonical 缺失时的复制；双 store 并存时只读并存，重编号合并移出热路径，改为后续显式命令。
- 不新增 `PipelineStageV2.workflow_step_id`，避免冻结 pipeline digest 和重放兼容风险。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
