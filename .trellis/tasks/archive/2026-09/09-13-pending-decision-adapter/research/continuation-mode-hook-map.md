# Research: continuation mode and hook map

- Query: HITL/AFK/常规默认值策略的决定、冻结、读取位置；模式切换事件的最窄接缝；pending review 期间 token/local API 检测告警的 PreToolUse 接入口、可复用 writer、安装模板和测试。
- Scope: internal
- Date: 2026-09-13

## Findings

### 1. 用户模式、内部策略与冻结读取链

当前代码有两层模式概念，不能再新增第三份 policy state：

- Workflow 配置层的 `interaction.mode` 是 `interactive | recommended-defaults | afk`。闭集和值校验在 `packages/kernel/src/workflow/policy.ts:42-44,125-135`，未声明时默认 `interactive`。YAML/结构化 workflow 由 `compileWorkflow` 在 `packages/kernel/src/workflow/compile.ts:301-307` 编译，编译产物进入 effective plan。
- 权限层只根据 frozen plan 发放动作：`workflowPolicyPermissionLayer` 在 `packages/kernel/src/workflow/policy.ts:387-395` 为 `recommended-defaults` 发放 `apply-recommended-default`、为 `afk` 发放 `enter-afk`；`evaluateWorkflowAction` 在 `:330-349` 拒绝不匹配 interaction mode 的动作。
- 常规默认值不是任意 AFK：`canUseWorkflowRecommendedDefault` 在 `packages/kernel/src/workflow/policy.ts:418-445` 要求 mode 是 `recommended-defaults`、问题 `requiredness=routine` 且 `shown=false`、decision mode 是 `recommended-default`，并且 decision 的 policy id/version/rule_id 与冻结的 `frozenRecommendedDefaultPolicy` 完全匹配。
- Workflow plan 在 run 创建时被快照冻结。`packages/kernel/src/state/workflow-plan-snapshot.ts:99-110` 把 `decomposition`、`interaction` 和 fingerprint 写入 v3 snapshot；`packages/kernel/src/state/state-init.ts:67-80` 把 snapshot 放进 `RunMetadata`。因此后续问题应读取 `state.runMetadata.workflowPlanSnapshot.plan.interaction`（或等价 effective plan snapshot），不能重新加载可变 YAML 推翻已冻结 run。
- `review_acknowledged_via` 是 review receipt 的渠道归因字段，初始化为 `unknown`，见 `packages/kernel/src/state/state-init.ts:129-138`；pending projection 读取它来推导 `source/channel`，见 `packages/kernel/src/decision/projection.ts:70-77`。
- AFK 来源必须从 invocation join 得出：`packages/kernel/src/decision/projection.ts:81-102` 先按 `invocation_id` 分组，读取 `invocation-started.payload.adapter.kind === 'afk'`，再把关联 question/decision 投影为 `type=afk`、`source=afk`、`channel=automation`。`decision.mode` 只用于把普通 skill decision 标成 `recommended-default`，不能用来推断 AFK。

结论：当前仓库没有“切换 HITL/AFK”的既有 CLI/API。`packages/kernel/src/decision/mode.ts:1-25` 只有纯函数和无持久化的 `modeSwitchEvent` 构造器；它不写 state、interaction projection 或 history。可见的 mode 输入来自 workflow YAML 的 `interaction` 或创建请求的 `interaction_policy`，但它们在 run 建立时被编译/快照，不能直接当成运行期切换接口。

最窄的未来接缝应是一个已有 run 的 application/adapter 在持有 canonical lock 时：

1. 读取 `RunMetadata.workflowPlanSnapshot` 的当前冻结策略与当前 effective revision；
2. 接受显式 `from/to` 和 `effectiveAt`，调用 `modeSwitchEvent` 生成结构化事件；
3. 将事件写入已有 append-only interaction/audit writer；
4. 只影响切换之后新建的 interaction/invocation，现有 pending receipt 保持原策略和原 binding，直到 answered/superseded/consumed；
5. 后续问题仍由 frozen plan + invocation adapter 决定，不另存一个“当前模式”字段。若确实要允许未来问题换策略，应产生新的 workflow-plan/policy revision 并让后续 invocation 绑定该 revision；不能原地改旧 snapshot。

