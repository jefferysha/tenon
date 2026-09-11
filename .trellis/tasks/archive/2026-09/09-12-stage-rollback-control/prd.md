# 阶段退回（替换「转移」表）

## Goal

把上一版的「转移」表换成阶段级的「退回」属性：本阶段做完之后，是往下走，还是**退回前面某一步重做**。

## 上一版错在哪

`09-11-stage-transitions-editable` 把 kernel 的数据结构（transition = 事件 + 去向）直接搬成了 UI，让用户逐条配「事件 + 去向」。这是把实现细节当成了产品概念。

核对 default 全部五条轨道的转移后确认：**每一条正向边都指向紧邻的下一个阶段，没有一条跳跃**。

```
open → explore → spec → build → verify → ship → archive
```

也就是说正向去向完全由阶段顺序决定——用户拖拽排序时已经定好了。再让他在表里选一遍去向，是把同一件事配两遍，而且可以配出「往后跳两级」这种流程里不存在的东西。

真正有信息量的只有一件事：**这个阶段要不要退回，退到哪一步。**

## Requirements

- 右栏「转移」段整段替换为「退回」段，位置仍在门禁之后。
- 一个下拉：`不退回`（默认）或 `退回到「<阶段>」`。选项只列**本阶段之前**的阶段，从源头上配不出往后跳。
- 界面上不出现正向去向，不出现事件名输入。
- 第一个阶段没有可退回的目标，整段不渲染。
- 左栏虚线弧是这个设置的可视结果：选了退回目标弧出现，选「不退回」弧消失。
- 退回是**阶段级独立属性**，不绑门禁。理由：default 里 `实现 → 规格`（`requirements-changed`）挂在门禁为「无」的实现阶段上，语义是「需求变了回去改规格」，不是验收不通过。绑门禁就表达不了它。
- 改退回目标时保留既有 transition 的 `event` / `guards` / `actions`。`verify-fail` 带着 `mark-verification-failed` 与 `reset-pre-verify-review`，丢了会静默改变运行时行为。
- 受治理工作流的必需退回边（`实现→规格`、`验证→实现`）仍不可移除，沿用既有 lint。

## 非目标

- 不改 kernel 的 transition 模型、不改 `governedLifecyclePolicy`。
- 不解决右栏整体过长需要滚动的问题（门禁在本次改动之前就已经在首屏之外），另行处理。

## Acceptance Criteria

- [x] 验证阶段显示「退回到「实现」」；选「不退回」后左栏虚线弧从 13 条掉到 12 条
- [x] 立项阶段段头只有 输入 / 技能 / 输出 / 门禁，不渲染退回段
- [x] 验证阶段下拉选项恰好是：不退回、退回到「立项」「调研」「规格」「实现」
- [x] 「不退回」再选回「实现」后 `dirty === false`，即定义与内建逐字节相同，`verify-fail` 与两条 actions 完整还原
- [x] 在 default 上把验证设为「不退回」或改到「规格」，段内提示「受治理工作流要求本阶段可退回「实现」」，保存禁用，强制点击零 POST
- [x] 页面全文搜不到「事件」「去向」
- [x] 四项前端门禁全绿（前端 652 用例）

## 实际改动

| 文件 | 改动 |
|---|---|
| `packages/dashboard-app/src/workflow/TransitionTable.tsx` | 删除 |
| `packages/dashboard-app/src/workflow/StageEditorPane.tsx` | 转移段换成退回段：一个下拉，选项只含本阶段之前的阶段；首阶段整段不渲染 |
| `packages/dashboard-app/src/workbench/workbenchDefinition.ts` | 四个转移动作换成 `backTransitionOf` / `backTargetOf` / `setStageBackInDef`（带 `template` 形参） |
| `packages/dashboard-app/src/workbench/useWorkflowEditor.ts` | 四个动作换成 `setStageBack`；加「不退回」摘除边的记忆 |
| `packages/dashboard-app/src/i18n/translations.ts` | 六个转移词条换成 `back_title` / `back_none` / `back_to`；contract lint 文案由「转移到」改为「退回」 |
| 两个测试文件 | 退回段 6 个 UI 用例 + 5 个纯函数用例 |
| `.trellis/spec/dashboard-app/frontend/component-guidelines.md` | 「Transitions section」整节换成「Send-back section」 |

## 中途抓到的一个静默数据丢失

我自己实机测「不退回 → 再选回实现」时发现 YAML 里 `verify-fail` 变成了 `verify-back`，`mark-verification-failed` 和 `reset-pre-verify-review` 两条 actions 全丢。

原因：`不退回` 删边，再选目标时按新建处理，事件名合成、actions 为空。而事件名是有语义的——`document-record-policy.ts:46` 按 `record.event === 'requirements-changed'` 判定 ADR 活文档兼容面。

修法：编辑器记住被摘掉的那条边（键 = 工作流 + 轨道 + 阶段），重新选目标时整条装回来只换 `to`。验证方式是来回切一次后 `dirty === false`——定义与基线逐字节相同。另加两条纯函数回归用例，一条锁住修复后的行为，一条把修复前的丢失路径显式钉成「不给 template 就是新建」。

## 未做

右栏在 900px 高窗口下仍需滚约 681px 才到门禁和退回（改之前是 775px）。这不是本次引入的——门禁在加转移段之前就已经在首屏之外，根因是两张大的只读派生表压在小的可编辑控件上面。属于对已定稿布局的结构调整，另行决定。
