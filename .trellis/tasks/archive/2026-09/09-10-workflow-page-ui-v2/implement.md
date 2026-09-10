# Implement · 工作流页 UI v2

1. `ThreeColumns`：`listWidth`、`RailColumn.headerAction`。
2. `shared/MenuButton.tsx` + 测试（打开 / Esc / 选择）。
3. `WorkflowRail` 重写 + 更新 `WorkflowRail.test.tsx`。
4. `PipelineList` 重写（去技能芯片、去页签、门禁节点、脊柱 `+`）。
5. `SkillWaveCards.tsx`、`SlotList.tsx`；删 `IoSections.tsx`、`slotCatalog.ts`。
6. `StageEditorPane` 重写（面包屑 sheet）；`useWorkflowEditor` / `workbenchDefinition` 删 IO 编辑助手；
   `workflowModel.test.tsx` 去掉 slotCatalog 用例。
7. i18n：删 `add_output / add / remove_output / consumed_by / produced_by / produced_by_skills / from_stage /
   no_upstream / open_outputs / open_inputs / branch_base(保留，单 pipeline 仍用) / card_skills / settings_name`；
   增 `workflow_menu / delete_stage / read_by / from`。zh/en 对齐。
8. 新测试：`StageEditorPane.test.tsx`（面包屑切换、只读 IO 行、技能卡片）。
9. 门禁：`npm run typecheck:web && npm run test:web && npm run check:design-scale && npm run check:comments && npm run build:web`。
10. Playwright 目检 1440 / 1200 宽；重启 :18765。
11. spec：`component-guidelines.md` 工作流规则段重写；新增「IO 推导原理与已知限制」。
12. 提交仅本任务文件；finish-work。
