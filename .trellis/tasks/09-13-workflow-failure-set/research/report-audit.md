# Research: 竞品/产品研究报告与当前 Tenon 实现核对

- Query: 对照用户提供的竞品与 Tenon 产品研究报告，核对 Dashboard 只读与 review gate、审计时间线、server API/UI 复用、未提交改动、npm 发布，以及 P0/P1/P2 结论。
- Scope: mixed（当前分支代码、文档、git 状态；竞品与 npm 公开资料仅做可复核性审计）
- Date: 2026-09-13

## Findings

### 1. “Dashboard progress 完全只读，gate: review 只是徽标”——高置信度成立，但应限定为当前生产 UI

- `packages/dashboard-app/src/shell/views.ts:2-7` 将主导航收敛为只有 `progress` 和 `workbench`；`App.tsx:291-309` 把 progress 渲染为 `WorkspaceView`。
- `packages/dashboard-app/src/workspace/WorkspaceView.tsx:34-35` 的注释明确写“只读”，`WorkspaceView.tsx:100-133` 只组装项目栏、任务列表和 `TaskDetailPane`，没有 transition/review mutation 回调。
- `packages/dashboard-app/src/workspace/TaskDetailPane.tsx:66-124` 的详情页只提供复制深链（`TaskDetailPane.tsx:86-95`）；阶段栏、Skill、artifact、输入/输出和文件抽屉都没有批准/驳回/退回按钮。`TaskCard.tsx` 也只是选中卡片。
- `packages/dashboard-app/src/App.tsx:210-216` 和 `TopBar.tsx:155-169` 只用 `selectInbox` 计算待决定数量并显示 badge；`packages/dashboard-app/src/inbox/inbox.ts:53-77` 是纯筛选函数，未形成可操作 Inbox。
- 当前 Workbench 仍可编辑自定义 workflow：`packages/dashboard-app/src/workflow/StageEditorPane.tsx:151-183` 依据 `editor.canWrite` 提供 gate 三选按钮；这不反驳 progress 只读，而是说明“gate 可编辑”在 Workflow 页，不在 Change 决策页。
- 结论：报告应写成“当前主 Dashboard 的 progress/workspace 只读、review gate 在任务页不可操作”，不要笼统写成“Tenon 没有 gate 操作”。置信度：高。

### 2. “审计时间线被删”——对可见 UI 高置信度成立；对后端能力不成立

- 收敛提交 `b1aefaf` 删除了 `packages/dashboard-app/src/shared/RunAuditPanel.tsx`、`TaskHistorySection.tsx`、`advanced/TrafficPanel*`、`workbench/Timeline*` 等组件；同一提交说明 Dashboard “No skills / plan / terminal / records sheets, no write actions”。这是当前 UI 删除时间线/运行审计的直接历史证据。
- 但 server 仍提供 Change 历史与运行审计：`packages/server/src/serverGetActivityRoutes.ts:133-156` 实现 `GET /api/change/:name/history`；`serverGetActivityRoutes.ts:158-180` 实现 `GET /api/change/:name/run-detail`。
- `packages/server/src/runDetail.ts:145-208` 聚合 canonical revision 链、TransitionRecord、attempt context 与 loop ledger（含坏账本 health）；这已经覆盖阶段流转、revision、运行尝试和 token/ledger 相关事实的一部分。
- trace 侧也未删除：`packages/server/src/serverGetTraceRoutes.ts:24-74` 与 `packages/server/src/traces.ts:276-300` 仍有 sessions、records、metadata-only timeline；`packages/dashboard-app/src/api/auditClient.ts:28-67` 和 `packages/dashboard-app/src/api/client.ts:81-88` 仍保留对应客户端 facade。
- 但当前 UI 没有任何 production component 调用 `fetchRunDetail`/`fetchTraceTimeline`；这些调用只在 API tests 与 facade 中出现。故“用户在界面上体会不到追溯”成立；“审计能力已从系统删除”不成立。置信度：UI 结论高，后端删除结论低（报告需修订）。

### 3. “actor 字段现在留空”——高置信度成立，且是 P0 的真实数据地基缺口

- `packages/kernel/src/workflow/run-types.ts:62-83` 的 `TransitionRecord.actor` 是可选字段，并明确注释“没有可信来源前不填假值”。
- 生产 repository 在 `packages/kernel/src/state/workflow-run-repository.ts:370-386` 直接写入 `actor: draft.actor`；`packages/kernel/src/workflow/transition-application.ts:394-396` 提交 draft 时只有 `event/from/to`，没有 actor。因此普通 CLI/server TransitionRecord 通常不会留下 actor。
- 需要注意：Orchestration v2 另一条记录体系已有结构化 actor（例如 `packages/kernel/src/orchestration/v2-types.ts:26-35`），不能把它与传统 workflow TransitionRecord 混为一谈。
- 结论：门禁决策台补 actor 是合理 P0，但应先定义 actor 可信来源/身份绑定，再把浏览器 token 或静态字符串写进记录；不能仅在 UI 层补字段。置信度：高。

