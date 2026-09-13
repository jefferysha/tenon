# 实施计划

## 1. 规格与类型

- [x] 读取并遵循 kernel orchestration、automation orchestration、server snapshot、dashboard component 规范。
- [x] 新增 `pipelineBlueprintFromWorkflowDef(def, track)`，补齐 step → blueprint stage 的依赖和显式 work item 绑定。
- [x] blueprint 只按可执行 step 的线性前序生成依赖；退回 transition 不参与依赖，缺失/空映射的终态或 gate-only step 跳过。
- [x] 扩展 server 与 dashboard artifact attempt DTO，保留 run id 和 startedAt。
- [x] 为 compatibility issue 增加 severity，并修正 decoder 的 `ok` 不变量（未知或缺失 severity 按 blocking）。

## 2. 生产接线

- [x] automation 的生产 orchestrator 已接入 workflow definition + track + 显式映射，规划阶段自动构造并冻结 blueprint；自动无 workflow 请求保持原行为。
- [x] CLI 已提供 `orchestration freeze-pipeline <change> --pipeline <json>`、`--pipeline-file <path>`（`-` 表示 stdin），server 已提供 `POST /api/orchestration/changes/:change/freeze-pipeline`；两者只接受 planner 已生成并由 Kernel codec 校验的完整 pipeline，通过 durable ledger 写入 `freeze-pipeline`，不猜测缺失的 planner records。
- [x] workflow blueprint 走显式 pipeline 分支，自动无 workflow 请求保持原行为；外部 blueprint 保持原值。
- [x] runtime-v2、snapshot projection 和 dashboard context 使用同一映射字段。

## 3. UI 语义

- [x] StageEditorPane 按 blueprint 产生的 `stageId === step.id` 找 attempt；没有 blueprint 时显示不可关联空态。
- [x] ArtifactCatalogPanel 使用真实 stageAttemptId，并展示准确 run id / startedAt；缺失时显示 `provenance_unavailable`，不伪造出处。
- [x] 增加自动派生、外部 frozen、无映射三类组件与 API 请求测试。
- [x] 历史血缘标题使用中英文 i18n key，避免英文界面出现硬编码中文。

## 4. 验证

- [x] kernel/automation/server/dashboard 类型检查。
- [x] materializer、runtime artifact、snapshot decoder、dashboard 相关单测。
- [x] CLI freeze 的 schema 拒绝路径和真实 Kernel ledger 的 `pipeline-binding-invalid` 路径均有测试；解析/委派 seam 不再被误认为真实写入验证。
- [x] 真实 server HTTP `freeze-pipeline` → planner assessment → blueprint materialization → durable ledger 链路，已覆盖合法映射、空映射 fail-loud 和六类事件落盘。
- [x] 真实 artifact service → server snapshot API 投影已覆盖 stageAttemptId、stageId、workflowRunId；workflow editor 的 stageId 精确匹配与历史参考展示已有组件测试。
- [x] 真实 StageArtifactRuntime（生产 executor 使用的 adapter）→ artifact service → server snapshot/catalog → workflow editor 浏览器链路：Playwright 使用真实 dashboard server / artifact service，记录 snapshot/catalog 请求参数与状态，断言历史参考和产物读取，并生成并检查 `/tmp/tenon-workflow-runtime-browser-e2e.png`；验证后清理临时截图，浏览器缺失的环境显式跳过。
- [x] 验证双 store 并存只读并存，不在热路径重编号；显式合并命令另列后续任务。
- [x] 为只读 legacy lineage 打开路径补 service/server/catalog/UI 验收；确认不会写 receipt 或 mutate。
- [x] 运行 `git diff --check`；工作区含大量并行 dirty 文件，未执行超出本任务范围的提交。

## 风险点

- 不改 PipelineStageV2 schema；仍需 codec fixture 证明显式 blueprint 分支行为不变。
- workflow 到 work item 的映射可能不是一对一；必须以代码中的 planner request/assessment 证据为准，无法证明时采用显式不可关联状态。
- 现有工作区有大量其他 dirty files，提交时严格按路径选择。
