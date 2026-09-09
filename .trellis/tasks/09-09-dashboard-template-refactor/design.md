# 技术设计

## 0. 页面语义（已与用户确认）

- **工作台** = 模板画出的三列阅读页：左列项目、中列任务、右列**该任务逐 stage 的执行状态与产出**。
- **工作流** = 整个工作流的定义编辑页（原「阶段」标签改名），只编辑定义，不显示任务状态。
- 自动化 / 机器沿用各自领域。

## 1. 导航映射

| 模板标签 | 承载内容 | 现状来源 | 处置 |
| --- | --- | --- | --- |
| 工作台 | 三列工作空间阅读页 | `shell/ProjectsView` + `progress/ProgressView` | 全新实现，吃掉两者 |
| 工作流 | 工作流 / 轨道 / 管线 / 阶段 / 技能顺序的定义编辑（保留 CRUD） | `workbench/WorkbenchView` 一系 | 复用领域逻辑，版式重设计 |
| 自动化 | AFK 自动运行 | `afk/AfkView` | 复用领域逻辑，版式重设计 |
| 机器 | 机器 / 宿主目标 / 适配器安装 | `machine/MachineView` + `hostPlan/HostTargetPlanView` | 合并为一页，版式重设计 |

`shell/Nav.tsx` 的 88px 竖排 rail、`PRIMARY_VIEWS` / `SECONDARY_VIEWS` 概念、
`overview` 视图一并下线，改由顶部条 `shell/TopBar.tsx` 承担。视图记忆键 `tenon-dashboard-view`
的白名单同步换成 `workspace | workflow | automation | machines`，旧值兜底回 `workspace`。

### 1.1 工作流页的领域对象与可编辑边界

| 对象 | 来源类型 | 可编辑 | 说明 |
| --- | --- | --- | --- |
| 工作流 | `WbWorkflowDef` / `DefinitionCatalogWorkflow` | 是（builtin 只读） | name、steps 顺序、策略 |
| 阶段 | `WbStepDef` | 是 | label、gate（review/confirm/null）、guards、skills |
| 技能顺序 | `WbSkillRef.depends_on` → `skillExecutionWaves` | 是 | 同波并行、波间串行；界面只操作依赖，不手写波次 |
| 输入 / 产出 | `WbStepDef.inputs/outputs` + `artifacts.producerPolicy` | **否，推导展示** | 输入 = 上游阶段 outputs 中被本阶段引用的字段；产出 = 本阶段技能按 `effective-phase-skills` 登记的字段 |
| 轨道 | `WbTrackDefinition` | 是 | 默认 / 允许工作流、路由匹配、策略档 |
| 管线 | `DefinitionCatalogPipeline` | **否，只读** | 工作流 × 轨道编译结果，每 stage 带 `mode: serial\|parallel` |

## 2. 设计 token（从模板逐项提取，写进 `index.css` 的 `@theme`）

### 表面
| token | 值 | 用途 |
| --- | --- | --- |
| `--surface-app` | `#F5F5F1` | 左列 / 页面底 |
| `--surface-card` | `#FFFFFF` | 中列、卡片 |
| `--surface-detail` | `#FAFAF8` | 右列详情底 |
| `--surface-fill` | `#F0F0EB` | hover / 次级填充 |
| `--border` | `#E6E6E1` | 常规边框、列分隔 |
| `--border-subtle` | `#EFEFEA` | 卡内分隔线 |

### 文字
`--text` `#1A1A17` / `--text-2` `#6B6B63` / `--text-3` `#9A9A91` / `--text-mono` 等宽用于 slug 与文件名。

### 品牌绿
`--brand` `#205238`（eyebrow、选中项目名、「可读」、「查看全部」、tab 下划线）、
`--brand-fill` `#EBF2EC`、`--brand-border` `#C9DECF`、`--brand-avatar` `#2E6B4A`、
`--ink` `#1B1B18`（logo 方块）。

### 状态（pill = 圆点 + 文字 + 浅底）
| 状态 | 文字 | 底 | 圆点 |
| --- | --- | --- | --- |
| 待决定 / 待复核 | `#9A6212` | `#FBF0DC` | `#D89A20` |
| 进行中 | `#2B5B93` | `#E4EDF7` | `#3C7CC4` |
| 已完成 | `#2A6B45` | `#E4F0E7` | `#3E8C5C` |
| 受阻 | `#A33A32` | `#FAE5E2` | `#C9503F` |

### 阶段轨
已完成段 `#2A6B45`、当前段 `#B26A18`、未开始段 `#E2E6E1`；段高 4px、圆角 2px、间距 8px；
当前段标签用当前段色 + 600 字重，其余 `--text-2`。

### 字阶（1440 逻辑视口）
详情 H1 40/700 · 中列 H1 34/700 · H2 20/700 · 卡片标题 16/600 · 正文 14/400 ·
meta 13/400 · eyebrow 12/600 大写 letter-spacing .08em · micro 11/500。

### 尺寸
圆角 6 / 8 / 10 / 12 / 999；间距刻度 4·8·12·16·20·24·32·40；
顶部条高 68px；左列 296px（折叠 64px）；中列 480px；右列 `flex:1` 最小 520px。
阴影只在浮层使用，卡片一律靠边框与底色分层。

## 2.1 右列 sheet 规则（用户 2026-09-09 要求）

右列不再纵向堆叠全部内容。右列固定头部 = eyebrow / H1 / slug / 状态行 /（工作台）阶段轨，
其下是一组 **sheet 页签**（`subtabs` 语汇，URL `?sheet=` 记忆），一次只显示一个 sheet：

