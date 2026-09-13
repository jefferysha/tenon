> **Deprecated historical note (2026-09-13):** This document describes the former `humanReviewApproved` Dashboard bypass and is retained only as historical design context. The field and exception were removed; current transitions require an exact receipt plus review binding. Do not use this file as the current runtime contract.

# Review Handshake 状态设计

## 用户结果

桌面 Dashboard 用户打开当前 Change 的 Progress Drawer 后，可以把两件事清楚区分开：

1. transition 的产物与 guard 是否已经满足；
2. canonical exact-event review receipt 是尚未请求、等待确认，还是已经批准等待消费。

状态来自现有 canonical Change state，经 server 形成稳定的只读 snapshot DTO；Dashboard 不解释
`review_gate_*` 原始字段，不增加 review 写端点，也不改变 Dashboard 现有直接选择出口的人工批准语义。

## 现状与证据

### Tenon 代码事实

- kernel 的 `review-gate.ts` 已集中定义 `pending` / `approved`、phase/event 精确匹配和成功
  transition 后消费 receipt；CLI integration 已锁定 request → acknowledge → transition 生命周期。
- server 的 `snapshot.ts` 已从 `StateStore.read()` 读取 canonical state，并让 HTTP 与 SSE 共用一个
  Change snapshot；新增只读投影不需要第二请求。
- Dashboard 当前的 `workflowExecution.readinessByTransition` 只回答 guard 是否满足，
  `ProgressActions` 的 Dashboard transition 又是独立的 host-bound 人工批准面。receipt 状态不得
  禁用、代替或泛化现有按钮。
- 当前 Change DTO 仍暴露宽泛 `fields`，但没有安全、结构化、可验证的 Review Handshake 投影。

详细证据见：

- `2026-07-30-review-handshake-backend-contract-research.md`
- `2026-07-30-review-handshake-dashboard-ux-research.md`
- `2026-07-30-review-handshake-upstream-research.md`

### 固定上游证据（读取日期 2026-07-30）

| 上游 | 默认分支固定 SHA | 稳定 release/tag |
| --- | --- | --- |
| mindfold-ai/Trellis | `c94d6fc289b7a6fdd9480bdfae4d4639c9ac2d4c` | 无 GitHub Release；回退稳定 tag `v0.6.10` |
| rpamis/comet | `92d418eb93ce07c95b0855b2d36da4f6fdaea92d` | GitHub latest `0.4.0-beta.11`；严格 SemVer 稳定 tag `0.3.9` |
| Chorus-AIDLC/Chorus | `be647877b4b56a61e480e939d6a6d31b3f84f7f9` | `v0.14.5` |
| catlog22/maestro-flow | `5375fb589f182c1c7e9cade69b4acd3ccd03bac1` | `v0.5.58` |
| liaohch3/claude-tap | `6cfe45afd7b6d009e839b178dd59b9e338b10309` | `v0.1.141` |

映射不是代码移植：Trellis 证明 review context 应留在任务边界；Comet 证明 canonical status 与
next step 应由服务端解释；Chorus 的 shared contract、Dashboard action、交互路径和 code-review
gateway 证明状态、预条件与恢复动作必须显式；Maestro 证明 projection 不应取代 canonical
authority；claude-tap 证明可观察事实必须保留 identity 且避免泄露敏感原始记录。Tenon 保留自己的
独特语义：receipt 同时绑定 Change、phase 和 exact event，并在成功 transition 后单次消费。

## 方案比较

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| Dashboard 直接解释 `fields.review_gate_*` | 改动最少 | 复制 kernel 状态机、兼容与异常语义，形成第二真相源 | 拒绝 |
| 现有 snapshot 增加判别联合，Drawer 显示只读状态卡 | HTTP/SSE 同源、兼容旧 runtime、紧邻决策上下文 | 需要同步 server/type/decoder/UI/tests | 采用 |
| 新增 handshake endpoint 或恢复 Inbox | 可独立演进、可聚合 | 第二轮询、竞态、重复已收敛 IA，超出最小切片 | 拒绝 |

