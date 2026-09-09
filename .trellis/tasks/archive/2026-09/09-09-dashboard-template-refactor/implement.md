# 执行计划

每一步结束跑 `npm run typecheck:web`；涉及组件的步骤补/改测试后跑
`npm run test:web -- <相关文件>`。全量校验放在 M4。

## M0 · 视觉对齐（评审门，先于任何 React 改动）

- [x] 在 `prototype/` 下产出静态 HTML 原型，含四页：
      工作台（按模板复刻，右列为逐 stage 执行状态与产出）、工作流（定义编辑，含轨道/管线面板）、自动化、机器
- [x] token 全部走 CSS 变量，与 design.md §2 表格逐项对齐
- [x] **评审门**：用户确认工作台还原度 + 后三页设计方向后才进 M1

## M1 · 外壳换骨

- [x] `index.css` 落 design.md §2 的 `@theme` token（保留深色主题映射）
- [x] 新建 `shell/TopBar.tsx`：面包屑 / 项目切换器 / 四标签 / 搜索 / 只读 pill / 连接 / 头像
- [x] `shell/CommandSearch.tsx`：`/` 聚焦，Esc 退出，跨项目与任务
- [x] `App.tsx` 换布局：顶部条 + 内容区；`View` 类型换为
      `workspace | workflow | automation | machines`，视图记忆白名单同步
- [x] 旧值兜底：localStorage 里任何旧 view 值一律回落 `workspace`
- [x] 校验：`npm run typecheck:web`

## M2 · 工作台三列页

- [x] `workspace/ProjectRail.tsx` + `ProjectCard.tsx`（折叠态、底部两入口）
- [x] `workspace/TaskListPane.tsx` + `TaskCard.tsx`：五类页签接 `deckMatch` 口径，
      任务搜索按标题与 slug 过滤
- [x] `workspace/PhaseRail.tsx` + `StageExecutionList.tsx`：接 `todo.stages` / `phase_status` /
      `readinessByTransition` / `gateByStep`，两者共用一个阶段状态选择器
- [x] `workspace/SkillWaves.tsx`（只读模式）：按 `step_id` 分组的 `SkillInvocationReadItem`
      映射到 `skillExecutionWaves` 波次上
- [x] `workspace/FileWorkbench.tsx` + `FilePreviewCard.tsx`：输入接 contextBundleClient，
      产出接 `documents.items`（已登记 / 缺失 / 过期），默认折叠、「查看全部」
- [x] `shared/DetailSheets.tsx`：右列 sheet 页签容器，`?sheet=` 记忆，键盘左右切换
- [x] `workspace/WorkspaceView.tsx` 装配三列 + 选中态与 URL 同步；右列按 sheet 切换
- [x] 统一 `taskPhase` 选择器，保证中列与右列阶段口径同源
- [x] 空态：无项目 / 无任务 / 无 bundle 三种，各有文案与恢复路径
- [x] 校验：`npm run typecheck:web && npm run test:web`

## M3 · 工作流 / 自动化 / 机器

- [x] 工作流页：沿用 `workbench/*` 的 hooks 与 model（`useWorkbenchBoard`、`editLaneInDef`、
      `skillExecutionWaves`、track mutations），重写为左列工作流+轨道 / 中列阶段 / 右列编辑
- [x] `workflow/StageEditor.tsx`：技能增删 + 依赖编辑（产生波次）、gate、guards；
      **完整保留增删改查**与脏态导航拦截
- [x] `workflow/DerivedIoPanel.tsx`：输入 / 产出只读推导，**不提供任何手填入口**
- [x] `workflow/TrackPanel.tsx`：轨道绑定表单 + 管线（`DefinitionCatalogPipeline`）只读展示
- [x] 自动化页：沿用 `afk/*` 逻辑，重写版式
- [x] 机器页：合并 `machine/*` 与 `hostPlan/*`，重写版式
- [x] 校验：`npm run typecheck:web && npm run test:web`

## M4 · 清理与验收

- [x] 删除 `shell/Nav.tsx`、`shell/ProjectsView.tsx`、`progress/ProgressView.tsx`
      及 `WorkflowCanvas` / `ProgressDrawer` / `ProgressToolbar` 一系与其专属测试
- [x] 确认无残留引用：`grep -rn "PRIMARY_VIEWS\|WorkflowCanvas\|ProgressDrawer" packages/dashboard-app/src`
- [x] 浏览器验收 375 / 768 / 1440：无横向滚动、焦点可见、`/` 聚焦搜索
- [x] 全量：`npm run typecheck:web && npm run test:web && npm run check:design-scale`
- [x] `trellis-check` 子代理复核 → `trellis-update-spec` → 提交

## 回滚点

M1 结束、M2 结束、M3 结束各留一个可运行提交；M4 的删除单独成一提交，便于回退。

## 实施偏差记录（2026-09-09）

- 视图内部 id 沿用 `progress | workbench | afk | machine`（URL `?view=` 深链与 localStorage 记忆继续有效），
  用户可见标签改为 工作台 / 工作流 / 自动化 / 机器；design.md 里的 `workspace | workflow | …` 只是语义名。
- sheet 选择记忆走 localStorage（`tenon-dashboard-sheet:<页面>`），未进 URL——URL 只承载 view / root / change，
  避免改动 useProjectSelection 的历史栏事务逻辑。
- 字阶沿用既有 7 级（H1 = text-page 28px），未为模板的 34/40px 加档；design-scale 门禁与 designSystem 测试
  锁死 7 级字号 / 4 级圆角。
- 阶段 Hook 开关、旁路词编辑、运行前事实作为阶段编辑的「钩子」sheet 保留（TimelineHookNodes / TimelineRuntimeFacts 原件）。
- 自动化 / 机器两页由 trellis-implement 子代理实现，因会话限额中断后由主会话补齐测试迁移。
- 中列状态页签为 全部 / 需要你 / 进行中 / 等待中 / 已归档：模板的「待复核」在现有五态里就是 gate（已计入需要你），
  「已完成」对应已归档 change（selectProgress 的 archived 行，只读留档）。
- 旧 IA 死代码（StepEditor 手填产出编辑器、StepperRail、WorkbenchHeader、SkillChain 一系、PageHeader、
  TaskPlanEvidenceSection、responseDecoders、useCurrentStagePosition）在 M4 单独一次提交里删除。
- 保留但暂未接线：`progress/OrchestrationV2Panel`（含 pause/resume/cancel 写操作，应落自动化页而非只读工作台）、
  `hostPlan/AdapterInstallWizard`（HEAD 时已无人引用）。
