# Interaction and Skill Provenance Specification

## Purpose

Define contextual user-intent handling, action-effect gates, continuous
authority boundaries, and trustworthy Skill-read provenance.
## Requirements
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

### Requirement: Skill evidence SHALL bind to the selected plugin identity

Codex Skill-read evidence SHALL be accepted only when the completed read
targets the exact packaged `skills/<safe-id>/SKILL.md` beneath a
process-provided selected host root, the active immutable managed release, or
the physically executing verified direct-development hook root.

The hook SHALL NOT enumerate historical host-cache versions. Project-global,
user-global, symlinked, mismatched, malformed, or unselected cache paths SHALL
not produce Skill evidence.

The transcript session MAY have started in another worktree of the same
repository only when the completed tool call explicitly declares the governed
worktree as its working directory and both worktrees resolve to the same Git
common directory. A missing explicit working directory, another repository, a
project-global duplicate projection, a user-global path, a malformed path, or
an unselected historical cache SHALL NOT produce evidence.

#### Scenario: Current selected cache proves a Skill read

- **GIVEN** the stable bootstrap supplies the exact selected Codex plugin root
- **WHEN** the host transcript proves a completed bounded read of its packaged
  Skill file
- **THEN** the current Change may record `CodexSkillRead` evidence for that
  Skill and current step visit.

#### Scenario: Historical cache contains the same Skill

- **WHEN** Codex reads a Skill from an older unselected cache directory
- **THEN** no evidence is appended
- **AND** a required producer or step DAG remains blocked.

#### Scenario: Skill path escapes through a symlink

- **WHEN** the lexical Skill path is under a trusted root but its real path
  escapes or differs from the expected packaged file
- **THEN** the read is rejected as evidence.

#### Scenario: Explicit sibling worktree command proves the selected Skill read

- **GIVEN** the host transcript session began in worktree A
- **AND** a completed bounded read explicitly used worktree B as its working
  directory
- **AND** A and B share the same Git common directory
- **AND** the target is beneath the process-provided Selected Skill Root
- **THEN** the current Change in worktree B may record that Skill evidence.

#### Scenario: Implicit sibling worktree read remains rejected

- **GIVEN** the transcript session began in worktree A
- **WHEN** a tool reads a Skill while omitting an explicit working directory for
  governed worktree B
- **THEN** no evidence is appended even if A and B share a repository.

#### Scenario: Another repository cannot borrow evidence

- **WHEN** the declared tool working directory and governed project do not share
  one Git common directory
- **THEN** the read is rejected as evidence.

### Requirement: Pending-interaction enforcement SHALL classify action effects

The interaction gate SHALL classify a requested tool action as `read-only`,
`human-question`, `reversible-local-write`, `canonical-state-transition`,
`external-side-effect`, `destructive-or-costly`, or `unknown`.

Known read-only inspection and human-question actions SHALL remain available
while a pending interaction or review exists. State transitions, external
effects, destructive or costly actions SHALL retain their exact authorization
requirements. Unknown actions SHALL fail closed. A shell command SHALL be
read-only only when every parsed command is in a strict read-only allowlist and
contains no redirection, substitution, backgrounding, or unclassified segment.

#### Scenario: Repository inspection continues while a decision is pending

- **GIVEN** a fresh pending interaction marker
- **WHEN** the agent runs `rg`, `git diff`, `tenon status`, or another
  declared read-only inspection
- **THEN** the gate allows the inspection without clearing the marker.

#### Scenario: A write disguised in a shell chain is blocked

- **GIVEN** a fresh pending interaction marker
- **WHEN** a shell action combines a read command with redirection, command
  substitution, or an unclassified command
- **THEN** the whole action is classified non-read-only and remains blocked.

#### Scenario: Canonical transition still requires its receipt

- **GIVEN** a pending review for one exact event
- **WHEN** a caller attempts a canonical state transition
- **THEN** the action remains blocked until the matching approval receipt exists
- **AND** read-only inspection remains available.

### Requirement: Every Workflow SHALL enforce current-visit Skill policy

The effective plan SHALL apply the same current-step-visit Skill DAG algorithm
to default and custom Workflows. Only the exact orchestration entry Skill
`pipeline` MAY be exempt because it selects or recovers the Change before
step execution. Previous visits, other steps, other Changes, or mere Skill
installation SHALL not satisfy an exit.

#### Scenario: Default step omits a mandatory Skill

- **WHEN** a default phase attempts to exit without current-visit evidence for
  a plan-declared mandatory Skill
- **THEN** CLI and HTTP transitions fail with the same incomplete-Skill reason.

#### Scenario: Verify loops back to Build

- **WHEN** a Change re-enters Build after Verify failure
- **THEN** the previous Build visit's Skill receipts do not satisfy the new
  visit
- **AND** declared Build Skills must complete again.

### Requirement: Continuous authority SHALL remain Change-bound and non-expansive

