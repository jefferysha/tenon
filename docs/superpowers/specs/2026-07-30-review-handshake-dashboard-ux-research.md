> **Deprecated historical note (2026-09-13):** The host-bound `humanReviewApproved` Dashboard exception described below was removed. This research remains historical; current runtime behavior requires an exact receipt and matching binding, and Dashboard must use the shared review application contract.

# Review Handshake Dashboard UX 调研

日期：2026-07-30
范围：桌面 Dashboard（1024–1920px）只读调研；不修改产品实现。
基线：`origin/main` / `445aa1411d45a2c112d296a9fc3530db0f62e31e`，已包含 PR #19。

## 结论

最小且不重复的落点是 **Progress Drawer 顶部既有动作区中的一张只读 Review
Handshake 状态卡**。状态卡只在当前 step 为 `gate: review` 时出现，展示 canonical receipt
的三态（未请求 / 待确认 / 已批准）、exact event 和下一步说明；无 review gate 时不渲染。

实现应局限在 `progress/` 功能域：新增小型纯展示组件，由 `ProgressActions` 在 gate 分支中组合，
复用 Drawer 现成的 focus trap、Escape、焦点归还、snapshot loading/error 和 SSE 刷新。不要把
状态塞进 WorkflowCanvas 卡片，不要改状态筛选，不要恢复 Inbox，也不要把状态卡放入共享
`TaskDetail` 的文档证据区。

最重要的语义边界：Review Handshake 是 CLI/agent 路径的 canonical exact-event receipt；
Dashboard 当前经过鉴权的具体 transition 点击本身就是 host-bound 人工批准面。
`packages/server/src/transition.ts:263-265` 显式传入 `humanReviewApproved: true`，
`packages/kernel/src/workflow/transition-application.ts:326-335` 也保留这条 Dashboard 例外。
因此：

- 未请求或待确认 **不得**自动禁用现有 Dashboard transition 按钮；
- 状态卡不能把 receipt 说成 Dashboard 按钮的硬前置；
- 多出口时，状态卡必须逐字显示 receipt 绑定的 event，不能概括成“本阶段已确认”；
- 用户点击另一个 event 是一次新的、明确的 Dashboard 决策，不是复用旧 receipt。

## 已确认的事实路径

### 1. Snapshot 与 decoder

- `packages/server/src/types.ts:29-55`：`ChangeSnapshot` 当前包含通用 `fields`、冻结
  `workflowRules`、逐 Change `workflowExecution`、文档证据和 terminal activity，没有专门的
  Review Handshake DTO。
- `packages/server/src/snapshot.ts:244-276`：服务端从 canonical state 构造每个 Change 的
  snapshot；这是增加只读投影的正确边界，不需要新轮询或写端点。
- `packages/dashboard-app/src/types.ts:7-28`：前端手工镜像 `ChangeSnapshot`，新增投影必须同步。
- `packages/dashboard-app/src/api/snapshotDecoder.ts:78-116`：`decodeChange` 对嵌套可选投影执行
  runtime decode，出现字段但形状非法时会拒绝整个 Change；Review Handshake 应沿用这一
  fail-closed 模式。
- `packages/dashboard-app/src/api/snapshotClient.ts:5-15,35-55`：初始 GET 和 SSE 都经过同一个
  decoder；新增投影天然覆盖首次加载与实时更新，不应创建第二套客户端请求。
- `packages/kernel/src/state/review-gate.ts:19-75`：canonical receipt 的真相是
  `status + phase + exact event + requested/acknowledged time`，成功 transition 会消费并清空
  receipt。

建议的最小前端镜像为可选判别联合：

```ts
type ReviewHandshakeSnapshot =
  | { status: 'unrequested'; phase: string }
  | { status: 'pending'; phase: string; event: string; requestedAt: string }
  | {
      status: 'approved'
      phase: string
      event: string
      requestedAt: string
      acknowledgedAt: string
    }
```

`reviewHandshake?: ReviewHandshakeSnapshot` 保持旧 server 响应可读。当前 step 是否为 review gate
继续取 `workflowRules.gateByStep[phase]`，不要在 DTO 中复制 gate 类型。服务端应调用 kernel
review helper 形成 DTO，前端不得再从 `fields.review_gate_*` 拼状态。

Decoder 至少校验：