| 页面 · 右列对象 | sheet |
| --- | --- |
| 工作台 · 任务 | 阶段执行 · 技能 · 文件 · 计划 |
| 工作流 · 阶段 | 技能顺序 · 输入产出 · 门禁守卫 |
| 工作流 · 轨道 | 绑定 · 管线 |
| 自动化 · 运行 | 概览 · 处置 · 日志 |
| 机器 · 适配器 | 安装计划 · 收据 |

sheet 切换不请求新数据源以外的东西；每个 sheet 自带空态。

## 3. 组件拆分

```
shell/
  TopBar.tsx            顶部横条：面包屑 / 项目切换器 / 标签 / 搜索 / 只读 pill / 连接 / 头像
  CommandSearch.tsx     `/` 聚焦的全局搜索，跨项目与任务
workspace/                        ← 新目录，承载「工作台」三列页
  WorkspaceView.tsx     三列栅格装配 + 选中态路由同步
  ProjectRail.tsx       左列项目选择（可折叠，底部「所有项目 / 设置」）
  ProjectCard.tsx
  TaskListPane.tsx      中列：eyebrow / H1 / 筛选说明 / 搜索 / 状态页签 / 任务卡列表
  TaskCard.tsx
  TaskDetailPane.tsx    右列：固定头部 + sheet 页签（阶段执行 / 技能 / 文件 / 计划）+ 底部动作
  DetailSheets.tsx      通用 sheet 页签容器（四个页面共用）
  PhaseRail.tsx         六段阶段轨（与 StageExecutionList 同源，点击可选中阶段）
  StageExecutionList.tsx  逐 stage：状态 pill、技能调用摘要、产出登记摘要
  SkillWaves.tsx        技能执行波次（工作台只读 / 工作流页可编辑，同一组件两种模式）
  FileWorkbench.tsx     选中阶段的输入 / 产出 tab + 文件行（已登记 / 缺失 / 过期）
  FilePreviewCard.tsx   markdown 预览卡
workflow/                         ← 新目录，承载「工作流」定义编辑页
  WorkflowView.tsx      左列工作流 + 轨道两组 / 中列阶段列表 / 右列阶段编辑或轨道面板
  StageEditor.tsx       技能波次编辑 + 推导的输入产出（只读） + 门禁守卫
  DerivedIoPanel.tsx    由 inputs/outputs/artifacts 推导的输入产出展示
  TrackPanel.tsx        轨道绑定表单 + 管线编译结果（只读）
```

阶段 / 自动化 / 机器三页复用上述 token 与 `TopBar`，各自重写版式外壳，
领域逻辑（`workbench/*` 的 hooks 与 model、`afk/*`、`machine/*`）原样保留。

## 4. 数据接线

- 项目列与计数：`useSnapshot()` → `shell/projectsModel`。
- 任务列表与状态分类：`model/progressModel.selectProgress` → 现有 `FlatRow`，
  状态映射为模板五类（全部 / 需要你 / 进行中 / 待复核 / 已完成）。
  「需要你 = 待决定 / 受阻」即现有 `deckMatch(fr,'need')` 口径。
- 阶段轨：`api/contextBundleTypes.CONTEXT_BUNDLE_PHASES`（open/explore/spec/build/verify/ship）
  ↔ 立项/调研/规格/实现/验证/交付。
- 文件工作台：`api/contextBundleClient` 的 preview（kind / path / digest / mode /
  sourceBytes），可读 = 有 digest 且 mode ≠ reference；缺失 = 契约标记缺失。
- 「下一步」文案：沿用现有 rowSemantics 的判定文案，不新造语义。
- 阶段执行列表：`ChangeSnapshot.todo.stages[]`（done / current / pending）+ `phase_status` +
  `workflowExecution.readinessByTransition`（阻塞原因）+ `workflowRules.gateByStep`。
- 技能调用结果：`api/skillInvocationClient` 的 `SkillInvocationReadItem`（按 `subject.step_id` 分组，
  status / started_at / output.fields / artifacts.validators）。
- 产出登记状态：`ChangeSnapshot.documents.items[]`（kind / status recorded·missing·stale·unread /
  producers / paths）；缺失与过期都要显式呈现。
- 工作流页的推导输入产出：`WbStepDef.inputs`、`outputs`、`artifacts[].producerPolicy`、
  `WorkflowRulesSnapshot.outputsByStep`；技能波次用现有 `skillExecutionWaves`。
- 轨道与管线：`WbTrackDefinition`、`DefinitionCatalogTrack`、`DefinitionCatalogPipeline`。

## 5. 迁移与删除

新增外壳与三列页先落地并接真实数据，随后删除：`shell/Nav.tsx`、`shell/ProjectsView.tsx`、
`progress/ProgressView.tsx` 及其 `WorkflowCanvas` / `ProgressDrawer` / `ProgressToolbar`
一系，以及仅服务旧 rail 的测试。删除在同一分支内完成，不留兼容开关。

## 6. 风险

- 中列任务卡的「阶段」与右列阶段轨口径必须同源，否则同一任务两处显示不一致——
  统一走一个 `taskPhase` 选择器。
- 文件工作台依赖 contextBundlePreview，若某任务无 bundle 需要明确空态而非空白。
- 阶段页 CRUD 的脏态拦截（`useWorkbenchDirtyState` + 导航拦截）在换外壳时容易断，
  需要单独回归。
