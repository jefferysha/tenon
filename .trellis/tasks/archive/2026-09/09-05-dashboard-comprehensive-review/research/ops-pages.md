# AFK 与工作台页面评审

评审基线：Tenon Dashboard 的日常任务是让用户知道项目当前状态、需要介入的 Change，以及下一步行动。AFK 和工作台目前把运行控制、治理配置、机器设置和诊断事实全部放进一级页面；以下按“是否直接帮助核心任务、是否高频、是否重复、是否有明确动作”判断保留、合并、下沉或移除。

## AFK（自动运行）

### 页面与信息架构

1. **P1：AFK 一级导航与进度页重复。建议移出一级导航，合并为进度页的“自动运行”筛选/抽屉。** AFK 页面只筛出 `automation` 为 running/queued/failed 的 Change（`AfkView.tsx:102-116`），而进度页本身已展示这些状态、日志和终止/重跑动作（`ProgressView.tsx` 与 `useAfkLog.ts`）。用户从进度进入 AFK 会再次学习同一套状态模型；没有自动任务时只剩一个空态。保留失败待处置计数和“查看流水线”入口即可，详情中的 AFK 日志、重试和接管动作并入进度抽屉。

2. **P1：页面有两个“创建”入口，文案和能力不一致。建议只保留一个主动作。** Header 的 `afk-new-run`（`AfkView.tsx:314-323`）与底部 sticky tool nav 的 `enqueue/starter/run`（`AfkView.tsx:476-489`）都能打开工具 Dialog；有任务时用户同时看到“新建运行”和底部“开启自动运行”，无任务时 Header 入口消失而底部仍在。统一为页面唯一的“运行此 Change”按钮；定时任务和验证放入更多菜单或机器设置。

3. **P1：队列行的迷你流水线与详情完整流水线重复，增加视觉噪声。建议删除 MiniTrack，仅在详情保留一条阶段轨。** 每行同时显示项目、阶段、状态和装饰性 MiniTrack（`AfkView.tsx:388-395`），点击后详情再次渲染可横向滚动的完整阶段轨（`AfkView.tsx:427-449`）。队列的决策信息只需要 Change 名、状态、当前阶段和更新时间；MiniTrack 对选择任务没有额外帮助。

4. **P1：单项目页面重复显示项目名。建议移除队列行的项目标签。** `currentRoot` 已由 App 选定且页面只能展示一个项目；每行再次显示 `项目 · <root>`（`AfkView.tsx:392`），在窄屏尤其占用垂直空间。

5. **P2：Activity 区只有一条与标题重复的事件，不能支持排障。建议移除或改成真实事件时间线。** 详情底部固定渲染一个“活动”列表，内容仅是 `updated_at + state`（`AfkView.tsx:464-469`）。它既没有历史，也没有新的动作；保留会让用户误以为可查看完整运行历史。

6. **P1：搜索无结果时没有空态，且详情仍展示隐藏的首行。建议让 selected 从 visibleRows 计算并显示“没有匹配项”。** `visibleRows` 按 query 过滤（`AfkView.tsx:267-272`），但 `selected` 仍从 `priorityRows` 取第一项（`AfkView.tsx:273-274`）。输入不匹配的查询后左侧列表为空，右侧仍显示旧任务，用户无法判断过滤是否生效。

7. **P2：设置加载失败静默，队列标题会缺少并发控制且没有原因。建议显示“无法读取设置”的非阻断提示和重试。** `fetchAutomationSettings` 的 catch 直接 fail-open（`AfkView.tsx:164-181`），失败时 `automationSettings` 为 null，select 不渲染；用户会把“没有并发设置”误认为产品没有该能力。

8. **P2：并发上限在任务队列标题旁直接自动保存，没有确认、撤销或作用域说明。建议移到机器设置，并使用明确的保存动作。** select 变化立即调用 `postAutomationSettings`（`AfkView.tsx:183-217`）。同一设置又在工作台“机器配置”中的 AutomationCard 出现（`WorkbenchSideRail.tsx:176-204`），形成两个入口和潜在竞态。

### 交互与功能取舍

9. **P1：AFK 工具 Dialog 暴露了创建定时任务、运行、同步、triage 等操作，超出日常 Dashboard 定位。建议仅保留“把现有 Change 入队”和“重试失败”；其余移到高级操作。** 底部工具区直接提供 `starter` 与 `run`（`AfkView.tsx:482-487`），OperationsPanel 还包含 loop id、runner、workflow、skill bundle、权限级别、真实运行、提交、同步和 triage 字段（`OperationsPanel.tsx:250-360`）。这些是运维/实验控制面，普通用户既不需要也难以判断风险。

