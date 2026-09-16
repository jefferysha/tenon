# tenon 工作流宪法（SessionStart 注入 · lite 版）

> 蒸馏来源：老仓 workflow-plugin/workflow.md（L0–L3），命令面已全部换成本仓 Tenon CLI。
> 单一真相源：合法转换 / review 相位 = `templates/manifest.yaml`；change 状态 = `openspec/changes/<name>/.pipeline.yaml`。

## 一、7 相位协议

```
open → explore → spec ⇄ build ⇄ verify → ship → archive
```

- `requirements-changed` 是 build→spec 的受控需求回退；修订 proposal/design/tasks 后必须重新走
  spec review 与读取证据，禁止在 build 中伪造旧文档 SHA。
- `build ⇄ verify` 双向：verify 不过 → `verify-fail` 退回 build 返工；跨相位不并发（评审移动靶在因果上不成立）。
- **Shell-driven 状态变更（硬规则）**：`.pipeline.yaml` 一律经 Tenon CLI 读写，**禁止直接 Edit**：
  - `tenon init <name> --track <t> --preset <p>` 建 change；`tenon list` / `tenon status [name]` 看现状
  - `tenon get / set / set-many / cas` 读写字段（四闸拒写保格式兼容）
  - `tenon check <name>` 过成功出口 guard（只校验不推进）；review 相位通过后还须
    `tenon review request <name> --event <event>` → 人类确认 → `tenon review acknowledge <name>` →
    `tenon transition <name> <event>` 推进。多出口 review step（default 的 verify / 自定义 workflow）必须指定 event。
  - `tenon inbox` 汇总待办交互；`tenon import <name>` 迁移老仓历史
- **明确恢复才恢复**：`tenon list` 的活跃 change 与用户自己的 `active-change` 都只是恢复候选，不能在会话开始自动绑定。只有用户明确说“继续/恢复”或点名 change，才从其 `.pipeline.yaml` 相位继续；任何独立新目标都从 `open` 创建新 change。多个候选时必须让用户点名，绝不按 mtime 猜测。
- `tasks.md` 是七阶段持续演进的唯一 Todo 源。每个 phase 只能勾选并重登记自己的任务；出口只校验
  截至当前 phase 的未完成项，未来 phase 的 checkbox 必须显示但不能反向阻塞。

## 二、三门语义（交互门 marker）

项目根的 `.pipeline-pending-confirm` / `-review` / `-interaction` 三门 marker 是短时 hook 投影：
confirm 新鲜期 5 分钟，review / interaction 新鲜期 30 分钟。

- 进入 review 相位（explore/spec/verify）后可以正常完成本相位工作；**不得**因为刚进入就写
  review marker。完成产物并选择待走的出边后，运行 `tenon review request <name> --event <event>`：
  它在 canonical state 写入 exact-phase-and-event pending receipt，再写含 Change identity 与 event 的 v2 marker。
- 先把产物路径、摘要和待确认取舍展示给用户。用户明确确认后，Codex 档 A/B 的 UserPromptSubmit hook
  调用 `tenon review acknowledge <name>` 写入 approval receipt 并清投影；支持 AskUserQuestion 的宿主
  仅在回答中明确批准时做同一动作。档 C 必须保留确认事实并显式运行 acknowledge，**不得删 marker 绕过**。
- `tenon transition` 只接受当前 review phase 的 exact approved receipt（同一个 phase 的不同 event 不可互用；
  dashboard 的显式真人点击是同一 approval 语义）；成功转换立即消费 receipt。v2 marker 只作用于用户 `active-change` 明确选中的 Change，
  不会让旧 Change 锁住无关的正常对话。被拦的写操作仍需在确认后重新发起。

## 三、HITL 原则（交互硬姿态）

1. **任何分歧 / gap / 模糊点 → 转成问题问用户，禁止自行假设糊弄**。用 AskUserQuestion 批量问（一次 ≤4 问，推荐答案标注放首项），答完重扫一遍，gap 清零才算相位完成。
2. **「可选 / 条件」≠ 自行跳过的授权**：做不做本身是决策点，交用户拍板；唯一例外是纯客观事实可定的选型。
3. **终态 = 用户在硬取舍上做了承诺，不是文档写出来了**。review 相位先 `check → review request --event <event> → 展示产物 → acknowledge`，再 transition；非 review 相位同样要展示产物并等明确确认，不 solo 跑完直接推进。
4. 高风险问题当场逼出明确决断，不许「都要 / 先这样」收场。
5. **明确持续授权是 Change 绑定的委托，不是总开关**：用户明确说“后续不用问 / 自主执行完成”时，入口以
   `tenon session activate <change> --continuous --host-session <id>` 写入同时绑定该 live Change 与
   当前 host session 的版本化授权投影（落在该用户自己的 `.tenon/users/<slug>/local/authority`，
   不会放行另一个用户）。
   交互式 skill 可对低风险细节采用保守默认，并把假设/理由写入产物；它不得跨 Change 继承，用户说
   “恢复逐步确认 / 撤回自主执行”即可撤回。该投影允许在 **真实 review 证据、OpenSpec 文档读取收据与
   guard 均已通过之后**，用 `tenon review acknowledge <change> --delegated` 记录一条带授权时间的
   委托 review receipt，再走精确 transition；它不跳过任何 review、证据、guard、验证，也不授权发布、
   外部副作用或范围/安全/成本的实质决策。

## 四、breadcrumb 约定（对抗长会话漂移）

- CLI 在 `tenon transition` 时按 manifest 把当前相位面包屑写进 `openspec/changes/<name>/.breadcrumb`；UserPromptSubmit 薄 shim（hooks/breadcrumb.sh）只在用户明确恢复时读取指定/唯一候选，绝不按 mtime 把旧 change 注入新会话。
- 铁律：某相位的必做步骤若没进 breadcrumb，AI 会随会话变长悄悄跳过——改必做步骤只改 manifest 一处。
- 清窗纪律：相位之间（尤其 spec→build、build→verify）默认提示 `/clear`，靠 `.pipeline.yaml` + 本宪法注入在干净会话重建上下文。
