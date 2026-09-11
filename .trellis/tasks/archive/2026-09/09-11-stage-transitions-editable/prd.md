# 阶段转移可编辑（含验收不通过回退）

## Goal

让用户在工作流页上直接编辑每个阶段的转移，包括指向靠前阶段的回流。回流表达的语义是：**该阶段验收不通过，退回上一轮修问题**。

## 现状

内建 default 已经有两条回流，五条轨道一致：

| 从 | 事件 | 到 |
|---|---|---|
| 实现 | `requirements-changed` | 规格 |
| 验证 | `verify-fail` | 实现 |

左栏用右侧虚线弧把它们画了出来，`tenon transition <change> verify-fail` 真的会走这条边。但页面上**配不了**：右栏只有输入 / 技能 / 输出 / 门禁，`StageEditorPane.tsx` 里没有 transitions。页面只在三处间接改转移——拖拽排序改写那条指向下一阶段的线性转移、加阶段追加 `<id>-complete`、删阶段把指向它的转移改指后继。用户想加一条「交付验收不通过退回实现」，只能导出 YAML 手改再导入成另一份工作流，或者直接编辑全局文件。

## Requirements

- 右栏新增「转移」段，位置在门禁之后，整体顺序变为 **输入 → 技能 → 输出 → 门禁 → 转移**。门禁决定放不放行，转移决定放行/打回之后去哪，相邻符合阅读顺序。
- 每行两列数据加一个删除：**事件** 可改名、**去向** 从本轨道阶段里选。段头一行「转移 · 计数 · 添加」，与技能段的「编辑」动作同构。
- 所有转移一视同仁，线性转移与回流用同一种行，不分两个区、不加「回流」标签——去向是靠前阶段这件事由左栏那条虚线弧表达，页面上同一概念不说两遍。
- 保存写回 YAML 的 `transitions`。
- 受治理工作流（default 与 `openspec_contract: required`）的必需转移不得删：`CANONICAL_TRANSITIONS` 要求 `build` 能到 `verify` 和 `spec`、`verify` 能到 `ship` 和 `build`。服务端已 fail-closed，前端要在保存前就 lint 出来并挡住保存，而不是让用户吃一个 400。

## 非目标

- 不做工作流保存历史 / 版本回退。用户已明确「回滚」指的是流水线语义上的阶段回退，不是存储版本。
- 不改转移引擎、不改 guard、不改 `CANONICAL_TRANSITIONS` 本身。
- 不动左栏虚线弧的画法（已定稿）。

## Acceptance Criteria

- [x] 在「交付」加了一条 `ship-reject → 实现`，保存后全局 YAML 里 `ship.transitions` 出现该条目
- [x] 去向选「实现」的瞬间，左栏虚线弧从 13 条变 14 条
- [x] 事件名、去向、删除三个回调都实测到位；「添加」缺省去向是下一阶段
- [x] 在 default 上删掉 `verify-fail → 实现`：段内提示「受治理工作流要求本阶段可转移到「实现」」，保存按钮禁用，页脚显示「有未解决的问题，不能保存」，强制点击后**零 POST 请求**
- [x] 事件名为空 / 同阶段重名各有单测
- [x] 无写入凭证时事件、去向、删除全部禁用，段头不出现「添加」
- [x] `npm run typecheck:web && npm run test:web && npm run check:design-scale && npm run check:comments` 全绿（前端 638+ 用例）

## 实际改动

| 文件 | 改动 |
|---|---|
| `packages/dashboard-app/src/workflow/TransitionTable.tsx` | 新建。等分两列加删除列，照 `IoTable` 的表头 / 行节奏 |
| `packages/dashboard-app/src/workflow/StageEditorPane.tsx` | 门禁之后加转移段，段头带「添加」；本阶段转移 lint 翻成文案显示在段内 |
| `packages/dashboard-app/src/workbench/workbenchDefinition.ts` | 四个纯变换：增 / 改事件 / 改去向 / 删，按下标定位，`guards`·`actions` 原样保留 |
| `packages/dashboard-app/src/workbench/useWorkflowEditor.ts` | 四个动作接进编辑器，与 `setGate` 同层 |
| `packages/dashboard-app/src/workflow/lint.ts` | 三条规则 + `CONTRACT_TRANSITIONS`（与 kernel `CANONICAL_TRANSITIONS` 逐条对齐）|
| `packages/dashboard-app/src/i18n/translations.ts` | 中英各六个新词条；`lint_blocked` 由「有阶段缺输出」改为中性的「有未解决的问题」|
| 两个测试文件 | 转移段 5 个 UI 用例 + 3 条 lint 规则用例；补全 `fakeEditor` 桩 |
| `.trellis/spec/dashboard-app/frontend/component-guidelines.md` | 新增「Transitions section」一节 |

## 一处视觉返工

去向下拉初版占满整列，原生箭头飘到列最右，和「交付」两个字之间空一大段，看着脱节。改成 `justify-self-start` + `max-w-full` 宽度贴合内容，箭头紧跟值。

## 踩坑记录

`StageEditorPane.test.tsx` 的 `fakeEditor` 是 `as unknown as WorkflowEditor` 的部分桩，没有 `lint` 字段。新代码读 `editor.lint` 后五个既有用例直接崩在 `issuesFor` 的 `.filter`。补桩而不是在生产代码里 `?? []` 兜底——后者会把类型契约的缺口藏起来。