Continuous authority SHALL permit delegated review acknowledgement only after
real Skill, document, read, guard, and review-request evidence exists for the
exact live Change. It SHALL not cross Changes, grant external publication
authority, bypass security/scope decisions, or survive explicit revocation.

#### Scenario: Delegated review lacks evidence

- **WHEN** a continuously authorized Change requests delegated acknowledgement
  before its phase evidence or guard passes
- **THEN** acknowledgement fails and no transition receipt is created.

### Requirement: Canonical review authorization SHALL require a bounded physical decision-state binding

Canonical review request MUST 在 Change lock 下生成 `.pipeline-review-gate-binding.json`，并把 exact phase、event、`review_requested_at`、canonical decision-state digest 与可选 run id 绑定为 version 1 sidecar。Writer MUST 只产生字段闭合、单行 `JSON.stringify(binding) + "\n"` 的 canonical bytes，并通过既有 atomic replace 发布。

Authorization reader MUST 在物化内容前执行 16 KiB byte ceiling，并通过 `O_NOFOLLOW | O_NONBLOCK` 打开同一 target。Reader MUST 证明 parent directory realpath/identity 与 target/fd 的 `dev`、`ino`、`size`、`mtimeNs`、`ctimeNs` 在 proof/read 前后稳定，MUST 只接受严格 UTF-8 的普通文件，并 MUST 以 bounded `max + 1` fd read 检测增长。解析后的闭合 binding 重新编码后 MUST 与原始 bytes 完全一致；duplicate keys、字段重排、额外空白/trailing bytes 或其他多义编码 MUST fail closed。

`review acknowledge` 与 canonical transition MUST 只有在 sidecar 同时匹配当前 phase、event、requestedAt、decision-state digest 与 run id 时授权。Missing、non-regular、symlink、oversize、malformed、ambiguous、replaced、changed-during-read 或不匹配的 sidecar MUST NOT 授权，且错误不得回显 sidecar 内容。

Sidecar-less legacy pending/approved receipt MUST NOT 被当前 state 自动 backfill 或解释为已绑定 approval，因为 runtime 无法证明旧 request 时刻的 decision-state digest。恢复 MUST 通过相同 exact phase/event 的 fresh `review request` 写入新的有序 requestedAt、pending receipt 与 canonical sidecar，再重新 acknowledge；不得提供 compatibility bypass、启动时静默迁移或 interaction-projection fallback。

#### Scenario: canonical request/acknowledge/transition 正常闭环

- **WHEN** exact review request 在 Change lock 下写入 pending receipt 和 canonical sidecar
- **THEN** bounded reader 返回同一 version 1 binding
- **AND** acknowledgement 与 transition 只有在 phase/event/requestedAt/digest/run id 全部匹配时成功

#### Scenario: sidecar 不是稳定普通文件

- **WHEN** sidecar 是 symlink、目录或其他非普通文件，或 path/fd/parent 在读取期间被替换、消失或改为 symlink
- **THEN** reader fail closed
- **AND** acknowledgement 与 transition 都不得消费 receipt

#### Scenario: sidecar 超限或在读取期间增长

- **WHEN** sidecar 打开时超过 16 KiB，或在 fstat 后增长并使 bounded reader 读到第 16 KiB + 1 byte
- **THEN** reader 在解析前拒绝
- **AND** 不得物化攻击者控制的无界 tail

#### Scenario: sidecar 内容在 proof/read 窗口变化

- **WHEN** 同一 inode 被同尺寸改写，或 target 被新 inode 替换
- **THEN** size/mtime/ctime 或 dev/ino fence 检测变化并拒绝
- **AND** 不能使用 proof 来自旧文件、内容来自新文件的混合证据

#### Scenario: sidecar JSON malformed 或 ambiguous

- **WHEN** sidecar 不是严格 UTF-8/合法闭合 JSON，包含未知字段、duplicate keys、字段重排、额外空白或 trailing bytes
- **THEN** reader 产生稳定的 invalid/unreadable 结果且不泄露内容
- **AND** acknowledgement 与 transition fail closed

#### Scenario: legacy approved receipt 缺少 binding

- **WHEN** legacy pending/approved receipt 没有 `.pipeline-review-gate-binding.json`
- **THEN** acknowledgement 与 transition 都不得授权
- **AND** runtime 不得从当前 state 自动生成可消费的 approval binding

#### Scenario: fresh request 恢复 legacy receipt

- **GIVEN** legacy receipt 缺少、损坏或不匹配的 sidecar
- **WHEN** caller 对相同 exact phase/event 重新执行 `review request`
- **THEN** request 在 Change lock 下产生新的有序 requestedAt、pending receipt 与 canonical sidecar
- **AND** 后续新的 acknowledgement 与 exact transition 可以正常完成

#### Scenario: interaction projection 不参与授权

- **WHEN** `.pipeline-interactions.jsonl` 缺失或损坏，但 canonical receipt 与 sidecar 有效
- **THEN** canonical acknowledgement/transition 仍按 sidecar contract 决定
- **AND** projection 仅报告自身 warning/diagnostic，不得成为授权真相或 fallback

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

