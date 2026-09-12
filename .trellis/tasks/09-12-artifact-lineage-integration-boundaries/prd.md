# 修复产物迁移集成边界与历史运行时展示

## Goal

让产物迁移异常、运行时缓存和工作流编排页都遵守同一条可用性边界：单个 change 的产物血缘不可读时，不能让整个 change 消失；服务修复后无需重启即可重试；工作流定义页展示的运行时产物必须明确来自哪一次历史运行，并且只能按真实 runtime attempt 查询。

## Background（已由代码核实）

- `openArtifactService()` 在发现新旧 scope 都有不一致数据时抛出 `ArtifactScopeMigrationError`。当前异常从 `projectArtifactAttempts()` 穿过 `Promise.all`，被快照通用 catch 误报为“状态损坏或不可读”，导致整个 change 不进入 `changes`。
- `server.ts` 的 `artifactServices` 缓存保存 rejected promise；迁移冲突处理后，同一进程内后续请求仍然永久失败。
- `ChangeSnapshot.artifactAttempts` 已经保存真实 runtime `stageId` 和 `stageAttemptId`，而工作流编辑器的 `step.id` 属于另一命名空间。当前面板把 step id 直接作为 stage id，可能得到 400/空态。
- 编排页使用上一次选中的 change 作为运行时上下文，并在 render 期间写入 ref；取消选择后上下文仍然粘住。运行时面板目前没有 run/attempt、日期和“历史参考”语义标记。
- 既有 dashboard 规范明确：工作流定义只展示声明槽位，运行时目录只能作为执行后观察结果；历史产物不能伪装成新 workflow 的预期结果。

## Requirements

### R1. 快照降级而不丢 change

`ArtifactScopeMigrationError` 只影响产物投影：`artifactAttempts` 返回空数组，并向项目 `compatibilityIssues` 增加稳定、可解码的兼容问题（包含 change、legacy scope 路径和“保留旧目录待确认”语义）。该 change 的 canonical state、documents、skillRuns、todo 和阶段仍照常出现在快照中；不得生成“状态损坏或不可读”的误导性错误。

### R2. rejected service 可恢复

artifact service 创建成功后继续按 root 复用；创建 promise reject 时必须从缓存删除，再次请求重新调用 `openArtifactService`。测试覆盖“首次失败、修复外部状态、第二次成功”和成功 promise 仍只创建一次。

### R3. 历史运行时产物有明确出处

工作流编排页的运行时区域必须显示“历史参考”标签，并显示可追溯的 `workflowRunId`/`stageAttemptId`（至少一个稳定运行标识）和 `createdAt`/采样时间。文案和结构必须说明这些是最近一次真实运行的观察结果，不是 workflow 定义的预期输出。没有上下文时显示空态，不发起猜测查询。

### R4. 上下文生命周期与项目边界正确

运行时上下文只能来自当前项目、当前选中的 change；取消选中或离开进度页立即清除。不得在 render 阶段写 ref。工作流页只能消费一次明确传入的上下文快照，不能跨项目或跨 change 复用上次数据。

### R5. 使用真实 runtime attempt 查询

从快照选择与当前 workflow step 对应的真实 `stageAttemptId`，调用 catalog 时优先传 `stageAttemptId`；不能把 workflow `step.id` 当作 runtime `stageId`。没有可靠映射时显示明确的“该阶段尚无可关联运行产物”状态，禁止以 400/静默空目录掩盖映射缺失。增加一个 runtime stage id 与 workflow step id 不同的回归测试。

### R6. 证据

增加 server snapshot、artifact service cache、dashboard panel/context 的自动化测试，并执行相关 package typecheck/test。至少跑一次真实 dashboard/backend 链路，确认迁移冲突下 change 仍可见，选中历史 change 时面板展示出处，取消选择后面板清空。

## Out of scope

- 本任务不自动合并、删除或清理 legacy scope；旧目录继续保留并在诊断/receipt 中说明。
- 本任务不让模型解析 skill 内容，也不改变 workflow I/O 声明模型。
- 本任务不改变 artifact subject、namespace 或迁移冲突判定规则；只修复集成边界和展示语义。

## Acceptance Criteria

- [ ] 迁移冲突只产生可见 compatibility issue，change 仍出现在 `/api/snapshot`，且不含“状态损坏或不可读”。
- [ ] rejected artifact service 不会永久留在 `artifactServices`；修复后同一 server 实例第二次读取成功。
- [ ] 编排页运行时区域有“历史参考”、运行/attempt 标识和日期；无上下文和取消选择时均为空态。
- [ ] catalog 请求使用真实 `stageAttemptId`；step/runtime id 不一致的 fixture 不再触发错误查询。
- [ ] 相关单测、类型检查和真实 E2E/后端链路通过，证据写入任务记录。