### 4. “主要复用现有接口”——部分成立；review 决策与 replay 仍需补协议/UI

- 现有写入口是 `POST /api/change/:name/transition`：`packages/server/src/serverPostExecutionRoutes.ts:285-317` 校验 root/event 后调用统一 `performTransition`；`packages/server/src/transition.ts:315-324` 将 Dashboard 认证点击标成 `humanReviewApproved: true`。因此批准/驳回/退回若都建模为冻结 workflow 的 event，可以复用这一入口。
- 但 server 没有 `review request` 或 `review acknowledge` HTTP 路由；两阶段协议仍在 CLI `packages/cli/src/commands/review.ts:1-7,61-92`。所以“右栏直接批准/驳回/退回并写流转记录”不能只靠现有 review API；需要明确是复用 transition event（推荐）还是新增受控 review endpoint。
- `GET /api/change/:name/history` 与 `GET /api/change/:name/run-detail` 可作为回放底层数据，但当前 UI 没有消费组件。`packages/dashboard-app/src/api/governanceClient.ts:154-165` 仅导出 history client，未被可见视图使用。
- 产物对比底层已有读模型：`packages/server/src/serverArtifactRoutes.ts:45-105` 提供 catalog/inspect/read/events，`packages/dashboard-app/src/workspace/ArtifactCatalogPanel.tsx:22-40` 可展示真实 artifact 版本、subject projection、history reference 与内容。故“产物版本对比建议最先做”有较强复用基础，但仍需 diff 投影与 UI。
- 置信度：接口复用部分中高；“完整决策台只需接现有接口”低。

### 5. “server 60+ 接口、UI 只用了约 15 个”——方向可信，数字需要固定口径

- 非测试 server 源码中，当前脚本按 `/api/` 字面路径统计到 55 个 unique exact literals（66 次引用）；动态 regex、委托路由和同一 handler 的 query/action 变体会使实际操作面高于或不同于 55。`packages/server/src/serverGetRoutes.ts:115-174` 展示了大量委托域（orchestration、catalog、task plan/run、skill invocation、documents、loops 等），不能直接把测试字符串总数当 API 数。
- 可见 App 只挂两页（`App.tsx:291-309`），Workspace 主要消费 snapshot、workflow definition、documents、artifact catalog/read；Workbench 的 `useWorkflowEditor` 消费 workflow/tracks/skills/hooks 等。因此“后端能力远多于可见主界面”成立，但“约 15”没有现成 canonical 统计，需在报告中给出 endpoint 计数方法（production source only、按 route+method+variant 去重）。置信度：比例中高，精确数字低。

### 6. “文档仍描述已删除视图/能力”——高置信度成立，且有具体不一致

- 当前英文文档 `docs/usage/dashboard-and-local-api.md:47-60` 已把主导航写为两项，但仍称 Progress 是“Workflow graph, phase, Todo, history, and evidence”；当前 `WorkspaceView`/`TaskDetailPane` 没有 history/evidence 组件，只有阶段与 IO/artifact 文件读取。`docs/usage/dashboard-and-local-api.md:82-84` 还称 Workbench 包含 hooks、automation、loops/configuration，当前 `WorkflowView`/`StageEditorPane` 的 production surface 已明显精简。
- 当前中文文档 `docs/usage/zh-CN/dashboard-and-local-api.md:2-3` 仍写 Dashboard 显示 review、AFK、loop 和证据；`zh-CN:75-86` 又写 AFK、Machine、Host Plan 从设置面板进入，但 `TopBar.tsx:183-238` 的 settings 只有主题和语言。`zh-CN:83-84` 还说 progress 详情“执行下一动作”，与只读 `TaskDetailPane` 冲突。
- 这些文档在工作区有未提交修改（`git diff -- docs/usage/...` 可见视图从多页删到两页），说明修订正在进行但尚未收口；报告的“需修文档”应保留并列出上述具体段落。
- 置信度：高。

### 7. “auto gate 只检查产出非空”——对 transition gate 基本成立，但不能忽略 artifact 生产者/声明校验

- `packages/kernel/src/workflow/compile.ts:229-237` 明确把 `gate: auto` 编译成每条出边的 `nonempty-output` guards；这支持报告对 auto gate 语义的判断。
- 但 artifact register 不是简单字段非空：`packages/cli/src/commands/artifact.ts:79-115` 还校验 declaration、`required_when`、producer policy、effective skill slot 和 producer identity；server 的 runtime artifact 读模型也有 catalog/inspect/read/events（`serverArtifactRoutes.ts:72-105`）。
- 因此 P1 “产出验收条件”是从现有 nonempty gate 扩展为用户定义条件，方向正确；表述应改成“当前 auto transition gate 的默认条件是 output nonempty，artifact register 另有 producer/声明完整性门禁”，不要说系统所有产物都只验非空。置信度：高。

