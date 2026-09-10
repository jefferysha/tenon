# Implement — 工作流定义规范化与两页重设计

执行顺序：后端契约 → 前端领域模型 → 工作台 → 工作流页 → 全站清理 → 全量门禁。每步先写测试再实现。

## 0. 依赖与脚手架
- [x] `npm i -w @tenon/dashboard-app react-markdown remark-gfm @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
- [x] 确认 vitest jsdom 下 react-markdown（ESM）可加载；必要时在 `vitest.config.ts` 加 `deps.inline`。

## 1. kernel（数据 + 纯函数）
- [x] `templates/workflows/default.yaml`：ship `outputs: [pr_url]`；archive `inputs: [pr_url]`、`outputs: [archived]`。`npm run generate:default-workflow`。
- [x] `packages/kernel/src/workflow/effective-io.ts`：`materializeWorkflowIo(def)`；`field-labels.ts`。测试：default 7 步每步 outputs ≥ 1；document_contract 工作流 slot/reads 映射；producer/consumer 推导；locked 标志。
- [x] 从 `packages/kernel/src/index.ts` 导出。
- [x] default 项目覆盖：`effective-plan.ts` 三处 default 分支改为接受项目定义（见 design §2.3）；测试：有覆盖文件时 plan 的 skills/gate 来自覆盖；覆盖破坏七阶段 → 抛错；无覆盖 → 与内建一致。
- [x] 技能合一（design §2.5）：`SkillRef.when` 贯通 parse / serialize / compile / validate / track-reference；`planFromIr` 按轨道过滤 + skillPolicy 切换；default.yaml 并入矩阵；`tools/check-default-skill-matrix.mjs`。测试：parse↔serialize 往返；plan 过滤（frontend 看不到 backend-only 技能、自定义轨道按 profile 继承、dependsOn 清理）；老 default IR 仍 manifest-overlay。
- 验证：`npx vitest run packages/kernel/src/workflow` · `npm run check:default-workflow-freshness` · `npm run check:default-skill-matrix`

## 2. server
- [x] `serverGetRoutes.ts` GET `/api/workflows/:name`：响应追加 `effectiveIo` 与 `source`；default 走覆盖优先。列表恒含 default。测试更新。
- [x] `serverPostGovernanceRoutes.ts` / `serverMutationRoutes.ts`：放开 default 的 POST / DELETE（origin:'default' 校验；DELETE 无覆盖 404）。`definitionCatalog.ts`、`workflowSnapshot.ts`、`workflowDefinitionReader.ts`、`serverPostChangesRoutes.ts` 传入项目读取器。测试：覆盖生效于快照 `workflowRules`。
- [x] `serverWorkflowYamlRoutes.ts`：`resolveWorkflowYamlGet` / `handleWorkflowYamlPut`；接入 GET 路由表与 mutation 路由表（token 校验复用 `tokenFromHeaders/tokensMatch`，体上限 256KB）。测试：GET 内建 / 自定义 / 404 / 400；PUT 200 落盘、400 校验失败不落盘、401、413、409 内建名。
- 验证：`npx vitest run packages/server` · `npm run build:server`

## 3. 前端 API 与领域模型
- [x] `api/governanceTypes.ts`：`WbEffectiveIo`、`WbIoSlot`；`decodeWorkflowDefinition` 接受可选 `effectiveIo`。
- [x] `api/workflowYamlClient.ts`：`fetchWorkflowYaml(name, root)`、`putWorkflowYaml(name, root, text)`（ApiError 携带 `errors[]`）。
- [x] `workspace/taskModel.ts`：`stagesOf`、`summaryOf`、`filterRows`、`countsByStage`。测试覆盖 4 级优先级与归档开关。
- [x] `workspace/stageIo.ts`：`stageOutputs/stageInputs(change, io)`。测试：recorded/missing/stale、字段有值/无值、文件名提取。
- [x] `workflow/pipelineModel.ts`：`pipelineEdges`。测试：default 的回流边 = build→spec、verify→build。
- [x] `workbench/skillWaves.ts`：`wavesToDependencies` 与 `skillExecutionWaves` 互逆测试。
- [x] `workflow/lint.ts`、`workflow/slotCatalog.ts`：测试 `step-no-output`、`input-not-upstream`、候选槽位排除已占用 / 锁定。
- [x] `workbench/useWorkflowEditor.ts`：`setSkillWaves`、`addOutputSlot/removeOutputSlot`、`setInputs`、`importYaml`、`exportYaml`、`hasWriteToken`、`lint`；删除 `buildDefaultDef/governedWorkflow` 依赖（新建 = GET default → 改名 → 去 `openspecContract`？否：复制 default 保留契约；空白 = 单步 `step-1`）。

## 4. 工作台
- [x] `shared/Drawer.tsx`（portal、Esc、焦点捕获 / 还原、aria-modal、`data-testid="drawer"`）；`shared/Markdown.tsx`。测试：Esc 关闭并还原焦点；`# h1` / 表格 / 代码块渲染成对应元素。
- [x] `MiniPipeline.tsx`、`TaskCard.tsx`、`TaskListPane.tsx`（阶段 chips `task-filter-<stepId>`、`task-filter-archived` 开关）。
- [x] `StageIoPanel.tsx`（`stage-output-<id>` / `stage-input-<id>`，状态 `data-state=recorded|missing|stale|ready|pending`）；`DocumentDrawer.tsx`（`drawer-prev/next`、`file-preview-markdown` / `file-preview-text`）。
- [x] `TaskDetailPane.tsx`、`WorkspaceView.tsx` 重装；删除 `FileWorkbench.tsx`、`stageFiles.ts`。
- [x] `useWorkflowDefinition.ts`：default 也走 `fetchWorkflow`。
- 验证：`npm run test:web -- workspace` · Playwright 1440 截图 · 抽屉 Esc

