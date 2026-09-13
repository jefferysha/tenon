# B 设计工作包

## 目标与边界

本工作包冻结跨 kernel、server、CLI、hooks 的决策契约；它不实现 Dashboard、HTTP command adapter 或新的持久化队列。Dashboard 从来不调用大模型，也不创建 Skill 问题；它只读取 projection，并在已有 exact pending receipt 上调用 review application。

`review_gate_status` 继续只有 `pending | approved`。`superseded`、迟到回答和证据不完整都由追加事件及只读 projection 推导；`expired` 没有 canonical 依据，保持 deferred。

## 记录域与关联

| 决策 | canonical 记录 | 关联锚点 | 允许的来源维度 |
|---|---|---|---|
| review | `review_gate_*`、review interaction、`TransitionRecord` | change、phase、event、request id、state/revision binding | `review_acknowledged_via = terminal \| dashboard \| automation` |
| Skill question | question/decision interaction、invocation receipt | invocation id、question id、attempt/step visit | `decision.mode` 与 invocation adapter 分开记录 |
| recommended-default | invocation policy/decision interaction | frozen policy id/version/rule id、invocation id | `decision.mode=recommended-default` |
| AFK | invocation adapter、attempt/reservation、decision/effect events | decision → invocation id、attempt id、step visit | `adapter.kind=afk` 由 invocation join 得出 |

决策事件本身不得猜测 `adapter.kind`；AFK 视图必须通过 decision 的 invocation id 与 `invocation-started`（或等价 durable invocation record）join。内存中的 receipt consume 不构成审计证据。

回放必须区分 terminal、Dashboard、automation，因此 canonical review 记录必须新增 `review_acknowledged_via`。该字段必须同步 `FieldName`/codec、`.pipeline.yaml` 投影、golden fixtures、历史缺省值（旧记录统一映射为 `unknown`，不得猜测为 terminal）及 server/CLI writer；不能只加在 view model。

## PendingDecisionView 推导

Projection 只读 canonical state 和 append-only records。无法满足证据条件时返回 `unknown/incomplete`，不把未知当成 consumed、approved 或 expired。

| 决策类型 | pending | answered | consumed | superseded | expired |
|---|---|---|---|---|---|
| review | exact review request receipt 为 pending，且 request/event/revision anchor 有效 | 同一 receipt 被合法 acknowledge，binding 匹配 | 必须同时找到匹配的成功 `TransitionRecord`（event/from、run/step、revision/hash anchor）和对应 interaction success/effect 链；仅因 `clearReviewGatePatch` 清空字段不能判定 | 新 request、状态 revision 或 binding 使旧回答不再匹配；追加 stale/rejected/superseded acknowledgement event | deferred；当前 marker TTL 不是 canonical 过期依据 |
| Skill question | 有持久 question event，且没有同 question id 的合法 decision | question 有合法 decision event（含 mode、actor/source、attempt binding） | invocation reducer 接受 decision，并有 durable effect/resume/terminal 链；若 host 只在回答后写 question，则视图返回 absent/unknown，不伪造 pending | duplicate/stale decision 被拒绝并追加事件，或同一 invocation 产生显式 replacement | deferred；interaction TTL 不参与 canonical 推导 |
| recommended-default | routine + `shown=false` + frozen policy id/version/rule id 匹配，且无 decision | `decision.mode=recommended-default` 且 policy binding 匹配 | durable producer effect/terminal 链证明应用；内存 `consumeVerified...` 不足以构成审计证据 | policy、revision 或 invocation 不匹配时追加 rejected/stale event | deferred |
| AFK | AFK attempt/reservation 已 durable 建立，且 decision 尚未完成 | decision 通过 invocation join 产生，并在独立的 AFK source/strategy 字段中记录来源；不得伪造现有 `decision.mode` 枚举 | durable AFK effect/terminal 链证明消费，并能回到 attempt/reservation；adapter.kind 只能由 invocation join 得出 | attempt、revision 或 invocation 不匹配时追加 rejected/superseded event | 由 AFK reservation/attempt 生命周期另行定义，本任务不实现 |

review 的 consumed 推导至少需要 `TransitionRecord` 的 event/from、run/step anchor、sequence/previous record chain、state/revision/hash evidence，以及 request/ack/effect interaction 的成功链；时间戳单独不足以证明消费。没有完整链条时返回 `unknown/incomplete`。

## 共享 review acknowledge application

当前完整编排位于 CLI；B 必须先定义抽取边界，C 才能实现。共享 application 是一个不依赖 CLI、server、HTTP 或文本输出的 application package，输入/依赖至少包含：

