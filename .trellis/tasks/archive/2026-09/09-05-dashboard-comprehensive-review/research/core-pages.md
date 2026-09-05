# Projects / Progress 核心页面评审

评审基线：Tenon Dashboard 的主任务是让用户快速回答「哪个项目需要我处理、当前处于什么状态、下一步是什么」，然后完成一次必要操作。评审依据为源码、组件测试和现有密度改造记录；本次没有把单元测试通过等同于视觉体验通过。

## Projects（项目总览）

### P1 — 项目选择路径泄漏 repository/workspace 内部模型

证据：`ProjectsView` 页头把摘要写成「{n} 个项目组 · {workspaces} 个 workspace · {need} 个需你动手」并直接以 `repositoryGroups` 数量填充 `n`（`packages/dashboard-app/src/shell/ProjectsView.tsx:250-257`；对应文案 `translations.ts:254`）。列表先按项目组渲染，再由 `ProjectsRepositoryGroup` 展开 workspace 行（`ProjectsRepositoryGroup.tsx:66-87`）。单 workspace 默认展开，多 workspace 默认折叠，用户点击项目需要先理解项目组和 workspace 两层。

影响：Tenon 的核心使用者要找的是可操作项目，而不是 Git repository 拓扑；worktree/primary 等宿主概念会增加认知负担，也造成「项目数」和实际可点击行数不一致。

建议：保留项目行和需处理排序；将 repository/workspace 合并信息移到项目详情或次要元数据。默认只展示「需处理」与「其余项目」两组平铺行；仅在检测到同一 repository 有多个 workspace 时，以一行可展开的“关联工作区”作为二级 disclosure。摘要改为「N 个项目 · M 个需处理」，不再在一级界面暴露 workspace 计数。

### P1 — 一级筛选过多，且 `unreachable` 属于治理清理而非日常工作

证据：工具条同时提供搜索和四个 radio：`全部 / 需要你动手 / 运行中 / 读不到`（`ProjectsFocusToolbar.tsx:61-130`）；不可达区还提供批量 `unregister` 按钮（`ProjectsUnreachableSection.tsx`，由 `ProjectsView.tsx:326-338` 挂载）。

影响：项目页顶部出现 5 个入口，用户需要先选择筛选语义再找项目；“读不到”是系统诊断状态，“批量注销”是注册表维护动作，两者会把异常治理噪声带入主路径。批量注销还会触发 `window.confirm`，误操作成本高。

建议：一级只保留搜索和一个「需要我处理」切换（默认开启或按计数自动聚焦）；运行中作为排序/摘要而非独立页签。不可达项目移到设置/诊断页，项目页只显示一个低干扰告警和「查看诊断」链接；注销改为单项目详情内的显式危险操作，批量清理从主导航移除。

### P2 — 过滤结果计数口径混合，容易造成数量误读

证据：`focusCounts.all` 为 `repositoryGroups.length + unreadable`，工具条 `shown` 却是 group 数加不可达行数；结果文案是「显示 {shown} / {total} 个项目」（`ProjectsView.tsx:174-201`、`ProjectsFocusToolbar.tsx:134-143`）。页头摘要的 `n` 又是 repository group 数（`ProjectsView.tsx:253-257`）。

影响：一个 repository 下的多个 workspace 在结果计数里算一组，在摘要里又单列 workspace；不可达项目默认折叠但会计入 All，用户看到的数字无法对应屏幕上的行。

建议：统一“项目”计数为可点击 workspace 行数，或统一为 repository 项目组；推荐前者，因为用户最终点击的是项目。异常数量单独显示为“另有 N 个无法读取”，不要混入 All 主计数。

### P2 — 空项目来源态缺少直接行动入口

证据：当 `rows.length === 0`，页面只渲染标题和说明（`ProjectsView.tsx:260-272`），说明建议「完成项目初始化或等待下一次快照」，但没有初始化/重试按钮。

影响：首次使用或服务尚未登记项目时，用户无法从当前页面继续，只能自行猜测下一步；这直接违背“下一步行动”基线。

建议：空态提供唯一主按钮「初始化项目」或「打开设置」，并提供次级重试；如果初始化由 CLI 完成，应给出可复制命令，但不要只写等待提示。

### P2 — 搜索只支持 basename/root，无法按 Change 或状态原因定位

证据：`projectMatchesQuery` 只检查 `basename`、`root`、`repositoryLabel`（`projectsFocusModel.ts:14-22`）。

影响：当用户记得任务名而不记得项目目录时，项目页无法帮助反查；用户只能切到进度页再找 Change。

建议：保持轻量搜索，但允许匹配项目内活跃 Change 名称和“失败/门/运行中”等状态关键词；结果仍按项目行聚合，不引入复杂筛选器。

## Progress（单项目进度）

### P0 — 工作流画布强制横向滚动，主界面无法快速读出下一步

证据：每个 workflow 都渲染完整阶段节点，即使阶段没有 Change（`WorkflowCanvas.tsx:229-253`）；track 的最小宽度为 `n * 232px`（`WorkflowCanvas.tsx:189-193`），7 阶段默认至少 1624px，外层仅提供 `overflow-x-auto`（`WorkflowCanvas.tsx:180-188`）。每个 workflow 又包在一张大卡中（`WorkflowCanvas.tsx:159-164`）。

影响：桌面窗口也需要拖动/滚动才能看到后续阶段；移动端更像一张需要探索的流程图，而不是工作队列。空阶段、连线和编号占据大量空间，却不能直接执行动作。

