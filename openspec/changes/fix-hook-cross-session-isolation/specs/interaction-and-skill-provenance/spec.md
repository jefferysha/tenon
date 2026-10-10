# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Prompt intent SHALL have one source-only classification contract

Resume, new-objective, Workflow-selection, one-turn approval, continuous
authorization, revocation, rejection, and constraint phrases SHALL be classified
by one shared source-only contract used by router, breadcrumb, confirmation, and
review hooks. The classifier SHALL bind an approval to the unique current pending
question, Change, phase, and event rather than requiring one fixed reply string.
Deterministic rejection, revocation, and scope-constraint rules SHALL take
precedence over approval phrases.

Callers MAY apply different authorized actions to the same classified decision,
but SHALL NOT maintain divergent phrase vocabularies. Low-confidence or
conflicting input SHALL remain pending and request one minimal clarification; it
SHALL NOT fabricate approval.

一条回复只有在去掉首尾空白与句末标点后**整条**等于放行语清单中的一项时，才 SHALL 被判为放行；放行语出现在更长的文本、引用或粘贴内容之中 MUST NOT 构成放行。AskUserQuestion 的答案 SHALL 使用同一判定函数，只看答案值本身（去掉「 (Recommended)」「（推荐）」后缀），MUST NOT 在问题文本或整段工具响应中做子串匹配。

#### Scenario: Bare continue resumes with no pending receipt

- **WHEN** the user says `继续` and exactly one eligible Change exists with no
  pending interaction or review
- **THEN** routing may resume that Change
- **AND** no approval or continuous authority is fabricated.

#### Scenario: Bare continue approves the exact pending interaction

- **WHEN** the selected Change has an exact current pending interaction or
  review and the user says `继续`
- **THEN** the hook records/clears only the authorized matching receipt or
  marker
- **AND** the retried write can proceed
- **AND** no other Change or event is approved.

#### Scenario: New objective contains the word continue

- **WHEN** the user says not to continue and names a new objective
- **THEN** new-objective rejection precedence prevents old-Change resume and
  approval.

#### Scenario: Natural reply approves the unique pending recommendation

- **GIVEN** exactly one current pending question has a recommended option
- **WHEN** the user replies `可以`, `按推荐`, or `继续，按照你的推荐`
- **THEN** the classifier approves only that option for the exact pending target
- **AND** the user is not required to repeat a magic phrase
- **AND** no continuous or cross-Change authority is fabricated.

#### Scenario: Mixed approval preserves its constraint

- **GIVEN** one current pending implementation question
- **WHEN** the user says `继续，但先别改代码`
- **THEN** the decision contains approval plus a `no-code-write` constraint
- **AND** only actions compatible with that constraint may proceed.

#### Scenario: Ambiguous reply does not clear the marker

- **GIVEN** more than one pending target could match a reply
- **WHEN** the reply does not identify one target
- **THEN** no approval receipt is created
- **AND** the pending interaction remains intact.

#### Scenario: 粘贴文本里的放行语不构成放行

- **GIVEN** 本会话任务有一条待确认的评审
- **WHEN** 用户的回复是一段粘贴进来的长文本，其中包含「确认继续」
- **THEN** 不写入任何评审回执，待处理标记保持不变
- **AND** hook 输出未识别为确认的提示

#### Scenario: 整条短回复构成放行

- **GIVEN** 本会话任务有一条待确认的评审
- **WHEN** 用户的整条回复是「确认继续。」
- **THEN** 只为本会话任务的该评审写入回执

#### Scenario: AskUserQuestion 只看答案值

- **WHEN** AskUserQuestion 的问题文本或选项说明里含「确认继续」，而用户选的答案是「先不放行」
- **THEN** 不构成放行
- **AND** 当答案值是「确认继续 (Recommended)」时构成放行

## ADDED Requirements

### Requirement: 拦截与记证据的 hook SHALL 按会话解析本会话任务

所有做拦截（评审门、交互门、技能顺序门、动画门）、代为确认、或记录技能 / 决策 / 测试证据的 hook SHALL 通过同一个解析得到「本会话任务」，并且 MUST 按以下顺序判定：