## 5. 工作流页
- [x] `PipelineList.tsx`（`wb-step-<id>`、`wb-back-edge-<from>-<to>`、`wb-lint-<id>`、`wb-add-stage-open`）。
- [x] `SkillDag.tsx` + `SkillPalette.tsx`（dnd-kit；容器 `wave-<k>`、`gap-<k>`、`palette`；节点 `skill-node-<id>`；移除按钮 `skill-remove-<id>`）。测试用 dnd-kit 键盘传感器：空格拾起 → 方向键 → 空格放下，断言 `wavesToDependencies` 结果与 `depends_on`。
- [x] 删除 `TrackSkillsSection.tsx`；`SkillDag` 节点轨道标签 `skill-tracks-<id>` + 弹出层勾选 `skill-track-<id>-<track>`；DAG 顶部轨道芯片 `dag-track-<track>` / `dag-track-all`。
- [x] `OutputsSection.tsx`（`output-slot-<id>`、`output-add`、`output-remove-<id>`、锁标 `data-locked`）、`InputsSection.tsx`（`input-check-<id>`）、门禁三选一 `wb-lane-gate-<id>`。
- [x] `StageEditorPane.tsx` 重装；底栏保存受 `lint` 与 `hasWriteToken` 约束（`wb-save` disabled + `wb-no-token`）。
- [x] `NewWorkflowDialog.tsx`（`wb-new-template-copy|blank|import`、`wb-workflow-name`、`wb-workflow-create-confirm`）、`ImportYamlDialog.tsx`（`wb-import-text`、`wb-import-file`、`wb-import-confirm`、`wb-import-errors`）；`WorkflowRail.tsx` 卡片菜单 导出 `wb-workflow-export-<name>` / 删除。
- [x] 删除 `StageListPane.tsx`、`DerivedIoPanel.tsx`、`WorkbenchDialogs.tsx` 中的旧新建对话框分支。
- 验证：`npm run test:web -- workflow workbench` · Playwright：新建（有 token 的 :18765）、导出、导入、拖拽

## 6. 全站清理
- [x] `shell/TopBar.tsx`：删「只读视图」胶囊与头像；`Settings` 图标按钮 `aria-label`。
- [x] 用语统一（R4.3）：grep zh 词典，`step|lane|产出物|登记者|来自上游|推导` 归零；所有 `*_note|*_desc|*_lead|*_hint` 键删除或改为名词标签。
- [x] `i18n/translations.ts`：删除 `*_note / *_desc / *_lead / io_* 说明 / runtime matrix` 等解释文案；新增 workspace.summary_* / workflow.dag_* / import_export_* 键；zh/en 同步；`i18n.test.tsx` 断言 R4.2 列举文案不存在。
- [x] `.trellis/spec/dashboard-app/frontend/component-guidelines.md`、`directory-structure.md` 更新为新结构与规则（物化 IO、抽屉、DAG 列模型、写凭证态）。
- [x] 记忆更新：设计基准 + 「三套定义合一」结论。

## 7. 门禁（全部通过后才报告完成）
```bash
npm run typecheck:web
npm run test:web
npx vitest run packages/kernel packages/server
npm run check:design-scale && npm run check:comments && npm run check:default-workflow-freshness
npm run build:web && npm run build:server
```
- Playwright：1440 两页截图；375 `document.documentElement.scrollWidth === clientWidth`；抽屉 Esc；带 token 地址上新建 / 导入 / 导出 / 保存各一次。

## 回滚点
- 第 1–2 步独立可回滚（服务端向后兼容）。
- 第 4、5 步分别成组提交；任一组失败可回退到上一组的绿色状态。