当前 C 的 `modeSwitchEvent` 输入只有 `from/to/recommendedDefaults/occurredAt/actor`，没有 policy revision、pending request ids、channel 或 effective time 字段，因此它目前只能作为检测/构造信号，不能满足 cross-layer 事件持久化契约（`.trellis/spec/guides/cross-layer-thinking-guide.md:340-347`）。这也是 B spec 标出的 deferred security persistence，不应假装已实现。

### 2. Pending review 期间的 hook 检测最窄入口

推荐复用单一 `hooks/gate.sh` 的 PreToolUse 热路径，而不是添加 Dashboard 或第二个认证面：

- `hooks/gate.sh:47-61` 已统一解析 host payload 的 cwd 并定位可信项目根；`hooks/gate.sh:101-125` 已加载 review marker helper 并判断 v2 marker 是否属于当前 active Change；`hooks/gate.sh:246-274` 是 fresh pending marker 的唯一拦截循环。
- 在 `review_marker_relevant_to_active_change "$m"` 成功之后、`is_review_control_command`/只读判断之前，可对 `json_command` 做只读字符串分类：
  - 出现 `dashboard-token.json` 或明确的 token-handshake 路径读取形状时发 `operation=read-token`；
  - 出现 loopback URL/host（`127.0.0.1`、`localhost`、`::1`）以及 HTTP 客户端/请求命令时发 `operation=local-api-call`。
  - 只检测命令文本和路径名，不 `cat`、不 `source`、不打开 token 文件，不比较 bearer 值，也不执行请求。token 真实路径由 kernel `resolveProductPaths` 的 `dashboardTokenPath` 给出，默认文件名是 `dashboard-token.json`（`packages/kernel/src/product-paths.ts:140-155`）；server 在 `packages/server/src/main.ts:142-145` 写 0600 `{token,...meta}`，写入格式在 `packages/server/src/token.ts:14-22`。该信息足以做“疑似读取”检测，无需读取秘密。
  - 检测到后只产生脱敏信号：调用 `pendingAccessAlert`（`packages/kernel/src/decision/mode.ts:28-53`）时 `tokenDigest` 保持 `null`；`pendingDecisionId` 应来自当前 projection 的 stable decision ref/marker 绑定，而不能从命令或 token 推导。检测必须不改变 gate 的放行/阻断语义：命令仍按原有 review gate 规则处理，告警是旁观事件。
- 如果只想对所有 PreToolUse 载荷统一检测，`hooks/hooks.json:15-25` 的 `PreToolUse` `matcher=*` 已同时注册 `gate`、`codex-skill-receipt`、`terminal-activity`；无需为每个平台额外加一个不同 matcher。所有 native adapters 也透传 baseline `hooks/gate.sh`：例如 `adapters/codex/hooks/veto.sh`、`adapters/cursor/hooks/veto.sh`、`adapters/cline/hooks/PreToolUse`，安装/发布仍由 `hooks/hooks.json` 与稳定 `tenon-hook` launcher 管理。

### 3. 可复用的应用与 writer

可复用能力按“检测”和“持久化”分开：

