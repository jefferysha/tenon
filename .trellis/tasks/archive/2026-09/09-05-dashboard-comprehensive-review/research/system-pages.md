# 系统级页面与外壳评审（Machine / Host Plan / Overview / Settings / 跨页）

## 评审基线

Tenon 的 Dashboard 是本地优先的 coding-agent 工作流控制面。高频任务是选择项目、查看当前流程、处理待决策项、推进下一步；安装、宿主适配、凭证和机器诊断属于低频支持能力。评审以“项目 → 当前进度 → 下一步行动”为主路径，按用户是否能在当前上下文完成动作、是否重复、是否需要高级知识判断保留级别。

本次证据来自源码、已有组件测试和仓库产品文档；未启动生产 Dashboard/浏览器，因此没有把未实测的像素或网络行为写成已验证事实。

## P0 / P1 问题

### P0-1：只读“宿主计划”页同时包含真实安装写操作，产品承诺矛盾

- 证据：`HostTargetPlanView` 在宿主计划工作区后无条件挂载 `AdapterInstallWizard`（`packages/dashboard-app/src/hostPlan/HostTargetPlanView.tsx:331-333`）。
- `AdapterInstallWizard` 提供 `postAdapterInstall({ ..., dry_run: false, confirm: true })`，并渲染“安装”按钮（`packages/dashboard-app/src/hostPlan/AdapterInstallWizard.tsx:55-74,112-119`）。
- README 对宿主计划的定位是“只读预览 setup/update，只提供复制，不执行命令”（`README.md:53-54`）。
- 影响：用户从“计划/预览”入口进入，可能在同一屏触发项目 adapter 安装；页面的安全心智和实际副作用不一致，尤其对首次用户是高风险误操作路径。
- 建议：从 Host Plan 页面移除安装向导；若必须保留，移到明确命名的“项目安装”页面/步骤，使用单独的写操作确认、目标项目摘要和结果区，并把 Host Plan 保持为纯只读。
- 级别：**P0（上线前必须拆开）**。

### P1-1：一级导航把低频机器能力与日常工作流等权展示，造成 IA 臃肿

- 证据：`PRIMARY_VIEWS` 固定暴露 projects、progress、afk、workbench、machine、hostPlan 六个按钮（`packages/dashboard-app/src/shell/Nav.tsx:22-24,115-154`）。Machine 和 Host Plan 与 Progress/AFK 使用相同视觉权重和激活态。
- 产品文档把 Machine 定义为“机器诊断”、Host Plan 定义为宿主安装计划支持能力（`README.md:224,53-54`），不是每次工作都需要的操作面。
- 影响：用户必须理解六个概念才能找到“现在该做什么”；两个低频入口持续占据桌面 rail 和移动底栏，降低核心任务的信噪比。
- 建议：一级只保留“项目 / 进度 / 自动运行 / 工作台”；将 Machine 与 Host Plan 合并为“设置与诊断”二级入口，或仅在检测到阻断时从相关卡片提供上下文链接。移动端同样不要把二者固定在底栏。
- 级别：**P1（首轮 IA 重构）**。

### P1-2：Overview 是长篇品牌/文档页，却从所有工作流可达并占据品牌按钮

- 证据：品牌按钮 `nav-overview` 点击后直接切换 `view='overview'`（`Nav.tsx:98-108`）；`SolutionView` 单页包含 hero、trust、modes、workflow、evidence、modules、install、safety、community 共九段，容器使用 `space-y-20`（`packages/dashboard-app/src/solution/SolutionView.tsx:54-59,110-120,145-...`）。内容主要是外部 docs/repo 链接和安装说明（`SolutionView.tsx:73-106`）。
- 影响：工作用户点击左上角品牌会离开当前操作上下文，进入需大量滚动的营销/文档内容；页面没有项目状态、待办或下一步，和控制面定位不一致。
- 建议：把完整 SolutionView 移到“帮助 / 关于 / 首次使用”路由；品牌按钮回到当前项目 Progress 或仅打开短版帮助弹层。若保留 Overview，限制为 1 屏产品定位 + 进入项目按钮，不在主工作流中占一个可激活页面。
- 级别：**P1**。

### P1-3：Machine 首屏聚合过多机器事实与调试工具，且每次进入并行读取五个端点

- 证据：进入 Machine 时同时调用 readiness、Docker images、secrets、skills registry、loops snapshot（`packages/dashboard-app/src/machine/MachineView.tsx:189-220`），首屏固定渲染 core readiness、AFK readiness、blockers、risk queue 以及折叠的 `AdvancedPanel`（`MachineView.tsx:319-407`）。AdvancedPanel 还承载 traffic/runtime 调试工具（`packages/dashboard-app/src/advanced/AdvancedPanel.tsx:1-58`）。
- 影响：大多数用户只想知道“能否继续当前操作”，却先面对凭证来源、镜像数、技能注册表、全局 loop 风险和调试面板；请求慢时大量 unknown 状态制造焦虑，也增加本地服务负载。
- 建议：默认只显示与当前动作有关的一个 readiness 摘要（可继续/被什么阻断/下一步）；按需展开才读取 secrets、Docker、loops 和 traffic。把 AdvancedPanel 放到独立诊断抽屉，避免与机器状态同层。
- 级别：**P1**。

### P1-4：Machine 的全局风险队列与项目进度/AFK 徽标重复，动作闭环弱

