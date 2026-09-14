# Human Gate 约束审计

审计范围：`packages/kernel/src/loops/automation-policy.ts`、Kernel transition application、CLI/server transition adapter、review receipt/binding 及现有测试。结论仅基于当前审计 worktree 的源码；该 worktree 的 server adapter 仍保留旧硬编码，集成分支上的修复需要单独复核。

## 结论

1. `humanGateApplies` 的判断位置和目标范围是明确的：
   - `transitionTarget` 有值时，仅当 `policy.transition.human_gates` 包含目标 step 才适用；
   - `transitionTarget` 未定义时，只要 policy 配置了任意 human gate，就按适用处理；
   - 只有 `humanGateSatisfied === true` 才通过，`false`、缺失或无法构造上下文都应 fail closed。
   因此 gate 是“离开命中 review/automation step 时检查”，不是进入 phase 时全局锁死。`evaluateConstraintPolicy` 的现有测试覆盖 inactive loop、命中 gate 的拒绝和满足后的通过，但建议补一个未命中目标 step 的正例，以及缺失 `humanGateSatisfied` 的拒绝例，防止 adapter 默认值回归。

2. review receipt 与 human gate 是两道不同的约束，不能互相替代：
   - receipt 负责 review phase + exact event 的人工决策状态；
   - binding 负责把 receipt 绑定到请求时间、当前 canonical decision state digest 和 run id；
   - human gate policy 负责自动化 loop 是否允许该 transition。
   Kernel transition application 先验证 receipt/binding，再消费 receipt；生产 CLI/server 都应注入同一个 binding verifier。approved receipt 没有 binding、binding 解析失败或 digest 不匹配，都必须返回 `review-approval-required`，且不写 state、history 或 interaction projection。

3. 当前审计 worktree 的 server transition 存在可构造放行路径：`packages/server/src/transition.ts:320` 返回 `humanGateSatisfied: true`，所以 active loop 的目标若命中 human gate，server 请求可以绕过 AFK/人工 gate 语义直接进入后续流程。该值不是人类证据，也不能由 bearer token、localhost 来源或 Dashboard 点击推导。CLI 已使用 `TENON_AFK !== '1'` 作为 adapter 侧 gate 判定，但这只是运行模式开关，不能当作“人已批准”的 canonical 证据。

4. 任何基于当前本地文件的“人类批准”都只能证明一个同一 OS 用户可写入的能力，不提供操作者身份：
   - canonical receipt 字段：`review_gate_phase/status/event`、`review_requested_at`、`review_acknowledged_at`、`review_acknowledged_via`；
   - sidecar binding：`.pipeline-review-gate-binding.json`，校验 exact phase/event、requestedAt、decision state digest、可选 runId；
   - transition record/history 与 interaction projection：可用于回放和渠道归因，但不能替代 canonical authorization。
   receipt、sidecar、token 都可被同一用户的 agent/process 读取或写入，因此它们可能被同用户脚本伪造。`review_acknowledged_via` 只能表示入口渠道（terminal/dashboard/automation/delegated），不能声称是真人身份。若要识别自审批，需另建 append-only observation/alert 事件，至少记录 pending decision ref、操作类型、时间、脱敏的 token/process/host hash；绝不能保存 token 原文，也不能将告警本身变成放行条件。

## fail-closed 修复方案

### Server adapter

- 删除 `humanGateSatisfied: true` 及相关“Dashboard 点击等同宿主确认”的注释。
- `resolveConstraintContext` 只能从显式的环境读取边界获得 AFK 模式，且与 CLI 保持同义；若 loop registry 读取/校验失败，抛出基础设施错误，不构造成功上下文。
- `reviewGateBinding` 必须通过 Kernel 导出的 `readReviewGateBinding` + `reviewGateBindingMatches` 实现；读取、解析或 digest 校验失败统一为 `false`。
- 不传任何 caller-controlled approval boolean。Kernel application 的 `reviewGateBinding` 应为必需依赖；测试 fixture 可以注入确定性 verifier，但生产构造不得缺失。
- `review-approval-required` 映射为 HTTP 409，body 使用稳定 `code`，拒绝时零 canonical/state/history/projection 写入。

### CLI adapter

- 保持 `reviewGateBinding` 与 server 相同的 Kernel matcher；CLI 的 `review request`/`acknowledge` 负责建立和消费 receipt，transition 只消费已绑定 receipt。
- `TENON_AFK=1` 只能表示显式 AFK 自动化模式下的 gate 策略结果。它不产生 `review_acknowledged_via=terminal/dashboard`，不写人工批准 receipt，也不应被记录为 human evidence。
- transition 处不得把环境变量、token 存在、localhost、hook marker 或交互 projection 当作人类批准。

## 迁移与测试清单

### 迁移

1. 先关闭 server 硬编码旁路，再发布；不得用“恢复旧 adapter 参数”作为回滚方案，回滚只能回滚整个修复提交并禁止发布。
2. 保留现有 receipt/binding schema；新增或调整 canonical 渠道字段时同步 `FieldName`、state init、pipeline projection、golden fixtures 和文档。
3. 历史 spec 可保留，但应加 deprecated 注记；源码与 dist 应对旧 `humanReviewApproved`/硬编码命中做零命中检查。
4. 不迁移既有 pending receipt 为 approved，也不把旧 token/marker 转换为人类证据。旧 binding 不可验证时重新 `review request`，由正常 acknowledge 建立新 binding。

### 必测场景

- Kernel：命中目标 gate 且 human context 为 false/缺失时拒绝；未命中目标 gate 时不误拦截；满足 context 时仅在 exact approved receipt + matching binding 下通过。
- CLI：无 receipt、wrong event、missing/malformed/mismatched binding 均拒绝且无副作用；matching receipt 通过并消费 receipt；`TENON_AFK=1` 只影响自动化策略，不写 human receipt。
- Server：与 CLI 同样的拒绝/通过矩阵；HTTP review failure 为 409 + `review-approval-required`；拒绝不改变 state/history/interaction；非 review transition 不读取 binding。
- 回归：server 路由带预置 approved receipt + matching binding 返回 200；旧的 unrelated 401/409 断言保持不变；并重建并检查 `packages/cli/dist/tenon.mjs` 与 `packages/server/dist/dashboard.mjs` 新鲜度。
- 安全观测：pending gate 期间读取 token、调用本地 API 的 hook 行为只追加 redacted self-approval observation/alert，不能改变 approval 状态；测试确认 token 原文不进入任何 ledger、history 或 projection。

## 需要拆出的后续任务

- **H1：server human gate parity**：删除硬编码，补 CLI/server AFK 与 gate 适用范围回归。
- **H2：shared review acknowledgement application**：把 CLI acknowledge 的 receipt、binding、marker、interaction 编排抽到 kernel/shared application，server 只调用共享层并传 `channel=dashboard`，避免复制两套逻辑。
- **H3：self-approval observation**：定义 pending decision 关联、进程/host 脱敏 hash、append-only 事件和 hook 精确匹配；明确告警不具备放行权限。
- **H4：human evidence threat model**：补文档和审计视图，明确 bearer token、localhost、环境变量、marker、channel attribution 都不是人类身份证明。