## 共享契约

Server 的 `ChangeSnapshot` 必须始终返回：

```ts
type ReviewHandshakeSnapshot =
  | { status: 'not-requested' }
  | { status: 'pending'; event: string; requestedAt: string }
  | {
      status: 'approved'
      event: string
      requestedAt: string
      acknowledgedAt: string
    }
```

Dashboard 在滚动升级窗口内把 `reviewHandshake` 视为可选；缺字段只表示旧 runtime 不支持，绝不
回退解析 raw fields，也不能冒充 `not-requested`。

Server projector 必须使用当前 canonical state 与冻结 workflow plan：

- 五个 receipt 字段全空才返回 `not-requested`。
- `pending` / `approved` 的 receipt phase 必须等于当前 phase，当前 phase 必须是 review gate，
  event 必须非空且属于当前 step 的真实出边，`requestedAt` 必须非空。
- `pending` 不得带 acknowledged time；`approved` 必须带非空 acknowledged time。
- 未知 status、半组、漂移 phase 或不可达 event 必须 fail-loud，进入现有 Project/Change snapshot
  错误面，不能美化成安全空态。
- 不投影 host session、delegated authority、marker、token、本机路径或服务端本地化文案。

Snapshot protocol 保持 `tenon-snapshot/v2`：旧 Dashboard 会忽略新字段，新 Dashboard 接受旧
server 缺字段，字段一旦出现则以 exact-key 判别联合严格解码。

## Dashboard 交互

`ReviewHandshakeStatus` 是 Progress Drawer 当前阶段区的只读状态卡，位于 transition actions 之后、
Context Bundle Preview 之前。放在 Drawer 而非 `ProgressActions` 内，可让 guard 未齐的 review
step 也显示 `not-requested`，并避免修改共享 `TaskDetail` 的动作布局。

- 非 review/confirm/null gate：不渲染卡。
- 旧 runtime 缺字段：显示中性“状态不可用；操作仍由服务端校验”。
- `not-requested`：显示“尚未发起复核请求”，不造默认 event。
- `pending`：显示“等待明确确认”及原文 monospace exact event。
- `approved`：显示“已确认，可继续”及同一 exact event。
- 卡片使用 `aria-live=polite`；不增加按钮或 Tab stop。现有 transition buttons、busy、失败回滚、
  focus trap、Escape 和触发器焦点归还保持不变。
- 初始 loading、无 snapshot error、空项目继续由 `ProgressView` 的现有 status/alert/empty 承担；
  refresh error 有旧 snapshot 时保留旧卡并由全局离线/错误面说明数据可能过期。
- 中英文文案翻译状态和下一步，event identity 永不翻译。

## 关键业务规则

1. guard readiness 与 receipt handshake 是两条正交状态轴，不得合并为 `readyForReview`。
2. pending/approved 始终保留 exact event；`verify-pass` 的 receipt 不能表达 `verify-fail`。
3. Dashboard 点击某个出口本身仍是一次 host-bound 人工决策，receipt 未请求/待确认不得禁用按钮。
4. 旧 runtime、非法 DTO 和 `not-requested` 是三个不同状态；禁止相互降级。
5. UI 只读；任何未来 Dashboard acknowledge/write path 必须另立 Change 重新审计 authority。

## 状态机

| 当前 step / snapshot | 卡片状态 | 动作与收敛 |
| --- | --- | --- |
| 非 review gate | hidden | 保持原动作 |
| review + 旧 server | unavailable | 保持原动作，server 继续权威校验 |
| review + 全空 receipt | not-requested | 可由 agent 发起 request，或用户直接选择 Dashboard 出口 |
| request exact event | pending(event) | SSE 原位更新；现有出口均保持可选 |
| acknowledge exact event | approved(event) | SSE 原位更新；只说明该 receipt 的授权范围 |
| transition 成功 | receipt 被消费 | phase 推进，卡片按新 step 隐藏或回到新状态 |
| transition 失败 | canonical receipt 不变 | 现有乐观 patch 回滚，卡片保留 |
| 非法 receipt / DTO | fail-loud | server project error 或 decoder 现有 error path |

