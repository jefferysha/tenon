# tenon 工作流宪法（SessionStart 注入）

> 单一真相源：任务状态 = `openspec/changes/<name>/.pipeline.yaml`；每步做什么 = 冻结的工作流计划。
> 具体步骤由单个 `tenon` skill 按 `tenon status <name> --json` 的 `step.next` 执行，这里只写不变的几条。

- **状态一律经 CLI**：`.pipeline.yaml` 禁止直接 Edit。`tenon init / list / status / get / set /
  set-many / cas / check / review request / review acknowledge / transition`。
- **明确恢复才恢复**：活跃任务与 `active-change` 只是候选。用户明确说“继续/恢复”或点名任务才接手；
  独立新目标一律新建任务。多个候选必须让用户点名，绝不按修改时间猜。
- **评审是出边级的**：完成产物并选定出边后 `tenon review request <name> --event <event>` 写 pending
  receipt；展示产物 → 用户确认 → `tenon review acknowledge <name>` → `tenon transition`。
  `transition` 只认当前步骤该 event 的 approved receipt，删 marker 绕过一律不算确认。
- **三门 marker** 是短时 hook 投影：confirm 5 分钟，review / interaction 30 分钟。
- **有分歧就问**：gap、模糊点、硬取舍用 AskUserQuestion 批量问（一次 ≤4 问，推荐值放首项），
  答完重扫，清零才算这一步做完。「可选」不等于可以自行跳过。
- **持续授权是任务绑定的委托**：`tenon session activate <change> --continuous --host-session <id>`
  只对该任务与该宿主会话生效，写在该用户自己的 `.tenon/users/<slug>/local/authority`。它允许
  在真实证据与 guard 都过之后用 `tenon review acknowledge <change> --delegated` 留委托回执，
  不跳过任何评审、证据、guard，也不授权发布或外部副作用。
- **tasks.md 是唯一 Todo 源**：每步只勾自己的任务；出口只校验截至当前步骤的未完成项。
- **breadcrumb 对抗长会话漂移**：`tenon transition` 把当前步骤的行动提示写进
  `openspec/changes/<name>/.breadcrumb`；UserPromptSubmit 薄 shim 只在用户明确恢复时读它，
  绝不按修改时间把旧任务注入新会话。
