# 技术设计（精简重做）

- 视图只剩 `progress`（工作台）与 `workbench`（工作流），`shell/views.ts` 白名单收窄；旧 id 深链落回工作台。
- 工作台右列：`TaskDetailPane` = 头部 + `PhaseRail`（可点选阶段）+ `FileWorkbench`。
  `stageFiles.stageIo(step, change)` 用工作流定义的 `inputs/outputs` 字段名到 `change.fields` 取路径；
  `useWorkflowDefinition` 拿定义（default 本地构造，自定义拉 `/api/workflows/<name>`）。
  读文件走 `api/documentsClient.fetchDocument` → 新增 `GET /api/documents/read?root&path`
  （`serverGetDocumentRoutes.ts`：workflowRootForRequest 信任锚 + readTrustedFile，256KB，UTF-8，
  400 路径非法 / 403 非普通文件 / 404 缺失 / 413 超限）。
- 工作流右列：`StageEditorPane` 三段无页签——技能（`skillWaves.isParallelWithPrevious` 判串并行，
  切换只改 `depends_on`）/ 门禁 / `DerivedIoPanel`。所有写操作经 `useWorkflowEditor`（已去掉 hooks / loops / recent）。
- 删除：afk、machine、hostPlan、advanced、verification、taskPlan 目录；workbench 下轨道 / 循环 / 治理 / 策略 /
  hook / 技能编排 / 时间线组件；shared 下 TaskDetail 一系；progress 下 ContextBundle / RunLog / 编排面板；
  15 个无引用的 i18n 命名空间。