- `changeDir`、change name、expected revision、phase/event、request id、channel；
- 在 Change lock 内读取 state 与 exact pending receipt；
- Kernel `readReviewGateBinding`/`reviewGateBindingMatches` verifier；
- receipt read/write、state patch、interaction recorder、history writer、marker cleanup、clock/id generator；
- rejected acknowledgement recorder，且参数不再绑定 `CliDeps`；
- delegated authority/session scope verifier（若当前 CLI 语义要求）。

输出为结构化结果（approved/idempotent/rejected/conflict/marker-warning 等）以及 before/after revision；它不得格式化文本或决定 HTTP status。CLI 只负责命令行参数、输出和退出码；server 在进程内调用同一个 application，传 `channel=dashboard`，不得导入 `@tenon/cli` 或复制这段编排。没有 exact pending receipt 时，Dashboard 得到稳定 conflict，不能主动创建 approval。迟到、binding 不匹配和 revision 冲突都经共享 rejected recorder 留痕；任何失败不能产生部分 canonical commit。

抽取顺序：先把 CLI 的 characterization tests 固定下来 → 把 `recordRejectedAcknowledgement` 和 acknowledge orchestration 移入共享 application → CLI 改为薄适配并保持现有语义 → server adapter 接入同一 application → 再添加 dashboard projection。C 的验收必须包含 CLI/server 结果一致性和无 server→cli 依赖。

## 并发、错误和同步

所有写命令带 `expected_revision` 与 idempotency key。相同 key、相同 binding 的重复 acknowledge 返回同一成功结果且不重复追加副作用；不同 revision 返回 `revision-conflict`。receipt 缺失、迟到或 binding 不匹配统一为 `review-approval-required`：CLI 保持现有非零退出语义，server 返回 HTTP 409、稳定 `code` 和结构化 phase/event 字段；拒绝不得改变 canonical state、TransitionRecord 或成功 history，但允许且必须追加一次 rejected-acknowledgement audit event，供 projection 显示拒绝/迟到证据；该审计事件不能被当作 approved 或 consumed。

提交成功后，Dashboard 通过 SSE/read refresh 获得新 projection。宿主唤醒分档为 capability：已有宿主支持唤醒时发送 resume signal；不支持时只记录 pending/approved，不能声称终端阻塞问答已经被回答。终端仍是唯一的大模型交互面。

## 用户模式与切换

用户模式只有两种：

| 用户模式 | 内部策略 | 适用范围 |
|---|---|---|
| HITL | `interactive` | 每个需人工回答的问题在终端等待；review 可由 terminal 或 Dashboard 决策台放行，但都走共享 application |
| HITL | `recommended-defaults` | 只对 frozen policy 明确标记的 routine、`shown=false` 问题采用默认值；不等于 AFK |
| AFK | `afk` | 自动回答/自动放行必须追加独立 AFK decision/source 记录，并通过 invocation join 归因 |

`mode-switched` 是追加事件，不是回答事件。它包含 from/to、actor/channel、effective-at、policy revision 和 pending request ids。切换只影响后续请求；已有 pending 请求按原策略完成、显式 supersede，或产生带 replacement 链的可审计新请求，不能静默套用新策略。内部 `decision.mode`、invocation `adapter.kind`、review `channel` 是三个正交维度。

本轮 C 实现使用 `.pipeline-decision-audit.jsonl` 作为只追加的审计事件投影，不把它当作 canonical 状态，也不伪造 `InteractionEventV1`。`decision-mode-switched` 必须校验当前模式（无历史事件时为 HITL），并以 expected revision 与幂等参数绑定；`pending-decision-self-approval-suspected` 必须绑定当前 PendingDecisionView 的 `pending_decision_id/ref`。该文件只由 Change lock 下的 server adapter 或 hook 的脱敏检测写入，GET 端点只读返回；hook 只能使用可解析的 change 级 pending 线索并始终写 `tokenDigest:null`。

## 自审批威胁模型和告警责任

本地 bearer token 证明的是进程能力，不是人类身份。agent 与 server 同一系统用户时，agent 可能读取 token、申请 approval 或直接调用 localhost API；一次性凭证只能防重放和旧 revision，不能防自审批。门禁 pending 期间，hook 对 token 文件读取、localhost 控制 API 请求、审批前后的 actor/channel/revision 异常发出脱敏 `review-self-approval-signal` 事件，至少包含 change、phase、event、request id、channel、process/host hash、observed-at、signal kind；不得记录 token 内容或声称识别了操作者。

C 负责消费既有 signal、在待决 projection 中展示告警并保留事件链；hook 侧检测和事件写入若无法与 C 同步交付，则登记独立 P1 安全子任务。该信号是检测与取证，不是强制身份认证；真正的 Dashboard 人工语义仍由 channel attribution、binding、审计记录共同保证。

## 后续任务

`humanGateSatisfied: true` 的硬编码约束单列为 automation-constraint 任务；本 B/C 不恢复它，也不以告警契约替代修复。
