# Dashboard 系统性 UI / UX / 功能评审报告

## 结论

当前 Dashboard 更像把 CLI、治理后台、自动化运维、机器诊断、宿主安装和产品文档堆在同一个控制面，而不是围绕 coding-agent 操作者的日常任务组织界面。产品定位要求用户快速回答“哪个项目需要我、卡在哪里、下一步能做什么”；当前主路径被过多入口、重复状态、内部术语和长配置表单打断。

建议先完成安全边界和信息架构收敛，再做视觉重设计。优先级最高的动作是：拆出宿主安装写操作、把进度改成紧凑任务队列、把工作台缩成流程编辑主面板、将 AFK/机器/宿主计划/诊断降级为上下文能力。

## 产品评估基线

Tenon Dashboard 是本地优先的 coding-agent 工作流控制面，不取代 CLI 的 canonical 状态操作，也不是公共文档站。评估每项能力时使用五个问题：

1. 是否直接帮助用户完成当前核心任务？
2. 是否有明确且高频的用户？
3. 是否与已有入口重复？
4. 是否应该在当前上下文出现？
5. 下沉或移除后是否影响安全或正确性？

## P0：上线前必须处理

| 页面 / 功能 | 问题与证据 | 影响 | 建议 |
|---|---|---|---|
| 宿主计划 / Adapter installer | `HostTargetPlanView` 无条件挂载 `AdapterInstallWizard`（`packages/dashboard-app/src/hostPlan/HostTargetPlanView.tsx:331-333`）；向导会调用 `postAdapterInstall({dry_run:false, confirm:true})` 并显示“安装”（`AdapterInstallWizard.tsx:55-74,112-119`）。README 却声明宿主计划只读预览。 | 用户从“计划/预览”入口可触发项目写操作，安全心智和实际副作用矛盾。 | 从 Host Plan 移除安装向导；另设明确的项目适配器安装流程，显示目标项目、写入范围、确认和结果。Host Plan 保持纯只读。 |
| 进度 / Workflow canvas | 完整七阶段按 `n * 232px` 强制横向滚动（`WorkflowCanvas.tsx:180-193`），空阶段和连线仍占位。 | 桌面和移动端都不能快速读出下一步，主工作面像探索图而不是任务队列。 | 一级改为“需处理 / 运行中 / 等待中”的紧凑任务列表；完整流程放入 Change 详情。 |
| 工作台 / 首屏编辑器 | Header、策略编辑、运行时摘要、阶段编排同时挂载（`WorkbenchView.tsx:492-540`），混合流程编辑、治理、诊断和运行事实。 | 用户不知道先改什么；默认 Workflow 只读却暴露大量内部模型。 | 首屏只保留 Workflow 选择、阶段列表、阶段基本编辑和保存；其余进入高级设置或详情。 |

## P1：首轮信息架构和交互重构

### 项目页

- **repository/workspace 层级泄漏**（`ProjectsView.tsx:250-257`、`ProjectsRepositoryGroup.tsx:66-87`）：用户要找可操作项目，却先理解 Git 拓扑。建议平铺项目行，关联 workspace 作为二级展开。
- **筛选和治理混在一起**（`ProjectsFocusToolbar.tsx:61-130`、`ProjectsUnreachableSection.tsx`）：`全部/需处理/运行中/读不到` 加批量 unregister 让异常清理进入主路径。建议一级只保留搜索和“需要我处理”，不可达与注销移到诊断。
- **计数口径混合**（`ProjectsView.tsx:174-201`）：repository group、workspace 和不可达行混算。建议统一按可点击项目行计数，异常单独计数。
- **核心动作缺失**（`ProjectsView.tsx:260-272`）：零项目时只有说明没有初始化/重试 CTA。建议提供唯一主动作和可复制命令。

### 进度页