1. `status` 只允许三态；
2. `phase` 必须等于 Change 当前 `phase`；
3. pending/approved 的 `event` 必须属于当前 phase 的已冻结出边；
4. pending 必须有 `requestedAt` 且不得有 `acknowledgedAt`；
5. approved 必须同时有两个时间；
6. unrequested 不得夹带 event 或时间；
7. 属性存在但不满足判别联合时拒绝 snapshot；属性缺失视为旧 server 的“状态不可用”，不能冒充
   “未请求”。

不应投影 delegated authority 的 host session、token、marker 路径或本机绝对路径。用户需要的是
状态与 exact event，不是授权来源细节。

### 2. Progress、WorkflowCanvas 与当前动作

- `packages/dashboard-app/src/model/progressModel.ts:78-135`：`gate` 只表达“review step 且 transition
  readiness 足够”，不表达是否 request/acknowledge；`confirm` gate 明确不是 Dashboard 拍板点。
- `packages/dashboard-app/src/progress/progressViewModel.ts:78-119`：当前“可以放行 / 等你判断”由
  evidence/guard 计算，和 canonical receipt 是两件事。
- `packages/dashboard-app/src/progress/ProgressView.tsx:139-193`：Progress 的扁平行、状态筛选和
  workflow 范围已由同源模型构造。
- `packages/dashboard-app/src/progress/ProgressView.tsx:259-277`：Drawer transition 直接调用
  `postTransition`，成功后做乐观 phase patch，失败回滚。
- `packages/dashboard-app/src/progress/ProgressActions.tsx:37-77`：当前 gate 动作会完整列出所有
  forward/backward event；多出口是已支持契约，状态卡不能只看首个按钮。
- `packages/dashboard-app/src/api/snapshotClient.ts:18-33`：写动作只提交 `{root,event}`，没有
  review request/acknowledge API。
- `packages/dashboard-app/src/progress/WorkflowCanvas.tsx:238-330`：画布卡已经承载状态、来源、
  workflow 和打开 Drawer 的入口；继续塞 receipt/event 会挤压信息层级。
- `packages/dashboard-app/src/progress/ProgressView.tsx:541-560`：Drawer 是当前 Change 唯一详情和
  动作面，最适合解释“此刻这个 exact event 的 receipt 到哪一步”。
- `packages/dashboard-app/src/shared/TaskDetailIntro.tsx:25-47`：顶部结构是名称/徽章、动作条、
  `from → to` foot label；状态卡可以在 `ProgressActions` 内组合，不必改共享详情组件 API。

### 3. Inbox 现状

- `packages/dashboard-app/src/App.tsx:24-30,137-142`：Inbox 顶级视图已经退役；只保留
  `selectInbox` 作为 Progress 导航徽标的“现在能拍板”同源选择器。
- `packages/dashboard-app/src/inbox/inbox.ts:31-35`：前端 Inbox 判据是 progress state 的
  `gate | failed`，不是 canonical pending receipt。
- `packages/cli/src/commands/inbox.ts:5-12,112-131`：CLI Inbox 才会把 canonical pending receipt
  列为 `review-request`。这证明 receipt 具有用户价值，但不构成恢复 Dashboard Inbox 的理由。

### 4. Loading / error / empty / keyboard 现状

- `packages/dashboard-app/src/progress/ProgressView.tsx:515-526`：初始 loading 使用
  `role=status`，错误使用 `role=alert`，无在制任务有明确 empty status。
- `packages/dashboard-app/src/state/useSnapshot.ts:44-80`：GET refresh 与 SSE 共用 snapshot
  状态；SSE 收到新帧会更新 Drawer，断线由 App 的 offline banner 提示“数据可能过期”。
- `packages/dashboard-app/src/progress/useProgressDrawer.ts:115-160`：Drawer 已覆盖 Escape、Tab
  focus trap、首焦点与关闭后的触发器焦点归还。
- `packages/dashboard-app/src/progress/ProgressToolbar.test.tsx:58-76`：PR #19 已覆盖筛选 tab 的
  Arrow/Home/End roving tabindex。
- `packages/dashboard-app/src/progress/ProgressView.test.tsx:338-360,843-895,982-1014,1050-1089`：
  已有页面 loading/error/empty、Drawer Escape、内层 modal、focus trap、触发器焦点归还测试。

## 方案比较

### 方案 A：WorkflowCanvas 小卡增加 receipt chip

