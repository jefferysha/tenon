# Design — 工作流页重设计

## 1. kernel：steps ⊕ tracks

- `parseWorkflow`：name 之后允许直接 `tracks:`；有 `tracks` 时 `steps` 缺省为 `[]`。
- `validateWorkflow`：`tracks` 非空且 `steps` 非空 → `有 tracks 时不得再声明顶层 steps（每条轨道各写自己的阶段）`；`workflowBranches(def)` 有 tracks 时只列 track 分支。
- `selectTrackBranch(def, track)` / `selectTrackBranchIr(ir, track)`：
  - 有 tracks：命中 → 该分支；`track` 缺省（无轨道语境：指纹 / 文档策略 / 生成器）→ **第一条分支**；给了 track 但没有分支 → 抛 `WorkflowTrackBranchError('工作流 X 没有轨道 Y 的分支')`。
  - 无 tracks：`steps`。
- `planFromIr`：`definition` = 完整 IR；`workflow` = 选中分支；documentPolicy 由无轨道选择（第一条分支）算出，保证跨 track 一致。
- 生成器：`DEFAULT_WORKFLOW_STEPS` 取第一条分支；`_base` 表仅在有顶层 steps 时输出；`check-default-skill-matrix` 不变。
- default.yaml：删顶层 steps 与 `required_when`；新增 `chat` 分支（只有 tenon-* 驱动技能的七阶段）并放在第一位——它同时是 chat 轨道的 pipeline 与「无轨道语境」的代表分支，与分支化之前 default 的基础 pipeline 一致。历史指纹测试改为用冻结夹具（`legacyDefaultWorkflow()` = frontend 分支 × tenon-* 驱动 × spec plan artifact 加 `track_not_in: [pm]`）。
- `requireTrackForRoot` 不变；分支不存在的拒绝由 plan 解析抛出，init / 创建路由 catch 后 400 / exit 1。

## 2. server

- `workflowBranchesForApi`：有 tracks 时只返回 track 分支；否则 `_base`。
- `GET /api/skills/:name/files` → `{ name, source, origin, files: [{ path, bytes }] }`（递归目录，跳过隐藏文件与 >1MB；路径相对技能根，posix）。
- `GET /api/skills/:name/file?path=` → `{ path, text }`；path 须在 files 列表内（拒 `..`、绝对路径、符号链接逃逸），文本 ≤256KB，含 NUL → 415。
- `readme` 端点删除（被 file?path=SKILL.md 取代）。

## 3. dashboard

- 编辑器：`branches = tracks 有则 tracks 否则 [{id:'',label:null}]`；`selectBranchDef` 同口径；`addTrack`：有 tracks 复制当前分支，无 tracks 则把 steps 搬进第一条 track 并清空 steps；`removeTrack` 删到最后一条时把它的 steps 回到顶层 `steps`。
- `SkillDetailDrawer`（shared/workflow）：props `{ name }`；拉 files → 默认选 SKILL.md；左树右文；`.md` 走 Markdown，其它 `<pre>`；frontmatter 剥离后单独显示 name / description。
- `PipelineList` → `StageFlow`：`@dnd-kit/sortable` 竖向排序（拖柄 = 序号圆点），Flip 过渡；节点：序号 / 名称 / 技能数 / 门禁图标（review 盾、auto 闪电）/ 回流边虚线；选中节点 `shadow-md ring-accent`；主干线渐变。
- `StageEditorPane`：删上下箭头；技能芯片可点 → 详情；信息分层用分隔与小标题。
- `SkillComposer`：三栏 grid `[18rem, 1fr, 22rem]`；技能库项 = 拖柄 + 名称 + 来源图标（title）；点名称 → 右栏详情（复用 SkillDetail 内容）；画布列间 `→` 连接线 + 「+ 新一步」落区（常显、悬停放大）；列头 `∥ 并行` 标记（≥2 项）；节点可在列内排序。
- 动效（`shared/motion.ts` 新增）：`useFlip(ref, deps)`：变更前 `Flip.getState`，layout effect 后 `Flip.from(state,{duration:.32, ease:'power2.out', absolute:true, nested:true})`；`dropPulse(el)`；reduced-motion 直接跳过。
- 性能：`DragOverlay` 唯一移动体；`PaletteItem` / `Node` `memo`；不再对源节点施加 transform；`MeasuringStrategy.Always` 关闭（用 `WhileDragging`）。

## 4. 测试

- kernel：steps⊕tracks 校验、无轨道语境取第一条分支、缺分支抛错、default 无顶层 steps、生成器 `_base` 缺省、历史指纹夹具。
- cli：`--track chat --workflow default` 被拒；分支 init 通过（已有）。
- server：files / file 端点 200 / 404 / 400 / 越界；branches 无 `_base`。
- web：SkillDetailDrawer（树、切文件、Markdown）、StageFlow 排序回调、Composer 三栏与详情联动、i18n。
