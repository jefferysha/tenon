# Design · 工作流页 UI v2

## 边界

只改 `packages/dashboard-app/src/{workflow,shell/ThreeColumns.tsx,shared/MenuButton.tsx,i18n}`。
kernel / server 不动。hook `useWorkflowEditor` 删去不再有 UI 的 `addOutput / removeOutput / setInput`
及其 `workbenchDefinition` 助手与 `slotCatalog`（一切从简：删功能，不搬功能）。

## 组件

- `shell/ThreeColumns.tsx`：`ThreeColumns` 新增 `listWidth?: 'default' | 'narrow'`（narrow = 380px /
  ≤1279px 344px）。`RailColumn` 新增 `headerAction?: ReactNode`（标题右侧的 `+`），`footer` 仍可选。
- `shared/MenuButton.tsx`：`⋯` 按钮 + `role=menu` 弹层（Esc / 点外关闭；`items: {id,label,icon,onSelect,disabled,danger}`）。
- `workflow/WorkflowRail.tsx`：行 = `RailCard`（name / source tag / count）+ 行内动作区（`+` 轨道、`⋯`）；
  轨道子列表每行 `label ?? id` + hover `×`。折叠态只显首字母与顶部 `+`。
- `workflow/PipelineList.tsx`：`ListColumn` eyebrow = 工作流名，title = 轨道 label（无轨道时 = 阶段）。
  节点 = 序号拖柄（脊柱上）+ 卡片（名称 + 门禁 pill）；卡片间脊柱段带门禁节点（盾 / 闪电小圆）；
  回流边 = 卡片下小 pill `↺ <stage>`；末尾脊柱上的 `+` 添加阶段。
- `workflow/StageEditorPane.tsx`：`view: 'stage' | 'outputs' | 'inputs'` 状态。
  header = 面包屑（`wb-crumbs`）+ 可编辑标题 input（`wb-lane-name-input-<id>`）+ 位置 `n / N`
  + 右侧删除图标；view ≠ stage 时标题 = sheet 名，面包屑最后一项前一项为可点返回的阶段 crumb。
  正文（stage）= 技能（`SkillWaveCards`）→ IO 摘要卡 × 2 → 门禁。正文（outputs/inputs）= `SlotList`。
- `workflow/SkillWaveCards.tsx`：按 `wavesOf` 分行：左侧步序圆点 + 竖线，右侧卡片流；同波次 ≥2 标 `∥ 并行`；
  卡片 = 来源图标 + mono 名称 + description（2 行截断）。点卡片 → `SkillDetailDrawer`。
- `workflow/SlotList.tsx`（替代 IoSections）：只读行。行 1：类型图标 + `slotLabel` + 锁；行 2：
  `slot-skills-<id>`（产出技能芯片，`SkillSourceIcon` 由 registry 查来源）+ `slot-stages-<id>`
  （输出：`→` 读取阶段；输入：`←` 产出阶段）。YAML 路径放 `title`。

## 数据流

不变：`editor.def / effectiveIo / branches / labelOf / mandatory.registry`。技能 description 与来源来自
`editor.mandatory.registry`（`WbSkillEntry.description / source`），查不到时只显名称。

## 兼容

`wb-step-<id>`、`wb-lane-name-<id>`、`wb-lane-name-input-<id>`、`wb-dirty`、`wb-save`、`wb-discard`、
`wb-lane-gate-<id>-*`、`wb-skills-edit`、`skill-preview`、`stage-drag-overlay` 等 testid 保留。
删除的 testid：`branch-tab-*`、`wb-open-outputs/inputs`、`output-picker/add/remove`、`input-check-*`、
`outputs-sheet/inputs-sheet`、`wb-track-new`（改为 `wb-track-new-<wf>`）、`wb-track-delete`（改为带 track id）。