在每个 review Change 卡片上显示“未请求 / 待确认 / 已批准”和 event。

优点：

- 一眼可扫多个 Change；
- 不打开 Drawer 也能看状态。

问题：

- 与 PR #19 已完成的卡片状态、筛选、禁用与无障碍语义直接重叠；
- 卡片现有层级已有运行来源、状态、workflow、阶段和打开 CTA，继续加入 event 会变成信息墙；
- 多出口 receipt 的解释离动作太远，用户仍不知道哪个按钮对应哪个 event；
- 会迫使 `WorkflowCanvas` / `progressCanvasModel` / PR #19 测试大面积变化。

结论：不选。

### 方案 B：Progress Drawer 顶部动作区内的只读状态卡（推荐）

新增 `progress/ReviewHandshakeStatus.tsx`，由 `ProgressActions` 的 gate 分支在 transition 按钮上方
渲染。卡片包含一个状态标题、一行 next step、pending/approved 时的 monospace exact event。

优点：

- receipt 与实际 event 按钮在同一决策上下文，信息层级最清楚；
- 复用现有 Drawer 深链、focus trap、Escape、SSE 和 toast，不增加导航或请求；
- 可完全避开 PR #19 的 Toolbar/Canvas/filter 改动；
- 组件归属 `progress/`，不污染共享 `TaskDetail`，也不碰并行的 Projects、AFK、文档证据时间线。

代价：

- 需要打开 Drawer 才能看详细 receipt；
- `ProgressActions` 需要从“按钮片段”变为可容纳只读说明 + 按钮的局部组合。

结论：推荐。

### 方案 C：恢复 Dashboard Inbox / 新建 Review 队列

把 pending receipt 聚合成独立列表或导航入口。

优点：

- 多项目待确认任务适合集中分诊；
- 与 CLI Inbox 概念接近。

问题：

- 顶级 Inbox 已被明确退役，恢复会逆转当前 IA；
- 与 Progress 的“等你动手”筛选和导航计数重复；
- 需要跨项目选择、路由、空态、排序和新页面测试，远超最小纵向切片；
- 与当前功能目标“解释 handshake 状态”相比，先造了第二个工作面。

结论：不选。

## 推荐交互规格

### 信息结构

Drawer 顶部保持：

1. Change 名 + 现有 readiness badge；
2. **Review Handshake 状态卡**；
3. 现有 transition actions；
4. 现有 `phase → target` 技术脚注；
5. 后续阶段、证据、历史等详情。

readiness badge 与 handshake 卡必须使用不同名称：

- readiness：`产出已齐 / 仍缺产出`（回答“guard 能不能走”）；
- handshake：`未请求复核 / 等待确认 / 已确认`（回答“canonical receipt 到哪一步”）。

不要继续把 readiness 命名为“可以放行”后又把 approved 命名为“已放行”；前者会让用户误以为
receipt 已存在。最低风险做法是只在状态卡文案中明确区分，不在本批重写 PR #19 的卡片 badge。

### 状态矩阵

| 页面/step/receipt | 展示 | exact event | 现有动作 | 可访问语义 |
| --- | --- | --- | --- | --- |
| 初始 snapshot loading | 复用 Progress `role=status`；不渲染 Drawer/卡 | 无 | 无 | `aria-live=polite` |
| snapshot error 且无 snapshot | 复用 Progress `role=alert`；不渲染 Drawer/卡 | 无 | 无 | assertive error |
| 有旧 snapshot + refresh error | 保留既有错误横幅与旧数据；卡片按旧帧展示 | 若旧帧有则显示 | 写端仍由 server 校验 | 不伪称实时 |
| 当前 step 非 review gate（含 null/confirm） | 不渲染卡，避免“无数据”噪音 | 无 | 保持现状 | 无额外 Tab stop |
| review gate + 新 server + `unrequested` | 中性/琥珀卡：“尚未发起复核请求” + “可让 agent 发起；也可在此直接选择一个出口” | `—`，不造默认 event | 保持所有合法按钮可用 | 静态说明；不是 alert |
| review gate + `pending` | 琥珀卡：“等待确认” + “请求只绑定下列 event” | monospace 原文 | 保持按钮可用；匹配按钮可加非交互标识 | `role=status`，SSE 变化 polite 宣告 |
| review gate + `approved` | 绿色卡：“已确认，可继续” + “该 receipt 只授权下列 event” | monospace 原文 | 保持按钮可用；匹配按钮可加非交互标识 | `role=status`，SSE 变化 polite 宣告 |
| review gate + handshake 属性缺失（旧 server） | 灰色卡：“复核状态不可用；操作仍由服务端校验” | 无 | 保持现状 | 不冒充 unrequested |
| handshake 属性存在但非法 | decoder 拒绝 snapshot，进入既有错误路径 | 无 | 无新动作 | `role=alert` |
| transition 成功 | receipt 被 server 消费；乐观 phase patch 先更新，SSE 后收敛 | 当前卡随 phase 消失/重置 | 保持现有 busy/乐观更新 | 成功 toast + 后续 snapshot |
| transition 失败 | 卡片与按钮保持原状态，乐观 patch 回滚 | 保留 | 可重试 | 现有失败 toast |