10. **P2：失败态的“回终端”仅复制 `cd <worktree>`，动作结果没有在页面内体现。建议改成打开终端/工作区并在复制失败时显示错误。** `copyCmd` 只调用可选的 `navigator.clipboard?.writeText(...).then(...)`（`AfkView.tsx:224-226`），没有 catch；浏览器禁用剪贴板时用户没有反馈。按钮也只复制目录，不执行接管。

11. **P1：入队/重试成功后没有显式刷新。建议成功后触发 snapshot refresh 或更新本地行状态。** `runAction` 成功仅调用 toast（`AfkView.tsx:228-252`）；组件没有调用 `onRefresh`，因此在 SSE 延迟或断线时旧行会继续显示“排队/失败”，用户可能重复点击。

12. **P2：队列在移动端改为上下两段，但详情仍包含宽度 560px 的阶段轨。建议移动端默认只显示当前阶段和折叠轨。** 主网格在 `760px` 以下变一列（`AfkView.tsx:350-351`），详情阶段轨固定 `min-w-[560px]` 并依赖横向滚动（`AfkView.tsx:429-430`）。在 390px 屏幕需要二次横向滚动，且底部工具 sticky nav 与 App 的移动底部导航同时存在，操作层级拥挤。

## 工作台（Workbench）

### 页面与信息架构

1. **P0：页面首屏承载过多不同心智模型。建议拆为“流程编辑”主面板 + 一个高级设置入口。** `WorkbenchView` 顺序挂载 Header、WorkflowPolicyEditor、WorkflowPolicyRuntimeSummary、ExecutionTimelineComposer（`WorkbenchView.tsx:492-540`），首屏同时出现工作流切换/新建/复制/删除、治理、轨道选择、策略编辑、运行时指纹、阶段编排。日常用户无法判断先改哪一层；默认工作流还是只读，导致大量控件只用于解释内部模型。

2. **P1：WorkflowPolicyEditor 是治理后台，不应默认展开。建议折叠为“高级策略”，默认仅显示当前模式摘要。** 编辑器一次展示 decomposition 的 4 个 select/number、3 个自动条件、4 个询问条件、interaction mode 和 review max attempts（`WorkflowPolicyEditor.tsx:130-270`），共约 15 个控件，并带长解释文案。它们低频且有高风险，应在高级设置或治理 Dialog 中按需编辑。

3. **P1：WorkflowPolicyRuntimeSummary 是诊断报告，不是工作流编辑任务。建议移入治理 Dialog/Change 详情。** 组件固定渲染 configured、frozen、drift、effective 四个区块以及 workflow fingerprint、权限 grants/denials（`WorkflowPolicyRuntimeSummary.tsx:240-320`）。它自动选择最近更新的 Change（`WorkflowPolicyRuntimeSummary.tsx:25-45`），用户不能指定要检查的 Change，容易把“最新 Change 的运行时状态”误解为整个 workflow 状态。

4. **P1：工作台 Header 的操作过密，且“新建/复制/删除/治理/保存”没有主次。** `WorkbenchHeader` 同时渲染 workflow menu、new、copy、delete、governance、dirty/save、contract pills 和 TrackSelector（`WorkbenchHeader.tsx:104-147`）。建议保留工作流选择和保存为主操作；新建/复制/删除归入菜单；治理与 TrackSelector 下沉高级设置。

5. **P1：WorkbenchSideRail 在治理 Dialog 内继续嵌套完整 Loop 表单、机器配置和技能健康，形成第二个设置中心。** SideRail 同时挂 GovernanceRail、完整治理设置入口、机器配置折叠（AutomationCard、SecretsCard、SkillHealthPanel）以及摘要、安全门、最近流转（`WorkbenchSideRail.tsx:140-205`；`WorkbenchGovernanceDialog.tsx:35-64`）。建议把机器级设置移到独立“机器”页面，Loop 仅保留当前 workflow 相关的少数字段；工作台只显示摘要和下一步动作。

6. **P2：运行时事实面板重复技能、依赖、Hook、输出、Prompt 状态，且没有可操作动作。建议改为单行状态摘要。** `ExecutionTimelineComposer` 的右侧 preview 固定展示 5 行 facts、缺失技能警告和 snapshot 锁定态（`ExecutionTimelineComposer.tsx:368-392`），左侧技能列表又显示安装状态、来源和依赖（`ExecutionTimelineComposer.tsx:245-324`）。右栏应只在异常时出现，正常态不占一列。

