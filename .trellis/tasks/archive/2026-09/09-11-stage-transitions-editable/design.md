# 设计：阶段转移可编辑

## 视觉与交互：不发明新语言

右栏已经定稿，四段同构：`<section class="grid gap-3.5 py-6">` + `SectionHead(title, count, action)` + 内容，段间 `divide-y divide-border`。转移段照抄这套，读起来必须和上面四段分不出来。

```
转移  2                                    + 添加
─────────────────────────────────────────────────
事件                      去向
verify-pass               交付                 ×
verify-fail               实现                 ×
```

- 表头与行沿用 `IoTable` 的节奏：表头 `text-caption text-text-3` 带下边框，行 `border-b border-border py-2.5 text-body`。
- 事件用等宽体，和 IO 表「文件」列一致——两者都是写进 YAML 的标识符。
- 去向是 `<select>`，选项为本轨道各阶段的 `label ?? id`。名称只显示一个，不做 id 翻译。
- 行尾 `×` 与轨道页签的删除同形。
- 段头动作「添加」，与技能段的「编辑」同一种按钮。
- 只读态（无 token）整段禁用，与其它段一致。

**不做的**：不分「顺序转移 / 回流」两个区，不给回流加芯片或标签，不画箭头图示，不在行里写解释句。去向是靠前阶段这件事，左栏那条虚线弧已经说了；同一概念只说一遍。

## 数据流

`WbStepDef.transitions: { event: string; to: string; guards?; actions? }[]` 已经在类型里，服务端 POST 也已接收——不需要新接口。

新增编辑器动作，挂在 `useWorkflowEditor` 上，与 `setGate` / `renameStep` 同层：

```ts
addTransition(stepId): void            // 追加一条空事件、去向=下一阶段（无下一阶段则本阶段首个非自身）
setTransitionEvent(stepId, index, event): void
setTransitionTo(stepId, index, to): void
removeTransition(stepId, index): void
```

用下标而不是事件名定位：事件名正在被编辑，中途会重复或为空，不能当键。

`guards` / `actions` 原样透传，编辑事件名和去向不得丢掉它们（`spec-complete` 带着 `reset-pre-verify-review`，丢了会静默改变运行时行为）。

## 校验

`lint.ts` 加三条，走既有 `editor.lint` → `blocked` → 禁用保存的通路，用户在点保存前就看到原因：

| kind | 触发 | 文案要点 |
|---|---|---|
| `transition-empty-event` | 事件名为空 | 指出是哪个阶段 |
| `transition-duplicate-event` | 同一阶段内事件重名 | 引擎按事件名分派，重名无法判定 |
| `transition-contract-required` | 受治理工作流缺 `CANONICAL_TRANSITIONS` 要求的去向 | 指出缺哪条 |

第三条的判据与 kernel 一致：`def.openspecContract === 'required' || def.name === 'default'`，这正是 `draftEffectiveIo` 里 `lockedDocuments` 用的同一个判断，复用它避免第二套真相。

去向指向不存在的阶段不可能发生：`<select>` 的选项就是现存阶段，删阶段时既有逻辑会把指向它的转移改指后继。

## 与既有自动维护的关系

拖拽排序仍然改写「指向下一阶段」的那条转移（`reorderStagesInDef` 的 `linearTransitionIndex`），加阶段仍追加 `<id>-complete`，删阶段仍改指后继。这三条不动。

代价：用户手写的转移图不再是线性链时，拖拽排序可能改写一条用户本来另有用意的边。这是既有行为，本次不改——改它要重新定义「哪条是线性转移」，风险大于收益。写进 spec 备案。

## 回滚

改动集中在 `StageEditorPane.tsx`、`useWorkflowEditor.ts`、`lint.ts`、`translations.ts` 与一个新组件，独立一次提交，`git revert` 即可。
