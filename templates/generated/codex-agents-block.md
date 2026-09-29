<!-- PIPELINE:CODEX:START -->
## Tenon Workflow（Codex 静态层）

正常开发对话先调用 `tenon:tenon`：它创建或恢复 Change，按任务冻结的工作流逐步执行——每一步做什么
只看 `tenon status <change> --json` 的 `step.next`，没有另外的阶段技能要分派。
Todo 用 `tenon workflow plan <change> --json` 的步骤标签建立，当前项取 `current_step`；
不得先生成脱离工作流步骤的通用 Todo。

状态操作一律走 `tenon status` / `tenon get` / `tenon set` /
`tenon transition` / `tenon check`，勿手改 canonical state 或 `.pipeline.yaml` 投影。
已登记的规格文档需求语义变了，走 `requirements-changed` 回到规格步重新登记，不在实现步覆盖。

评审门（`gate: review`）离开前须对确切 transition event 取得人类显式确认：先运行
`tenon review request <change> --event <event>`；用户明确回复「确认继续」「继续执行」等放行语后
由 hook 写入回执，再照 `step.next` 执行。不能删除 marker 绕过 review-gate；verify-fail 与
verify-pass 的确认不可互用。
<!-- PIPELINE:CODEX:END -->