### 交互与可用性

7. **P1：技能排序同时提供拖拽和上下箭头，重复交互增加学习成本。建议保留键盘可用的上下移动，拖拽作为渐进增强。** 每项技能都有 draggable、拖放落点提示，以及 ↑/↓ 两个按钮（`ExecutionTimelineComposer.tsx:245-320`）。拖放没有键盘等价操作；在触控设备上也难以发现可拖动。默认显示箭头，拖拽仅在桌面启用。

8. **P1：阶段排序同样依赖拖拽 + 每阶段两枚箭头，横向空间迅速膨胀。建议使用单一排序菜单或列表模式。** `TimelineStageStrip` 的每个阶段都 draggable，同时渲染向前/向后按钮（`TimelineStageStrip.tsx:37-121`），阶段区域还在窄屏强制横向滚动（`TimelineStageStrip.tsx:51-56`）。这使 5–7 个阶段的工作台在移动端变成横向操作条，主任务内容被挤出视口。

9. **P1：阶段名称通过点击标题进入编辑，没有明确编辑 affordance。建议使用“编辑名称”按钮或菜单。** `ExecutionTimelineComposer` 在非只读态把标题渲染成可点击 `<button>`，点击后才变成 input（`ExecutionTimelineComposer.tsx:103-145`）。视觉上与普通标题相同，用户很难发现可编辑；同时 blur 会自动提交本地 dirty，容易误触。

10. **P1：删除阶段是 inline 二次确认，且删除、门禁、输出检查并列，风险提示不足。** 阶段标题右侧直接出现垃圾桶图标，点击后在同一行显示确认（`ExecutionTimelineComposer.tsx:146-174`）。删除可能改变整个 workflow 的运行路径，应显示将受影响的 Change/引用，并把操作放入阶段菜单；当前确认只确认动作，不说明后果。

11. **P1：策略取消没有恢复 review budget，导致用户点“取消”后仍然脏。** `policyDirty` 明确比较 decomposition、interaction 和 reviewBudget（`WorkbenchView.tsx:216-221`），但 `cancelPolicyDraft` 只恢复 decomposition 与 interaction，没有恢复 `reviewBudget`（`WorkbenchView.tsx:300-310`）。修改“最大审阅次数”后点取消，dirty 状态仍可能保留，离开页面还会触发未保存提示。

12. **P2：工作流切换与全局未保存保护逻辑复杂，用户需要处理多层 Dialog。** 页面同时有本地 workflow switch confirm、治理 Dialog 内的 Loop/机器 draft guard、App 级 UnsavedDraftDialog（`WorkbenchView.tsx:312-323`；`WorkbenchGovernanceDialog.tsx:17-34`；`App.tsx:145-211`）。建议统一一个草稿模型：页面级只保护 workflow 编辑；治理设置在独立页面保存，不与工作流切换共享 dirty 状态。

13. **P2：工作台进入即触发多组请求，未按用户意图延迟加载。** `WorkbenchView` 在首屏初始化 workflow names、workflow definition、hooks、mandatory skills、recent history、loops、runtime rules 等（`WorkbenchView.tsx:72-118`、`WorkbenchView.tsx:124-205`、`WorkbenchSideRail.tsx:176-204`）。即使用户只想查看阶段，也会等待多个治理/机器数据；应首屏只加载 workflow definition，其他诊断和机器设置按展开时请求。

## 建议的收敛方案

- 一级导航保留“项目、进度、工作台”；AFK 降为进度页中的状态筛选/失败队列。
- 进度抽屉承载 AFK 的日志、重试、取消和人工接管；只在失败或运行中显示相关动作。
- 工作台首屏只做：选择 workflow、查看阶段、编辑阶段 prompt/技能、保存。
- Workflow policy、Loop 全量表单、运行时指纹、Hook/技能健康、AFK 并发与凭证放入“高级设置/机器”页面或治理 Dialog，默认折叠且按需请求。
- 删除定时任务、同步、triage、真实运行和提交等 Operations 工具的一级入口；保留 CLI/高级操作入口并明确风险。
- 所有列表筛选必须有无结果态；所有成功写操作都应刷新或更新本地状态；复制、加载失败必须给出可见反馈。