1. hook 输入带合法 `session_id`，且该会话有会话绑定：本会话任务就是绑定的 Change。
2. hook 输入带合法 `session_id`、该会话没有绑定，而恢复候选指向的 Change 已被别的会话绑定：本会话没有任务。此时 hook MUST NOT 拦截、MUST NOT 代为确认、MUST NOT 把证据记到该 Change。
3. 宿主没有提供 `session_id`，或恢复候选指向的 Change 没有任何会话绑定：回退为恢复候选。

只做恢复候选的路由与 breadcrumb hook SHALL 保持原有语义。

#### Scenario: 另一个会话的评审不拦本会话

- **GIVEN** 会话 A 绑定 Change A，会话 B 绑定 Change B，恢复候选指向 Change A
- **AND** Change A 有一条待确认的评审
- **WHEN** 会话 B 调用写类工具
- **THEN** 门禁放行
- **AND** 会话 A 调用写类工具时仍被拦截

#### Scenario: 另一个会话的放行语不确认本任务

- **GIVEN** 同上，Change A 的评审待确认
- **WHEN** 用户在会话 B 中整条回复「确认继续」
- **THEN** 不为 Change A 写入回执

#### Scenario: 技能证据记到本会话任务

- **GIVEN** 会话 B 绑定 Change B，恢复候选指向 Change A
- **WHEN** 会话 B 加载一个技能
- **THEN** 技能证据只写入 Change B
- **AND** 技能顺序门按 Change B 的当前步判定

#### Scenario: 会话恢复换了 id 尚未重新绑定

- **GIVEN** Change B 绑定在旧会话 id 上，当前会话是同一对话恢复后的新 id 且没有绑定
- **WHEN** 当前会话调用写类工具或加载技能
- **THEN** 不拦截、不代为确认、不记证据
- **AND** 入口技能以新 id 重新激活后恢复正常

#### Scenario: 宿主不提供会话标识

- **WHEN** hook 输入没有 `session_id`
- **THEN** 本会话任务回退为恢复候选，行为与修改前一致

### Requirement: 一个 Change SHALL 同时只绑定一个会话

`tenon session activate <change> --host-session <id>` 写入会话绑定时 SHALL 删除其他会话对同一 Change 的绑定，并 MUST 在 stderr 写明从哪个会话移交。一个会话 MUST 同时只绑定一个 Change。

#### Scenario: 恢复后的新会话接管任务

- **GIVEN** Change B 绑定在会话 X
- **WHEN** 会话 Y 执行 `tenon session activate B --host-session Y`
- **THEN** Change B 只绑定会话 Y，会话 X 的绑定被删除
- **AND** stderr 提示「已从会话 X 移交」

### Requirement: 交互待处理标记 SHALL 记录并只作用于归属方

交互待处理标记 SHALL 使用带协议名的 v2 格式，记录所属 Change、会话标识、技能显示名与请求时间。

- 宿主提供了合法会话标识时，标记 SHALL 写在该会话自己的文件 `.pipeline-pending-interaction.<会话标识>` 里，各会话的标记互不覆盖。
- 宿主没有提供会话标识时，仍写项目根的单个文件 `.pipeline-pending-interaction`。

门禁 MUST 只拦截标记的归属方：

- 会话自己的文件，归属方是该会话。
- 单个文件带 Change 时，归属方是本会话任务为该 Change 的会话；不带 Change 时，归属方是全部会话。

一个会话判拦截时 SHALL 同时看它自己的文件与单个文件。子代理豁免保持不变。AskUserQuestion 完成与对话放行 MUST 只解除归属于本会话的标记，交互确认记录只写入本会话任务。旧格式标记 SHALL 在被读到时删除且不拦截，过期规则对两种文件相同。工作区指纹、交付提交与 `advance` 的硬门 SHALL 把会话文件与单个文件同等对待：不算改动、不入库；任一新鲜标记都让 `advance` 停下。

#### Scenario: 一个会话加载交互技能不锁其他会话

- **WHEN** 会话 A 加载交互技能并留下交互标记
- **THEN** 会话 A 的写类工具被拦截
- **AND** 会话 B 的写类工具放行

