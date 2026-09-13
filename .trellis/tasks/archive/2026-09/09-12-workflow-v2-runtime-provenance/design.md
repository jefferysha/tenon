# 技术设计

## 统一身份

workflow 定义和 pipeline blueprint 由同一 planner/server 边界掌握。新增纯函数 `pipelineBlueprintFromWorkflowDef(def, track)`，只把显式映射到 work item 的可执行 workflow step 构造成 blueprint stage：`stage_id` 就是 step id；依赖按可执行 steps 的线性前序生成，不把 transitions 中的退回边当执行依赖，终态和 gate-only step 被跳过。`materializeWorkflowPipelineV2()` 继续使用已有显式 blueprint 分支，不改 `PipelineStageV2` schema；没有 workflow 定义的 auto-plan 仍使用 work item stage id，并在 dashboard 明确不可关联。

## 数据流

```text
workflow/track snapshot
        │
        ▼
materializeWorkflowPipelineV2
        │ blueprint.stage_id = workflow step id
        ▼
runtime-v2 → StageArtifactRuntime.beginAttempt
        │ workflowRunId + stageId + stageAttemptId + startedAt
        ▼
server projectArtifactAttempts
        │ full provenance DTO
        ▼
dashboard runtime context → catalog(stageAttemptId)
```

`projectArtifactAttempts()` 继续按实际 `stageId` 选最新 attempt，但 map 时保留 `workflowRunId` 与 `startedAt`。dashboard 直接按 workflow blueprint 产生的 `stageId` 与 step id 相等来关联；没有 blueprint 的 auto-plan 不允许用 work item 猜测。

冻结写入现在有两个明确边界：`AutonomousOrchestratorV2` 和 server 的 `POST /api/orchestration/changes/:change/freeze-pipeline` 在拥有 request/context/catalog、workflow definition、track 和显式 mapping 后完成评估、映射与 materialization；server 也保留完整 planner-produced `WorkflowPipelinePlanV2` 的兼容写入分支，CLI 使用同一语义。两条路径都通过 durable ledger 写入 `freeze-pipeline`，不会在缺少 planner records 时猜测 workflow 到 work-item 的关系。

## 协议与兼容

- `ChangeSnapshot.artifactAttempts` 增加 `workflowRunId`、`startedAt`，不新增 pipeline stage 字段。
- catalog API 不变，始终传 `stageAttemptId`。
- compatibility issue 带 `severity`；`ok:true` 仅禁止 blocking issue，decoder 对未知 severity 按 blocking 处理。
- artifact projection 只有 canonical 缺失时自动复制；双 store 并存时只读展示 legacy lineage，复杂合并放到显式命令，避免重编号 events/versions/read/check 引用。

双 store 并存的只读展示需要真实机制：在 `ArtifactServiceOptions` 增加 `readOnly` 打开模式（或等价的 `openLegacyLineageView()`），该模式只读取 legacy state/blob，不执行 migration、mutate 或 receipt 写入；server snapshot/catalog 将它作为附加 lineage source 返回，UI 明确标注“历史血缘（未合并）”。默认可写 service 仍对冲突 fail-loud，避免普通运行路径误把并存数据当成已合并。

## 失败与回滚

- workflow 到 pipeline 无法一一映射时，materializer 返回明确诊断或可冻结但不可关联的 stage；不伪造 step id。
- 旧 attempt 没有 run provenance 时 UI 显示“运行身份不可用”，不使用产物时间冒充。
- 重建只作用于 artifact projection；workflow canonical state、documents、skillRuns 和 todo 不参与 destructive rewrite。
- 回滚只需移除可选字段和 dashboard 历史头部，既有 artifact 目录无需迁移。