- CLI 的 `packages/cli/src/commands/hostInteraction.ts:127-159` (`cmdInternalHostInteraction`) 是现有 hook application：它安全读取 bounded regular payload，调用 kernel `recordHostSkillInvocationInteraction`；它只处理 AskUserQuestion/PostToolUse，不适合直接写 token 告警。
- `packages/cli/src/nativeSkillReceipt.ts` 与 `hooks/skill-tracker.sh` 的 `internal-native-skill-receipt` 是另一个稳定 hook→CLI bridge；它绑定 host session/tool id 后调用 kernel producer，仍不适合伪装告警。
- 现有 interaction writer 是 `packages/kernel/src/state/interaction-event-store.ts:190-220` 的 `createInteractionEventRecorder`/`appendInteractionEventUnderLock`，要求先有完整的 `InteractionEventV1`，并维护 sequence/hash chain。现有 `packages/kernel/src/interaction/contract.ts:47-78,99-180` 的闭集 event/result/outcome 没有 `review-self-approval-signal` 或 `decision-mode-switched` 事件名。直接让 gate.sh 写 `.pipeline-interactions.jsonl` 会绕过 lock/sequence/hash，是错误接法。
- 兼容历史 sidecar writer 是 CLI `HistoryWriter` 对 `.pipeline-history.jsonl`（类型定义 `packages/kernel/src/types.ts:411-437`）；`hooks/decision-recorder.sh` 和 `hooks/skill-tracker.sh` 当前会 append 脱敏/类别化 history 行。它可作为临时观察日志，但不能代替新的 canonical security event；B spec 已将 mode-switch/self-approval 持久化列为 deferred follow-up。
- 若要跨进程持久化告警，最窄正确方案是新增一个 CLI internal command/application（由 stable `tenon-hook` 调用），在 CLI/kernel 内先定位当前 active Change、pending decision ref 和 canonical lock，再用 interaction/audit writer 追加**不含 token 的**告警事件。hook 本身只做模式识别和临时 payload 传递，不能自己认证或直接修改 canonical receipt。该 internal command 应明确 `detection-only`，不会授权、批准或清理 marker。

### 4. 测试接缝

现有可直接扩展的测试接口：

- `tools/test-hooks.sh:137-274` 已覆盖 `gate.sh` 三类 marker、review marker、只读/写阻断、命令解封口；可添加 token-file basename 与 localhost command 的 `stderr`/history redaction 断言，并断言 gate exit code 仍按原规则。
- `packages/cli/src/internal-skill-gate-hook.integration.test.ts:133+` 以真实 bash + dist bundle 覆盖 gate 的 PreToolUse 委托与退出码；适合验证“pending review 下检测分支触发且不放行额外写入”。
- `packages/cli/src/workflow-skill-orchestration.integration.test.ts:159-214` 覆盖真实 PreToolUse→PostToolUse 顺序、gate marker 与 decision-recorder/skill-tracker；可验证告警不会清 marker/改变问答链。
- `packages/cli/src/host-interaction-hook.integration.test.ts:10-100` 与 `packages/cli/src/commands/hostInteraction.test.ts:1-65` 覆盖 hook payload 的 bounded/symlink 安全、脱敏问题答案和现有 CLI application；可作为 internal alert command 的 payload/secret non-leak characterization 基础。
- `packages/cli/src/terminal-activity-hook.integration.test.ts:25-70` 覆盖 Pre/Post hook sidecar 的 regular-file、session/change binding 和写入边界；可复用其测试 harness，但该 sidecar 本身不是 canonical interaction writer。
- `packages/cli/src/commands/review.integration.test.ts:1+` 覆盖 review request/acknowledge、渠道和历史投影；应补“pending review + suspicious hook observation 不会批准/改变 receipt”的回归。
- `packages/kernel/src/decision/mode.test.ts:1-17` 目前只验证三种策略映射和 `tokenDigest=null` 的纯检测信号；它不验证 writer、lock、pending ref 绑定或事件回放。
- `packages/kernel/src/decision/projection.test.ts` 与 `packages/server/src/serverGetDecisionRoutes.ts` 是 pending decision projection/read-only API 的现有接缝；Dashboard 继续只读，不应把告警检测放进模型交互或 Skill 启动路径。

## Files found