### 文案建议（中英文）

| key 意图 | 中文 | English |
| --- | --- | --- |
| 标题 | Review Handshake | Review Handshake |
| unrequested | 尚未发起复核请求 | Review not requested |
| unrequested next | 可让 agent 发起请求；你也可以在此直接选择一个出口 | Ask the agent to request review, or choose an exit here directly |
| pending | 等待明确确认 | Awaiting explicit confirmation |
| pending next | 此请求只绑定下列 event | This request applies only to the event below |
| approved | 已确认，可继续 | Approved and ready |
| approved next | 此回执只授权下列 event | This receipt authorizes only the event below |
| unavailable | 当前服务未提供复核状态；操作仍由服务端校验 | Review status is unavailable; the server still validates actions |
| event label | 精确事件 | Exact event |

不要翻译 event 值本身；它是 frozen workflow contract 的标识符。

## 建议实现与测试落点

### 文件边界

- `packages/server/src/types.ts`：增加服务端只读 DTO。
- `packages/server/src/snapshot.ts`：从 kernel canonical helper 投影三态；不新增 endpoint。
- `packages/server/src/snapshot.test.ts`：三态、exact event、transition 消费后的 unrequested、历史
  Change 空字段。
- `packages/dashboard-app/src/types.ts`：镜像判别联合。
- `packages/dashboard-app/src/api/snapshotDecoder.ts`：严格 decode 与跨字段不变式。
- `packages/dashboard-app/src/api/boundaryDecoders.test.tsx` 或相邻 decoder 测试：缺失兼容、三态、
  非法 phase/event/time 拒绝。
- `packages/dashboard-app/src/progress/ReviewHandshakeStatus.tsx`：纯展示，无 fetch、无状态机副本。
- `packages/dashboard-app/src/progress/ReviewHandshakeStatus.test.tsx`：三态、旧 server unavailable、
  no gate/null、zh/en、ARIA。
- `packages/dashboard-app/src/progress/ProgressActions.tsx`：仅在 gate 分支组合状态卡和现有按钮。
- `packages/dashboard-app/src/progress/ProgressView.test.tsx`：Drawer 集成、multi-edge exact-event、
  pending→approved SSE rerender、transition 成功/失败不回归、Tab/Escape/焦点归还。
- `packages/dashboard-app/src/i18n/translations.ts` 与 `i18n.test.tsx`：中英文对称、无 raw key。

不建议改：

- `ProgressToolbar.tsx`、`WorkflowCanvas.tsx`、`progressCanvasModel.ts`（PR #19 范围）；
- `App.tsx`、Nav、`inbox/`（不恢复 Inbox）；
- `shared/TaskDetail.tsx`、`TaskDocumentsSection.tsx`（避免并行文档证据时间线范围）；
- Projects、AFK 相关文件（当前并行 Dashboard 批次）。

### 自动化测试清单

1. Decoder：
   - missing optional property → Change 仍可解码；
   - unrequested/pending/approved 三态通过；
   - status/event/phase/timestamp 不一致 → 拒绝；
   - pending exact event 不在 frozen transitions → 拒绝；
   - DTO 不接受额外 authority/session/path 字段。
2. 组件：
   - no review gate → 零状态卡、零新增 Tab stop；
   - unrequested → 无假 event、按钮仍可点；
   - pending/approved → 原文 exact event、`role=status`、中英文无串语；
   - 旧 server → unavailable，不显示 unrequested；
   - 多出口 → receipt event 只标识匹配按钮，其他按钮不消失、不被误禁用。
