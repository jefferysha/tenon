# 执行计划：阶段转移可编辑

## 顺序

1. **i18n**：`translations.ts` 加 `workflow.transitions_title` / `col_event` / `col_to` / `add_transition` / `delete_transition` / `no_transitions` 及三条 lint 文案，中英各一份。
2. **编辑器动作**：`useWorkflowEditor.ts` 加 `addTransition` / `setTransitionEvent` / `setTransitionTo` / `removeTransition`，按下标改写，`guards` / `actions` 原样保留。
3. **lint**：`lint.ts` 加三条规则与类型，并在 `issuesFor` 消费处对齐。
4. **组件**：新建 `TransitionTable.tsx`，照 `IoTable` 的表头 / 行节奏，行内事件输入 + 去向 select + 删除。
5. **接线**：`StageEditorPane.tsx` 在门禁段之后加 `<section data-testid="stage-transitions">`。
6. **测试**：`StageEditorPane.test.tsx` 加用例（渲染、增删改、只读态）；`lint` 三条规则各一条单测。
7. **实机**：Playwright 验收——加回流后左栏出弧、保存回写 YAML、default 上删必需转移被挡。

## 验证命令

```bash
npm run test:web && npm run typecheck:web && npm run check:design-scale && npm run check:comments
```

## 复核门

- 步骤 4/5 后截图核对：转移段与上面四段的段头、表头、行高、字号必须一致，看不出是后加的。
- 步骤 7 前先确认全局工作流目录干净，测完清掉测试工作流。

## 回滚点

步骤 1-3 是纯新增（无人调用），可单独保留；4-5 是可见改动，一起回退。