建议：一级视图改为按“需要处理 / 运行中 / 等待中”分组的紧凑任务列表，每行显示项目、Change、当前阶段、状态、下一动作。工作流全阶段轨下沉到 Change 抽屉；若保留阶段轨，只展示当前阶段前后 1–2 个节点，提供“查看完整流程”展开。

### P1 — 状态筛选采用“淡出并禁用”而不是移除，造成滚动噪声

证据：筛选后未命中卡仍渲染，并设置 `disabled`、`aria-hidden`、`opacity-30`（`WorkflowCanvas.tsx:258-270`）；测试明确验证“匹配 1 个 · 上下文 5 个”且上下文卡继续占位（`ProgressView.test.tsx:327-360`）。

影响：用户选择“运行中”后仍要经过 5 张不可交互卡；视觉上像系统故障或内容被遮蔽，且读屏用户与视觉用户获得不一致信息。筛选的预期是缩短工作面，不是保留画布结构。

建议：默认真正移除未命中 Change，只在一个可折叠的“显示完整流程”模式保留阶段上下文。摘要只报告匹配数量；不要把“上下文 N 个”作为一级文案。

### P1 — 每个 Change 都需要打开抽屉才能执行下一动作

证据：画布卡唯一交互是 `onOpen`，卡片底部重复显示“打开”（`WorkflowCanvas.tsx:258-286`）；动作全部由 `ProgressActions` 在 `ProgressDrawer` 中提供（`ProgressView.tsx:488-505`）。

影响：用户看到“可放行/失败/运行中”后，还要额外点击一次，再在抽屉里找按钮；处理多个 gate/failed 项时往返成本高。

建议：对低风险且语义明确的操作提供卡内主动作（例如“放行进入 X”“终止运行”），详情抽屉保留完整证据和替代出口。卡片只保留一个主动作，删除所有卡片上的泛化“打开”标签。

### P1 — 抽屉预装过多深层模块，详情页臃肿且加载链长

证据：`ProgressDrawer` 无条件把 `TaskPlanEvidenceSection`、`ReviewHandshakeStatus`、`ContextBundlePreview`、技术详情和阶段条件文档注入 `TaskDetail`（`ProgressDrawer.tsx:64-95`）；terminal 面又按条件挂 `RunLogPane`（`ProgressDrawer.tsx:96-101`）。运行测试时这些子树产生多条“update not wrapped in act”异步更新警告，涉及 `ContextBundlePreview`、`OrchestrationGraphCard`、`TaskPlanPanel`、`SkillInvocationEvidenceCard`、`TaskRunPanel` 等。

影响：用户只想确认状态时也会触发计划、编排、技能调用、会话和日志等数据加载；抽屉首屏慢，内容层级深，容易把“下一步”埋在证据中。测试警告也说明挂载副作用多、状态边界复杂。

建议：抽屉首屏只保留状态、当前阶段、下一动作和最小阻断原因；产出、复核、Context Bundle、编排、技能调用、历史、终端日志按 tab 进入时懒加载。将“终端”仅对 AFK running 行显示，将“历史”改为详情底部 disclosure。

### P1 — 四个固定详情 tab 对多数 Change 没有意义

证据：`ProgressDrawer` 固定渲染 `概览 / 产出 / 终端 / 记录` 四个 tab（`ProgressDrawer.tsx:39-43,103-117`），即使 Change 排队、等待产出或普通终端运行，tab 仍全部可见。

影响：固定导航制造“每项都有四类内容”的错觉，用户需要试错；终端和历史属于低频诊断能力，不应与概览平级。

建议：根据状态动态显示：默认只显示“概览”；有结构化产出时显示“产出”；AFK running 才显示“日志”；历史作为“更多详情”入口。不要为了统一而保留空 tab。

### P2 — workflow 下拉是实现概念，且与状态页签叠加

证据：当存在多个 workflow 时，工具条额外渲染 `全部工作流` 下拉（`ProgressToolbar.tsx:89-113`）；状态页签同时存在，筛选摘要还要解释“匹配/上下文”（`ProgressView.tsx:508-522`）。

影响：用户必须理解 workflow 与状态两个正交过滤维度；大多数单项目只有一个 workflow，却仍需看到额外控件（测试 fixture 中 default + release-train 即出现）。

建议：默认按当前项目自动聚合 workflow，不在主工具条显示下拉；高级用户在“视图选项”中筛选。若确实需要，改为卡片组内的轻量标签，而不是第二个全局控件。

### P2 — 归档入口把历史数据重新带回主流程

证据：每个有归档项的阶段显示“{n} 项已归档”并可展开只读名单（`WorkflowCanvas.tsx:292-307`），归档数据与当前阶段节点同屏。

影响：归档不是当前行动，却占用流程节点位置；当项目有大量历史 Change，主画布会不断出现历史折叠入口。

建议：归档移到项目/Change 的历史详情中；主画布只显示当前未归档 Change，必要时在页面底部提供一个总历史入口。

## 交互与验证备注

- Projects 和 Progress 现有单元测试均通过：ProjectsView 40 tests、ProgressView 66 tests（`npm run test:web -- --run ...`）。
- 测试通过主要证明状态和交互接线，不能证明信息密度、视觉层级或真实移动端可用性；Progress 测试执行期间出现多个子组件异步更新未包裹 `act` 的警告，支持“详情抽屉应延迟加载”的结论。
- 现有 Progress 密度改造记录已将“where/current/next”作为目标，但完整阶段画布、上下文保留和深层证据仍使主路径偏重；后续重设计应以任务列表为一级面、证据抽屉为二级面。
