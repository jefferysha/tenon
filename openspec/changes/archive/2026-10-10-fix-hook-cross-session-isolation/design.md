# 设计

## 已定决策

完整设计见 `docs/superpowers/specs/fix-hook-cross-session-isolation-design.md`，决策记录见 `docs/adr/fix-hook-cross-session-isolation.md`。要点：

- **会话归属解析**：`hooks/active-change.sh` 新增 `pipeline_session_change_dir <root> <session_id>`，按以下顺序判定：
  1. 本会话有绑定，用绑定的 Change。
  2. 没有本会话绑定、而共享指针指向的 Change 已绑到别的会话，判为无。
  3. 宿主不给 id，或该 Change 无人绑定，回退共享指针。

  所有拦截与记证据的 hook 改用它，恢复候选不变。（用户确认：集中修。）
- **一个 Change 只绑一个会话**：`session activate --host-session` 自动移交，删除其他会话对同一 Change 的绑定并在 stderr 提示（用户确认）。
- **会话恢复换 id**：落入规则 2。在重新 activate 前，本会话的拦截不生效、不代为确认、不记证据；离开评审步仍需 canonical 回执。
- **交互标记 v2**：写入 `change=`、`session=`、`skills=`、`requested_at=`，只拦、只解归属会话；旧格式见到即删除（用户确认）。宿主给了会话 id 时按会话分文件 `.pipeline-pending-interaction.<会话>`（验证步评审后用户确认），没给时用单个文件；指纹、交付提交与 `advance` 硬门同等对待两种文件。`.pipeline-pending-confirm` 当前没有写入方，只保持兼容。
- **放行语**：对话回复与 AskUserQuestion 答案都改为整条短回复匹配（用户确认）。
- **撤销**：`tenon review revoke <change> --reason <原因>`，在 canonical 锁内把当前步已批准、未消费的回执撤回为同一 event 的「待确认」并重写评审标记，写 `review.revoked` 审计事件；agent 可执行（用户确认）。
- **已污染状态本任务处理**（用户确认）：给 `setup-host-agents-step-progress` 的历史追加更正事件（第 18-24、63 行来自本会话，不删原行）；撤销上线后撤回它误记的规格批准；`unify-stage-skill-canvas` 恢复后重新加载调研技能补证据。
- **源码开发安装与漂移检查**（规格阶段加入，用户确认）：`tenon setup --<host> --from-source <repo>`，插件市场指向仓库目录、运行时从工作区构建，release 记 `channel: dev` 与 commit / 摘要；上游技能与拉取索引不入库、安装时缺了自动拉取、失败中止；开发安装关闭 auto-update，`tenon update` 默认拒绝、`--to-stable` 回正式；源码仓库内会话开始比较已装与工作区并提示同步命令。实施先做一次实验验证本地目录市场的缓存行为与宿主对账依赖。
- **测试先行**：`tools/test-hooks.sh` 两会话场景与放行语用例，CLI 撤销命令 vitest。
- **步骤测试豁免**（验证步加入，用户确认）：测试计划豁免增加第三种键 `test:<步骤测试 id>`，id 用工作流编译步骤测试时的同一校验。
  - 判定落在策略判定的内联步骤测试一侧：只对必需测试的新鲜失败生效。已批准则放行并留提示，未批准则以 `waiver-unapproved` 阻塞；评审请求时放行并列出，转换时仍要求批准。
  - 编排侧用 `waived` / `waiver-pending` 两个状态，让 `next` 不再发 `run-test`，也不把它当作必需证据失败。评审者就绪与结论字段核对同口径。
  - 没有 `test_policy` 的步骤（只可能是自定义工作流）不读计划，豁免不生效，文档注明。
  - 详见 `docs/superpowers/specs/fix-hook-cross-session-isolation-design.md` §8。