- **筛选不真正减负**（`WorkflowCanvas.tsx:258-270`）：未命中卡淡出、禁用、保留占位。建议移除未命中项，仅提供“显示完整流程”次级入口。
- **下一步藏在抽屉里**（`ProgressView.tsx:488-505`、`ProgressDrawer.tsx`）：卡片只有“打开”，用户还要进入抽屉找动作。建议对明确低风险动作提供卡内主按钮。
- **抽屉过重且预装深层模块**（`ProgressDrawer.tsx:64-101`）：TaskPlan、ReviewHandshake、ContextBundle、编排图、技能调用和日志在详情层组合挂载；测试出现多条异步 `act` 警告。建议按 tab 进入时懒加载，首屏只显示状态、阻断原因和下一动作。
- **四个固定 tab 造成空内容错觉**（`ProgressDrawer.tsx:39-43,103-117`）：概览/产出/终端/记录对多数 Change 并不都适用。建议按状态和数据动态显示。
- **归档回到主流程**（`WorkflowCanvas.tsx:292-307`）：历史数据占用当前阶段空间。建议移入历史详情。
- **运行时重复 key**：本地 Vite 运行进度页时，`WorkflowCanvas` 对 `/Users/a1234/Documents/code-manager/projects/tenon-local::default` 产生重复 React key 警告。应修复 key 生成并补真实浏览器回归。

### AFK / 自动运行页

- **与进度页重复**（`AfkView.tsx:102-116`）：AFK 只筛选 automation 状态，而进度已经展示状态、日志和终止/重跑。建议降为进度页筛选和详情能力。
- **创建入口重复**（`AfkView.tsx:314-323,476-489`）：Header“新建运行”和底部 enqueue/starter/run 工具栏并存。建议只保留“运行此 Change”，定时任务和验证进入高级操作。
- **MiniTrack 与详情流水线重复**（`AfkView.tsx:388-395,427-449`）：队列行删除装饰性小轨道，详情保留完整阶段轨。
- **搜索无结果仍显示旧详情**（`AfkView.tsx:267-274`）：`selected` 从 `priorityRows` 取值而不是 visibleRows。建议无匹配时显示明确空态并清除选择。
- **成功只 toast 不刷新**（`AfkView.tsx:228-252`）：入队/重试后断线或 SSE 延迟时旧状态仍在。建议刷新 snapshot 或更新本地行。
- **移动端二次横滚**：详情阶段轨固定 `min-w-[560px]`（`AfkView.tsx:429-430`），与底部导航叠加。建议移动端只显示当前阶段，完整轨道折叠。

### 工作台

- **策略编辑过度暴露**（`WorkflowPolicyEditor.tsx:130-270`）：拆分、互动、条件、Review 上限等约 15 个控件默认展开。建议折叠为高级策略，只显示摘要。
- **运行时摘要位置错误**（`WorkflowPolicyRuntimeSummary.tsx:240-320`）：自动选择最近 Change，用户容易把 Change 事实误认为 Workflow 全局事实。建议移入治理详情并要求显式选择 Change。
- **多设置中心**（`WorkbenchSideRail.tsx:140-205`、`WorkbenchGovernanceDialog.tsx:35-64`）：治理、Loop、机器配置、凭证、技能健康重复出现。建议机器设置独立，工作台只保留流程相关编辑。
- **拖拽与箭头重复**（`ExecutionTimelineComposer.tsx:245-320`、`TimelineStageStrip.tsx:37-121`）：触控和键盘成本高。建议默认键盘/菜单排序，拖拽作为桌面增强。
- **阶段标题可编辑但无提示**（`ExecutionTimelineComposer.tsx:103-145`）：点击标题才变 input，发现性差；建议显式编辑动作。
- **删除阶段风险说明不足**（`ExecutionTimelineComposer.tsx:146-174`）：可能改变整个 Workflow 路径，当前 inline 确认不展示受影响 Change/引用。建议移入阶段菜单并展示影响。
- **取消策略未恢复 Review budget**（`WorkbenchView.tsx:216-221,300-310`）：取消最大审阅次数后仍可能保持 dirty，导致错误的未保存提示。应补齐草稿回滚。

### Machine / 机器页

- **首屏聚合五个端点和调试面**（`MachineView.tsx:189-220,319-407`）：凭证、技能、Docker、Loops、Advanced traffic/runtime 同层呈现。建议默认只显示当前动作相关 readiness，其他按需加载。
- **全局风险与进度/AFK 重复**（`MachineView.tsx:157-185,383-397`）：同一失败可能出现三处，动作只泛化跳回 Progress。建议按当前项目阻断聚合，跨项目风险只显示计数并直达具体 Change。

### Host Plan / 宿主计划

- **12 个宿主等权展示**（`HostTargetPlanView.tsx:40-53,267-316`）：首次用户通常只需要一个宿主，却要扫描完整矩阵。建议突出 detected/recommended 一个目标，其余折叠到“选择其他宿主”。
- **机器级检测和项目级安装混在一页**（`HostTargetPlanView.tsx:91-97,331-333`）：作用域不一致。建议机器级计划与项目适配器安装拆开。