- 证据：`machineRisks` 遍历所有项目 changes 和所有 loops，生成跨项目风险列表（`MachineView.tsx:157-185`）；每行只有“打开项目”，点击统一跳转 Progress（`MachineView.tsx:383-397`）。导航同时对 Progress 和 AFK 显示待处理徽标（`Nav.tsx:133-150`）。
- 影响：同一个 failed/conflict 可能同时出现在 Machine 风险、AFK 徽标和 Progress 详情中；Machine 页面变成重复告警列表，用户仍需二次定位真正动作。
- 建议：Machine 只显示影响“当前动作”的阻断；跨项目问题收敛为计数 + 项目列表链接，并把修复入口直接指向对应 Change/AFK 操作，而不是泛化到 Progress 根页。
- 级别：**P1**。

### P1-5：Host Plan 一屏列出 12 个宿主目标，选择成本高且把检测结果降为文本

- 证据：Host target 常量包含 codex、claude、cursor、gemini、copilot、pi、devin、zed、aider、continue、cline、amp（`HostTargetPlanView.tsx:40-53`）；目录返回的每个 target 都渲染为卡片，并同时显示 kind、scope、detected 和 capabilities chips（`HostTargetPlanView.tsx:267-316`）。检测建议仅在顶部状态条中呈现，仍需要手动在卡片列表选择操作（`HostTargetPlanView.tsx:235-259,204-213`）。
- 影响：首次安装者通常只需要一个宿主，却被迫扫描完整矩阵；移动端卡片纵向滚动，核心命令预览被推到很深位置。
- 建议：默认突出 detected/recommended 的一个目标和 setup/update 主 CTA；其余宿主折叠到“选择其他宿主”对话框。把“为什么推荐”和副作用边界紧邻 CTA 展示。
- 级别：**P1**。

## P2 问题与细节

### P2-1：Host Plan 自动拉取推荐计划，导致隐性网络等待

`useEffect` 在 catalog 与 detection 就绪且未选择 host 时自动调用 `requestPlan`（`HostTargetPlanView.tsx:204-213`）。这保证推荐可见，但用户尚未确认目标就触发计划请求；建议改为显式“查看推荐计划”按钮，或在推荐卡片内懒加载，减少无意等待。

### P2-2：Host Plan 将机器级宿主选择与项目级 Adapter 安装混在同一页

Host Plan 使用 `root` 作为 AdapterInstallWizard 的目标（`HostTargetPlanView.tsx:91-97,331-333`），而宿主 catalog/detection 是机器级全局事实。用户在同一页同时看到“我本机有哪些宿主”和“给当前项目安装 adapter”，层级不一致。建议拆成机器级设置与项目级初始化两个上下文，并在项目页/Workbench 提供后者入口。

### P2-3：Settings 是无独立页面的锚定浮层，发现性与关闭行为不足

设置按钮仅通过 `aria-haspopup="dialog"` 打开 `aria-modal="false"` 的 section（`Nav.tsx:159-181`），内容只有主题、语言和连接状态（`Nav.tsx:183-214`）。实现了 Escape 关闭并把焦点还给触发器（`Nav.tsx:65-82`），但没有点击外部关闭、显式关闭按钮或 `aria-controls` 关联。建议保留轻量浮层，但增加关闭按钮/外部点击关闭和稳定标题关联；若未来加入机器/宿主设置，应升级为独立设置页而非继续堆进浮层。

### P2-4：跨页 Breadcrumb 对机器级页面仍暗示项目层级

`PageBreadcrumbs` 默认生成 Home > Projects，并在存在 `projectName` 时追加项目名（`packages/dashboard-app/src/shell/PageBreadcrumbs.tsx:19-35`）；App 对 Machine/Host Plan 也传入当前项目名（`App.tsx:373-378`）。Machine 虽可显示跨项目风险，Host Plan 更是机器级页面，项目面包屑会误导用户当前页面的作用域。建议为 machine/hostPlan 使用独立作用域面包屑（Home > Settings/Diagnostics），仅在明确使用项目级 adapter 时显示项目名。

### P2-5：Adapter installer 的可访问名称未本地化

`AdapterInstallWizard` 使用硬编码 `aria-label="Adapter installer"`（`AdapterInstallWizard.tsx:112-114`），中文界面屏幕阅读器会读英文，违反现有双语 UI 约定。应改为 `t('hostPlan.installer.aria_label')`。

### P2-6：Overview 外链行为不一致

Docs CTA 带外链箭头，Repo CTA 没有（`SolutionView.tsx:73-91`）；所有链接 `target="_blank"`。建议统一显示外链标记，并在可访问名称中说明“在新窗口打开”。

## 建议的系统级收敛顺序

1. **先拆安全边界**：移除 Host Plan 中的 AdapterInstallWizard，单独设计项目 adapter 安装流程（P0-1）。
2. **收敛一级导航**：Projects / Progress / AFK / Workbench 四项；Machine 与 Host Plan 进入 Settings/Diagnostics 二级（P1-1）。
3. **缩短 Overview**：从工作流导航移到 Help/About 或仅保留首次使用短版（P1-2）。
4. **Machine 默认轻量化**：当前任务相关 readiness + 直接修复动作；诊断、全局风险和调试端点按需加载（P1-3/P1-4）。
5. **Host Plan 推荐优先**：默认一个 detected/recommended host + setup/update 主动作，其余目标放入“更多宿主”（P1-5）。
6. **补跨页细节**：settings 浮层关闭与焦点、scope-aware breadcrumbs、i18n label 和外链可访问名称（P2）。

## 评审实施提示

现有 `Nav.test.tsx` 将“一级导航恰 6 个按钮”以及 Machine/Host Plan 作为一级入口写死（`packages/dashboard-app/src/shell/Nav.test.tsx:31-85`）。这属于当前实现的回归契约，不是产品定位证据；若采纳 IA 收敛方案，需要同步重写这些测试，避免测试继续锁定臃肿导航。