- **验证评审后的修正**（用户逐条确认，详见设计文档 §9）：
  - agent 不能自己执行手动 `tenon review acknowledge`：gate 任何时候都拒绝，确认只经放行语、Dashboard、用户本人终端三条路；宪法与适配器说明同步。
  - 步骤测试豁免的批准绑定被批准的代码候选，代码变了再失败要先 `review revoke` 再重新确认；豁免理由标注为登记者自述。
  - `session activate` 先写本会话绑定再移交，在 Change 锁内完成。
  - 漂移检查的判据是安装内容摘要与技能索引摘要，commit 只展示；提示里的路径加引号，含控制字符不提示。
  - `--from-source` 会执行所给仓库的构建并长期安装其 hooks，记为已知风险。
  - `review revoke` 撤回豁免批准推迟到后续任务。
- **第三、四轮验证评审后的 gate 加固**（用户确认回退修复，详见设计文档 §10）：手动 acknowledge 判定移到 `hooks/lib/ack-command.sh` 按需加载；判定前还原引号、反斜杠、转义编码与花括号；`--delegated` 只认不在含空白引号串里的词；`review` 之后按真实参数结构找子命令；读取上限 64 KiB。
- **验证轮次上限**（第四轮验证后用户提出，逐条确认，详见设计文档 §11）：
  - 设了评审门且有回退边的步骤可声明 `max_rounds`（1–20），`default` 的 verify 步为 2；未声明与旧计划按内置默认 2；任务用 `tenon set <change> max_rounds <N>` 覆盖。没有评审门的 build 不受约束，`requirements-changed` 始终可用。
  - 轮次 = 自上次重新计数以来进入该步的次数；落到早于该步所有回退目标的步骤（`requirements-changed` 回规格）时清零；取 canonical 转换链。
  - 用完且必需证据不通过：`next` 不再给回退边，改发接受剩余阻断的评审请求（有未登记豁免的失败测试时发 `stop`）；回退边的评审请求与转换被拒。
  - 剩余阻断按 `reviewer:<agent>` 冻结，用户确认时接受，绑定候选与评审者运行；委托确认拒绝。
  - 调高上限是用户的决定，agent 不自行调高（同机同用户信任模型，技能与宪法写明）。
  - 从 verify 回规格没有直达的边：出路文案按计划写明两步路径（用户调高上限 → `verify-fail` 回 build → `requirements-changed`），上限「调到高于当前轮次」才恢复回退（实现阶段发现，规格措辞随之修正）。
  - 就绪预审后加固：发现摘要去掉控制字符与双向字符、历史行带摘要；有链头却缺读取依赖时计数报错；Dashboard 读不出冻结清单时拒绝确认。

## 风险

- hook 热路径保持纯 bash；解析要扫描 terminal-sessions 绑定文件，需限制单文件大小、评估数量增长。
- 收紧放行语后，较长的确认说法不再放行。
- 撤销与 acknowledge / transition 的锁互斥；撤销后重新 request 是否计入评审次数预算，待核实。
- 手动确认的拒绝是 gate 对命令文本的静态判定：变量拼出的命令名、脚本文件里的调用不在覆盖内；真正的边界仍是同机同用户的信任模型。
- 改完要重装本地运行时才生效；已被污染的历史状态需要人工处理。
- 工作流新增 `max_rounds` 键会改变编译后的计划形状与指纹；旧冻结计划要照常读取，并按内置默认处理。
- agent 能执行 `tenon set … max_rounds`，「不自行调高」只靠技能约束与同机同用户信任模型，没有技术强制。
- build 不受上限约束：agent 在 build 上执行 `requirements-changed` 回规格会让轮次清零，但每次都要再过规格评审门的人工确认。
- 设置过 `max_rounds` 的任务、带剩余阻断记录的冻结清单，升级前的运行时读不了（失败关闭）。
- Dashboard 的评审者面板与 `tenon agent next` 不读接受记录，接受剩余阻断后仍显示评审者不通过（只影响展示）。

## 待验证问题

- 撤销与 `review-attempt-budget` 的关系（规格步核实）。
- 本地目录市场是否复制被 .gitignore 忽略的上游技能、Codex 是否支持本地目录市场（实施计划 B 部分第一个任务实测）。
- 子代理内 Claude Code hook 的 `session_id` 是否等于父会话 id：官方无明文，实施时用真实会话验证；若不同，子代理落入规则 2，影响仅限拦截体验。