## 错误、兼容与安全

- Server 不读取 `.pipeline.yaml` 文本，不新增写入；继续通过 `StateStore` 读取 canonical state。
- Decoder 对已出现的对象拒绝未知 status、空 event、缺失/多余分支字段和不属于当前出边的 event。
- 时间只作为 canonical receipt 的事实展示基础，不做 SLA、过期颜色或第二套 TTL。
- 现有同源 token、root 信任锚、content-type、host authority 和 transition CAS 均不变。
- snapshot 构建失败沿现有项目错误隔离；不把错误 receipt 显示成绿色或空白批准。

## 测试与验收

- Server：三态、`verify-pass`/`verify-fail` exact event、历史全空、非法半组/phase/event fail-loud。
- Decoder：缺字段兼容、三合法分支、exact keys、空/未知/不可达 event、时间不变式。
- Component：非 review hidden、unavailable、三态、zh/en、ARIA、无新增 Tab stop。
- Integration：Drawer 展示、pending → approved rerender、transition 成功/失败、多出口按钮不回归。
- 真实浏览器（仅桌面）：1024×768、1440×900、1920×1080；Light/Dark/System；三态、旧 runtime、
  非 review、loading/error/empty、双出口、键盘、SSE、reduced-motion。

## Assumptions / Decision Log

| 假设 | 所有者与证据 | 若为假 | 文档落点 |
| --- | --- | --- | --- |
| canonical receipt 是唯一状态真相 | kernel `review-gate.ts` 与 CLI integration | 停止实现，不能由 server 猜状态 | 共享契约、关键业务规则 |
| snapshot 是正确只读边界 | HTTP/SSE 共用 `buildSnapshot` | 需另立 endpoint 设计与错误模型 | 方案比较、共享契约 |
| Dashboard direct transition 不依赖 CLI receipt | server 传 `humanReviewApproved: true` | 状态卡需改变动作禁用语义并重新过安全评审 | Dashboard 交互 |
| 三态 + exact event + 两时间足够首版 | Chorus/Maestro/claude-tap 映射及当前用户路径 | 另立 timeline capability，不扩充本轮 DTO | 共享契约、非目标 |
| Drawer 是唯一合适操作上下文 | 当前 IA 与 Progress focus tests | 若未来恢复聚合 review queue，再独立设计 | Dashboard 交互 |

## Grill 自检

- 所有权：kernel/canonical state 拥有 receipt；server 拥有 DTO 投影；decoder 只验证；组件只展示。
- 证据：每个状态都能追溯到 canonical fields、冻结 plan 和 HTTP/SSE 同源 snapshot。
- 失败模式：非法半组、旧 runtime、双出口混淆和 stale SSE 均有独立处理，不以默认绿态吞掉。
- 范围：不新增 review 写 API、不改 transition/authority、不改 Toolbar/Canvas/Inbox/AFK/Projects。
- 文档：状态规则进入 delta spec；实现顺序进入 plan；上游证据和备选方案留在 Explore 设计/ADR。

```coverage
touches:
L1_api:      filled -> #共享契约
L2_data:     waived -> 只读投影既有 canonical fields，无 schema、迁移或新持久化
L3_rules:    filled -> #关键业务规则
L4_state:    filled -> #状态机
L5_errors:   filled -> #错误、兼容与安全
L6_security: filled -> #错误、兼容与安全
L7_perf:     waived -> 每个 Change 只做固定字段与有界出边校验，无新增 I/O 或轮询
L8_deps:     waived -> 不新增或升级依赖
L10_terms:   filled -> #共享契约
```