### 8. “工作流能编辑但没有预演/流程体检”——编辑已有，预演/体检大多是待建设

- Workflow 编辑已有：`packages/dashboard-app/src/workflow/WorkflowView.tsx` 与 `StageEditorPane.tsx:151-183` 支持自定义 workflow、stage、skills、gate、退回边写回。
- Router preview API 已存在（`packages/dashboard-app/src/api/governanceClient.ts:167-183`、server post route 中 `/api/router/preview`），但它是 track routing/prompt 候选预览，不是报告所说“输入示例需求后模拟完整 workflow 分支、阶段、skill、停点”。
- 当前源码没有按真实运行统计阶段退回率、驳回理由、耗时、token 并生成编辑草稿的可见模块；`run-detail` 有 transitions/ledger 原始事实，但没有此聚合建议层。故“流程体检”仍是差异化 P1 机会，不能描述成现有能力。
- 置信度：高。

### 9. “143 个未提交改动”——历史快照数字不可复现；当前工作区是 146 条 status 记录

- 在 2026-09-13 当前 checkout（`codex/autonomous-loop-v1`, HEAD `ad1d7d1`）执行 `git status --short | wc -l` 得到 146；排除当前研究任务目录仍有 145，tracked-only 为 109。当前任务目录本身是 untracked，因此会改变总行数。
- 结论：报告的 143 不能作为当前证据，应改为“工作区高度脏，具体数量随并发任务变化；本次核对时为 146 status 条目（含研究任务目录）”。不要把该数量当发布/质量结论。置信度：高。

### 10. “发布到 npm”——当前仓库未发布官方 npm CLI；无 scoped 名称，且 unscoped `tenon` 已被他人占用

- 根 `package.json:1-8` 是 private npm workspace；`README.md:268-270` 明确“不对外声称已发布全局 npm CLI”。
- `README.md:124-125` 与 `README.md:254-263` 说明薄 npx 包已进发布流水线，但只有拥有 npm scope 后才公布准确包名，自动化“不执行 npm publish”，可选 npx 包只是 GitHub Release 资产。
- `release-candidate.yml:188-207` 仅在 `TENON_NPM_PACKAGE` 变量存在时 `npm pack` 到 release payload，没有 `npm publish`。
- 2026-09-13 `npm view tenon` 返回 `tenon@2.0.21`（旧的同名第三方包），`npm view @tenon/cli` 与 `@tenon-internal/npm-bootstrap` 均 404。故“Tenon 官方没有 npm 包”可成立，但“tenon 这个名字空闲、直接发布即可”不成立；P0/P1 发布建议必须先定 scope/包名、认领权与供应链验证。置信度：官方仓库状态高；npm registry 状态以本次查询为准，可能变化。

### 11. 竞品星数、issue/token 数字——当前仓库无法证实，报告的 caveat 应升级为证据要求

- 用户报告没有给出 外部项目 A/B 的 canonical repository URL、commit/tag、issue 链接或抓取日期；仅凭“14.6k/3k star”“#350/#364”“4500 万 token”无法在本仓库建立可审计证据。
- 外部搜索只能确认 外部项目 A 的公开文档仍描述 `.trellis/`、task.py 与多平台集成（例如 外部项目公开文档），不能确认报告中的实时 star 或 issue 数字。竞品性能/通过率应继续标记为官方自测、未独立复核。
- 置信度：竞品架构方向中等；具体数字低。修订建议：为每条外部数字补 canonical URL、采集日期、版本/commit 和“官方自测”标签，或从结论正文移到附录。

## Related specs

- `.trellis/workflow.md`（任务与 research 持久化规则；本报告写入当前任务 `research/`）。
- `.agent-rules/COMMON.md`（Dashboard/Server 分层、只读/写门禁、验证诚实性、禁止伪造发布证据）。
- `docs/usage/dashboard-and-local-api.md` 与 `docs/usage/zh-CN/dashboard-and-local-api.md`（当前存在的文档漂移证据）。
- `packages/kernel/src/workflow/run-types.ts`、`packages/kernel/src/workflow/compile.ts`（TransitionRecord actor 与 auto gate 合同）。

## Caveats / Not Found

- 未运行全量测试、未启动 Dashboard、未执行浏览器验收；本报告是静态代码/文档/git/API 路由核对，不代表运行时 UI 全部通过。
- API 数量依赖去重口径（HTTP method、query/action 变体、动态 regex 路由、测试字符串是否计入）；报告中的“60+ / 15”应先冻结计数方法。
- 未验证生产 release bundle 与当前 source 是否完全新鲜；当前工作区包含大量已修改/未跟踪生成物，不能把 source 结论直接外推为已发布包行为。
- “actor”在 Orchestration v2 记录中已有结构化类型，但传统 Workflow TransitionRecord 仍允许缺省；P0 设计必须选定要覆盖的记录域。
- 竞品 star、issue、token 与下载量均属外部时变数据；本次未对其性能/通过率做独立复测。
