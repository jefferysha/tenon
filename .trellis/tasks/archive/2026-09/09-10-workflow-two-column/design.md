# Design · 两栏定稿实现

## 组件
- `shell/ThreeColumns.tsx` 新增 `TwoColumns({ nav, detail })`：`grid-cols-[300px_minmax(0,1fr)]`，≤900px 纵向堆叠。
- `workflow/WorkflowNav.tsx`（替代 WorkflowRail + PipelineList）：
  - 头：`wb-wf-switch`（名字 + ChevronDown，弹出 `role=listbox` 工作流列表，选中项 aria-selected）、副行、`MenuButton wb-wf-menu`。
  - 轨道页签 `role=tablist`（`wb-track-<id>`）+ `wb-track-new`。
  - `StageSteps`：dnd-kit sortable；行高固定 40 + 间距 14；圆点 `wb-stage-handle-<id>`；块 `wb-step-<id>`；回流弧 SVG 由索引算坐标（`backEdgePath(fromIndex, toIndex)` 纯函数，导出测试）。
- `workflow/IoTable.tsx`（替代 SlotList）：`columns: 'inputs' | 'outputs'`；行数据 `SlotRow { slot, stage?: string, skills: string[] }`。
- `workflow/SkillFlow.tsx`：`skillsToGraph(skills, registry) → { nodes, edges }`（x = 波次 × 272，y = 组内序 × 104）；`graphToSkills(nodes, edges, original) → WbSkillRef[]`（保留 kind / review_lane）；`SkillFlow({ skills, registry, editable, onChange, onOpen })` 包 `ReactFlow`。只读：`nodesDraggable=false`、无 connect。可编辑：`onConnect` 加边（自环 / 反向成环拒绝，用 `wouldCycle`）、`onEdgesDelete` / 节点 × 移除、`onDrop` 接技能库的 HTML5 拖放（`dataTransfer 'text/skill'`）。
- `workflow/SkillComposer.tsx`：中栏换成可编辑 `SkillFlow`，去掉 SkillDag / dnd-kit；保存 `onSave(skills)`；`useWorkflowEditor.setSkills(stepId, skills)` 新增，`setSkillWaves` 删除；`workbenchDefinition.setStepSkillsInDef`。
- `workflow/StageEditorPane.tsx`：单行段头；IoTable ×2；SkillFlow；门禁图标三选。
- 删除：`WorkflowRail.tsx`（+test）、`PipelineList.tsx`、`SkillDag.tsx`、`SkillWaveCards.tsx`、`SlotList.tsx`、`skillWaves.ts` 中 `wavesToSkills` 若无消费者则删。

## 数据
不变：`useWorkflowEditor` 的 def / branches / effectiveIo / labelOf / registry。IO 行推导沿用上一任务的 `producerSkills`。

## 测试
- `WorkflowNav.test.tsx`：切换列表、菜单项、页签、回流弧、无 tracks。
- `SkillFlow.test.ts`：`skillsToGraph` / `graphToSkills` / `wouldCycle` 纯函数；组件测试用 `vi.mock('@xyflow/react')` 渲染节点列表。
- `StageEditorPane.test.tsx` 更新为表格断言。
