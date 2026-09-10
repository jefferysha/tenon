# Implement — 工作流 track 分支、技能编排浮层、IO sheet 与门禁语义

## 1. kernel：分支 + 门禁
- [x] `workflow/types.ts`：`WorkflowDef.tracks`、`TrackBranchDef`；`GateKind = 'review' | 'auto' | null`；删 `SkillRef.when`。
- [x] `parse.ts` / `serialize.ts`：`tracks:` 块往返；删技能 `when` 解析与序列化（`parse-skill-refs.ts`）。
- [x] `compile.ts`：`auto` → 每条 transition 追加 `nonempty-output`；`confirm` 报错；删 `compileSkillWhen`。
- [x] `validate.ts` / `document-contract-validation.ts` / `track-reference-validation.ts`：逐分支校验；default 每分支骨架校验；删技能 `when` 校验。
- [x] `effective-plan.ts`：`selectTrackBranch`；`matrixEmbedded = tracks !== undefined`；删 `conditional` / `skillAppliesToTrack`；`effective-plan-types.ts` 同步。`effective-skill-resolver.ts` 删 `embeddedOverlaySlots`。
- [x] `tracks/`：`resolveTrackForBranch(registry, id, def)`（合成缺省定义）。
- [x] `default-artifacts.ts` + `tools/generate-default-workflow.mjs`：按分支生成 declarations 表；`tools/check-default-skill-matrix.mjs` 逐分支比对。
- [x] `templates/workflows/default.yaml`：展开为 `steps`（通用）+ `tracks.{pm,frontend,backend,free}`；`npm run generate:default-workflow`。
- [x] 测试：`parse.test` / `serialize.test` / `compile.test` / `validate.test` / `effective-plan.test` / `default-artifacts.test` / 新 `track-branch.test.ts`；删 `skill-track-condition.test.ts`。

## 2. cli
- [x] `init.ts`：track 解析走 `resolveTrackForBranch`；`effective-workflow.ts` 同步。
- [x] `advance.ts` / `advance-support.ts`：删 `step.gate === 'confirm'`。
- [x] 集成测试：自定义分支 init；`auto` 门 transition 拒 / 放行。
- [x] `npm run bundle`。

## 3. server
- [x] `workflows.ts` / `serverGetRoutes.ts`：`branches`（label + effectiveIo）。
- [x] `skillsRegistry.ts` + `serverGetRoutes.ts`：`GET /api/skills/:name/readme`。
- [x] `skillRuns.ts`：删 embedded 分支（保留 manifest 回退）。
- [x] 测试：`server.test.ts` 新增 branches / readme；`skillRuns.test.ts` 调整。

## 4. web：类型与数据
- [x] `api/governanceTypes.ts` / `governanceSchema.ts` / `governanceClient.ts`：`tracks`、`branches`、gate 三态、readme client。
- [x] `workbench/useWorkflowEditor.ts`：选中 `{workflow, branch}`；分支增删；`setSkills` 作用于分支。
- [x] 删 `workbench/trackPresentation.ts`；所有名称 `label ?? id`。

## 5. web：工作流页
- [x] `WorkflowRail.tsx`：可展开树 + 新建 / 删除轨道。
- [x] `PipelineList.tsx`：单一名称。
- [x] `StageEditorPane.tsx`：技能只读 + 编辑按钮；IO 两行入口；门禁三态 + hover。
- [x] `workflow/SkillComposer.tsx`（新）：技能库 + 画布 + 预览抽屉；`workflow/IoSheet.tsx`（新）。
- [x] i18n：`workflow.branch_base`、`new_track`、`delete_track`、`gate_auto`、`gate_help_*`、`skill_source_*`、`edit_skills`、`preview_skill`、`from_stage` …；完整性 / 泄漏测试。
- [x] 测试：Rail 展开、SkillComposer（搜索 / 预览 / 键盘拖拽 / 保存）、IoSheet 溯源、门禁 hover、App 级。

## 6. web：工作台
- [x] `useWorkflowDefinition.ts` / `stageIo.ts` / `TaskDetailPane.tsx`：按分支 IO。
- [x] `taskModel.ts` / `TaskListPane.tsx`：阶段 facet 条件收紧。

## 7. 门禁
```bash
npm run typecheck:web && npm run test:web
npx vitest run packages/kernel packages/server packages/cli
npm run test:hooks
npm run check:default-workflow-freshness && npm run check:default-skill-matrix
npm run check:design-scale && npm run check:comments
npm run build:web && npm run build:server && npm run bundle
```
浏览器核对：工作流页展开 default → 切分支 → 阶段卡单名 → 技能浮层拖拽保存 → IO sheet → 门禁 hover；工作台任务详情按分支显示。重启 :18765。

## 8. 规格与收尾
- [x] `.trellis/spec/dashboard-app/frontend/component-guidelines.md`、`kernel/backend/`（新 `workflow-track-branches.md`）、`server/backend/`。
- [x] 只提交本任务文件；finish-work。