## P1：跨页 IA

建议一级入口收敛为：

1. 项目
2. 进度
3. 工作台

AFK 作为进度筛选/详情状态；Machine、Host Plan、Advanced、Traffic、Loop、凭证和安装进入设置/诊断二级。Overview 移到帮助/关于/首次使用，品牌按钮回到当前工作上下文。

## P2：细节和可访问性

- Settings 浮层缺少外部点击关闭、显式关闭按钮和稳定 `aria-controls`；保留轻量浮层但补齐关闭与焦点语义。
- Machine/Host Plan 使用项目名面包屑会误导作用域；改为 Settings/Diagnostics 作用域。
- `AdapterInstallWizard` 的 `aria-label="Adapter installer"` 未本地化。
- Overview 外链标识不一致，统一外链图标和“新窗口打开”可访问名称。
- AFK 复制命令缺少失败反馈；设置读取失败静默；成功写操作缺少刷新反馈。
- 测试将六项一级导航写死（`Nav.test.tsx:31-85`），IA 收敛时需同步重写测试；该测试不是保留六项入口的产品证据。

## 响应式与运行态证据

本地 Vite 运行态检查：

| 页面 | 1440px 高度 | 375px 高度 | 观察 |
|---|---:|---:|---|
| Progress | 1,444px | 1,594px | 完整阶段轨和详情内容偏长 |
| Workbench | 3,575px | 6,605px | 配置与诊断全部堆叠，移动端极度纵长 |
| Host Plan | 2,492px | 4,708px | 12 宿主 + 计划步骤纵向堆叠 |
| Overview | 4,400px | 9,113px | 九段产品说明不适合日常控制面 |
| Machine | 约 1,228px | 1,153px | 可收敛为按需诊断 |
| AFK 空队列 | 约 900px | 约 900px | 空态只剩三个工具动作 |

所有断点未发现水平溢出；这不代表信息密度、焦点顺序和可操作性已通过。Vite 开发环境还观察到：

- `WorkflowCanvas` 重复 React key 警告。
- `/api/orchestration/changes/dashboard-ui-reimplementation?...` 返回 404；server 源码存在对应 V2 路由，因此暂列为开发代理/运行环境问题，需在同源生产 server 复验。
- `npm run test:web`：102 个文件、1,761 个测试通过，但出现多条异步 `act` 警告；这是组件测试证据，不等于视觉或真实浏览器通过。

## 精简后的目标用户路径

```text
项目总览 → 需处理 Change 列表 → 详情中的下一动作 → 必要证据 / 日志 → 完成或恢复
```

工作台只服务“编辑流程结构”；安装、机器和高级治理只在具体阻断或明确设置入口出现。用户不应为了完成一次普通 Change 而理解 AFK、Loop、Track、宿主矩阵、机器 readiness 和证据图的全部模型。

## 建议实施顺序

1. **安全边界**：拆出 Host Plan 安装写操作。
2. **核心交付**：重做 Progress 为紧凑任务队列，修复重复 key 和详情懒加载。
3. **导航收敛**：Projects / Progress / Workbench 一级；AFK 降级为进度上下文。
4. **工作台减负**：默认只显示流程编辑，高级策略、治理和运行摘要按需打开。
5. **支持能力下沉**：Machine、Host Plan、Advanced、Traffic、凭证进入 Settings/Diagnostics。
6. **细节修复**：搜索无结果、写后刷新、空态 CTA、scope-aware breadcrumbs、键盘/焦点和 i18n。
7. **视觉重做**：最后统一布局、类型层级、状态色和动效，避免在错误 IA 上继续抛光。

## 验收标准

- 任何普通 Change 的核心任务可在项目 → 进度 → 详情三步内完成。
- 一级导航不超过三项日常工作入口；低频能力有明确二级归属。
- 宿主计划页面纯只读；安装操作在明确的项目安装流程中完成。
- Progress 首屏不需要横向滚动即可看到当前 Change 与下一动作。
- Workbench 首屏只显示流程编辑，其他配置按需加载。
- 搜索、筛选、空态、失败、写后刷新和未保存保护均有明确反馈。
- 375px、768px、1440px 下核心动作可见、可聚焦、无水平溢出。
- 运行态无重复 key、资源 404 和未解释的控制台错误；开发代理问题与生产运行问题分开验证。