- `packages/kernel/src/workflow/policy.ts` — interaction mode closed set, permission grants, recommended-default evidence.
- `packages/kernel/src/workflow/compile.ts` — workflow policy compilation.
- `packages/kernel/src/state/state-init.ts` — initial run metadata and canonical receipt fields.
- `packages/kernel/src/state/workflow-plan-snapshot.ts` — immutable workflow plan snapshot serialization.
- `packages/kernel/src/decision/mode.ts` — mode mapping and redacted detection signal constructors only.
- `packages/kernel/src/decision/projection.ts` — decision projection, review evidence and AFK invocation join.
- `packages/kernel/src/decision/commands.ts` — common revision/idempotency adapter, no mode switch persistence.
- `packages/kernel/src/interaction/contract.ts` — current closed interaction event taxonomy.
- `packages/kernel/src/state/interaction-event-store.ts` — locked append/hash-chain interaction writer.
- `packages/kernel/src/product-paths.ts` — canonical dashboard token path.
- `packages/server/src/token.ts` — token handshake write and header comparison.
- `packages/server/src/main.ts` — server token handshake publication.
- `hooks/gate.sh` — baseline PreToolUse gate and command parser.
- `hooks/hooks.json` — native PreToolUse/PostToolUse registration and stable launcher ABI.
- `hooks/decision-recorder.sh` — privacy-minimized host interaction/history bridge.
- `hooks/skill-tracker.sh` — Skill history and native receipt bridge.
- `packages/cli/src/commands/hostInteraction.ts` — internal hook application for host question receipts.
- `packages/cli/src/nativeSkillReceipt.ts` — internal hook application for native Skill receipts.
- `tools/test-hooks.sh` — shell-level gate and hook tests.
- `packages/cli/src/internal-skill-gate-hook.integration.test.ts` — real gate integration tests.
- `packages/cli/src/workflow-skill-orchestration.integration.test.ts` — gate + interaction lifecycle tests.
- `packages/cli/src/host-interaction-hook.integration.test.ts` — real question hook lifecycle tests.
- `packages/cli/src/commands/hostInteraction.test.ts` — decoder/application security tests.
- `packages/cli/src/terminal-activity-hook.integration.test.ts` — sidecar hook binding tests.
- `packages/cli/src/commands/review.integration.test.ts` — review receipt/channel/history tests.
- `packages/kernel/src/decision/mode.test.ts` — pure mode/alert constructor tests.
- `adapters/{codex,cursor,cline,continue,gemini,copilot}/hooks/*` — thin veto wrappers forwarding to baseline gate.

## Related specs

- `.trellis/spec/guides/cross-layer-thinking-guide.md:340-347` — decision synchronization boundary and mode-switch semantics.
- `.trellis/spec/cli/frontend/hook-guidelines.md:60-67` — HITL/recommended-defaults/AFK mapping and review-self-approval signal naming.
- `.trellis/spec/server/backend/decision-sync.md:1-86` — projection/adapter contract and deferred security event persistence.
- `.trellis/spec/cli/frontend/hook-guidelines.md` — hot-path/fail-open and hook registration constraints.
- `adapters/contract.md:21-65` — baseline gate/veto contract and no manual marker deletion.

## Caveats / Not Found

- `context.jsonl` is absent in the task directory; only `implement.jsonl` and `check.jsonl` exist. Research used the supplied task artifacts and repository specs directly.
- No existing CLI/API command was found that changes a running workflow from HITL to AFK or persists `decision-mode-switched`; `modeSwitchEvent` is currently a pure constructor.
- No existing event writer accepts the new mode/self-approval event shapes. `InteractionEventV1` has a closed event taxonomy and current writer requires canonical sequence/hash-chain fields.
- `dashboard-token.json` is the canonical handshake path, but the exact absolute path is platform/runtime dependent. Hook detection should match the stable basename/known path shape or receive a non-secret path hint; it must never open/read the file.
- Detecting a shell string that may call localhost or read a token is heuristic. It is an alert signal only; it cannot establish that the caller is an agent, a human, or an approved Dashboard action, and it must not alter authorization.
- C's current implementation has pure mode/alert constructors and deferred persistence; the parent must not claim the self-approval detection requirement complete until a follow-up adds the locked event writer plus redacted hook integration tests.