3. 集成：
   - 初始 loading/error/empty 复用现状；
   - Drawer 打开后 snapshot rerender `pending → approved`，焦点不跳走；
   - 点击 matching/non-matching event 均提交用户实际选择的 event；
   - POST 失败保持卡片、回滚乐观 patch、保留 Drawer；
   - POST 成功 phase 推进并消费 receipt 后卡片按新 step 收敛；
   - Escape、Tab 首尾循环、关闭后焦点回到原 WorkflowCanvas 卡。
4. i18n：
   - zh/en key 集合对称；
   - 英文视图无中文 fallback；
   - event 值逐字、不翻译。

### 浏览器验收

真实生产 Dashboard 只验桌面：

- 1024×768、1440×900、1920×1080；
- Light / Dark / System；
- unrequested、pending、approved、旧 server unavailable、非 review step；
- default verify 双出口与至少一个 custom workflow 多出口；
- 键盘从 WorkflowCanvas 卡进入 Drawer，Tab 遍历状态后的动作，Escape 关闭并归还焦点；
- SSE 帧将 pending 更新为 approved 时无 Drawer 重开、无焦点丢失；
- initial loading、server error、真实 empty；
- reduced-motion 下无额外动画依赖。

## 风险

1. **把 readiness 和 receipt 混为一谈（高）**
   当前 `gate`/“可以放行”来自 guard readiness。若状态卡直接复用该 badge，用户仍无法判断 request
   是否建立。必须使用独立判别联合与独立文案。

2. **错误禁用 Dashboard 动作（高）**
   Dashboard 点击本身是人工批准面。用 receipt 状态禁用按钮会改变已有产品能力和
   `humanReviewApproved` 契约，超出“只读状态”范围。

3. **多出口 event 被模糊化（高）**
   Verify 的 `verify-pass` 与 `verify-fail` 不可互用。UI、decoder 和测试都必须保留 exact event。

4. **旧 server 缺字段被误报成 unrequested（中）**
   optional property 缺失只代表能力不可用；当前 server 必须显式返回 `unrequested`。

5. **状态卡塞进画布造成 PR #19 回归（中）**
   会碰筛选、disabled、aria-hidden 和键盘模型。把范围固定在 Drawer。

6. **snapshot 严格解码放大单条坏状态（中）**
   现有 nested projection 已采用 fail-closed。服务端投影必须先保证历史空字段稳定映射为
   unrequested，避免正常旧 Change 触发全页错误。

7. **pending 时间被误作 SLA（低）**
   本批不展示“等待 X 分钟”或超时颜色；marker TTL 与 canonical receipt 生命周期不同，避免制造
   第二套超时政策。

## 开放问题

1. Snapshot capability 是否新增显式键（例如 `review_handshake_status`）？若 rolling compatibility
   必须区分旧 server 与新 server，capability 比猜版本可靠；但最小实现也可用 optional property +
   unavailable 文案。
2. approved 状态是否展示 `acknowledgedAt`？它对审计有价值，但不影响当前决策；建议首版只在
   `title` 或技术详情显示，主卡不展示时间。
3. pending/approved 的 matching action 是否加非交互 `aria-describedby`？建议加，以便读屏把 exact
   event 与对应按钮关联；不要新增可聚焦 chip。
4. 对 pending event 点击另一出口时，是否需要一行即时说明“这将作为新的直接 Dashboard 决策”？
   从安全清晰度看值得做，但不应增加二次确认或改 server 语义；可作为按钮组下方的静态说明。
5. `ProgressActions` 当前返回片段，若新增状态卡后 JSX 过长，应拆成 `ReviewGateActions` +
   `ReviewHandshakeStatus`，不要让 `ProgressView.tsx` 再增长。

## 推荐验收判定

当且仅当以下都成立，前端 UX 才算完成：

- 用户在 Drawer 内能明确区分 guard readiness 与 canonical receipt；
- pending/approved 状态始终展示 exact event；
- 无 review gate、旧 server、loading、error、transition failure 均不说谎；
- 现有 Dashboard 的 event 点击能力、multi-edge 行为和服务端校验不变；
- keyboard/focus、zh/en、Light/Dark/System 和 1024–1920px 真实浏览器验收通过；
- PR #19 的 Toolbar/Canvas/filter 文件保持不动。