#### Scenario: 其他会话的提问不解除本会话标记

- **GIVEN** 会话 A 有一条交互标记
- **WHEN** 会话 B 完成一次 AskUserQuestion
- **THEN** 会话 A 的交互标记保持不变

#### Scenario: 两个会话同时等待回答

- **WHEN** 会话 A 与会话 B 先后加载交互技能
- **THEN** 两个会话各有自己的标记文件，后写的不覆盖先写的
- **AND** 会话 A 的提问只解除 A 的标记，B 仍被拦截

#### Scenario: 旧格式标记退役

- **WHEN** 门禁读到首行不是协议名的交互标记
- **THEN** 删除该标记且本次调用不被拦截

### Requirement: 已批准未消费的评审回执 SHALL 可撤销回待确认

`tenon review revoke <change> --reason <原因>` SHALL 在 Change 锁内把当前步已批准、尚未被流转消费的评审回执撤回为同一 event 的待确认状态，沿用原请求时间与决策状态绑定，并重新发布评审待处理标记。撤销 MUST 写入包含操作者、原因、原回执标识与 event 的审计事件。缺少原因、回执已被消费、回执本就待确认或不存在时，命令 MUST 拒绝且不改任何状态。撤销后若决策状态已与绑定不符，对同一 phase / event 重新发起 `review request` MUST 能刷新待确认回执与绑定。

#### Scenario: 撤回误记的批准

- **GIVEN** Change A 规格步 `spec-complete` 的回执为已批准且未被消费
- **WHEN** 执行 `tenon review revoke A --reason 串会话误确认`
- **THEN** 回执回到待确认，评审标记重新出现
- **AND** 写入一条撤销审计事件

#### Scenario: 已被消费的回执不可撤销

- **WHEN** 回执已被 transition 消费
- **THEN** 撤销被拒绝，状态不变

#### Scenario: 缺少原因

- **WHEN** 执行撤销但未提供 `--reason`
- **THEN** 命令拒绝，状态不变

#### Scenario: 撤销后状态已变化

- **GIVEN** 回执已撤回为待确认，但决策状态在批准后发生过变化
- **WHEN** 用户确认时绑定校验失败
- **THEN** 对同一 phase / event 重新 `review request` 刷新待确认回执与绑定后可以正常确认

### Requirement: agent SHALL NOT 自己执行手动评审确认

手动评审确认（不带 `--delegated` 的 `tenon review acknowledge`）会批准评审请求里冻结的豁免与受保护配置改动，确认的人必须是用户。门禁 MUST 在任何时候拒绝 agent 的 shell 工具调用执行它，不论是否存在评审待处理标记；用包装器、解释器、`env`、`bash -c` 或命令串接执行同样拒绝。只是提到这几个词的读写（检索、提交说明）不算执行。

用户确认 SHALL 只经三条路：

- 用户回复放行语，由 hook 写入回执；
- 用户在 Dashboard 确认；
- 宿主没有写回执的 UserPromptSubmit hook 时，由用户本人在自己的终端运行 `tenon review acknowledge <change>`。

评审挂起时门禁仍 SHALL 放行 `tenon review request`、`tenon review acknowledge --delegated` 与 `tenon dashboard --open`。委托确认（`--delegated`）MUST NOT 批准任何豁免。注入给 agent 的工作流宪法与各宿主适配器说明 SHALL 写明这三条路，不再让 agent 执行手动确认。

#### Scenario: agent 自批被拒

- **WHEN** agent 在评审挂起期间执行 `tenon review acknowledge <change>`
- **THEN** 门禁拒绝并说明三条确认路径

#### Scenario: 标记过期后仍拒绝

- **GIVEN** 评审待处理标记已过期
- **WHEN** agent 执行 `bash -c "tenon review acknowledge <change>"`
- **THEN** 门禁仍拒绝

#### Scenario: 委托确认放行

- **WHEN** 持续授权下 agent 执行 `tenon review acknowledge <change> --delegated`
- **THEN** 门禁放行，且这次确认不批准任何待批准的豁免
