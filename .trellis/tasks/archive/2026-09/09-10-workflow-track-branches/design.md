# Design — 工作流 track 分支、技能编排浮层、IO sheet 与门禁语义

## 1. 分支模型（kernel）

```yaml
name: default
steps: [...]            # 通用分支：track 未命中任何 tracks.<id> 时使用
tracks:
  frontend:
    label: 前端
    steps: [...]        # 独立 pipeline：阶段 / 技能 / 输入输出 / 门禁 / 守卫 / 转换 全部自有
  backend:
    label: 后端
    steps: [...]
```

- `WorkflowDef.tracks?: Readonly<Record<TrackId, { label?: string; steps: StepDef[] }>>`。`SkillRef.when` 删除（parse / serialize / compile / validate / track-reference-validation / effective-plan `conditional` 全部移除）。guard / artifact 的 `when` 保留（模型既有），default 分支里不再需要。
- `selectTrackBranch(def, trackId?): WorkflowDef` → `{ ...def, steps: def.tracks?.[trackId]?.steps ?? def.steps }`（去掉 `tracks`）。接入点唯一：`compileEffectiveWorkflowPlan(id, provided, track)` 在 compile 前调用（`track?.id`）。冻结快照存的是编译后 IR，已是分支结果，老 change 不受影响。
- `matrixEmbedded = def.tracks !== undefined`；embedded 时 overlay 恒为空（分支阶段的 skills 即全部必需技能）。resolver 的 `embeddedOverlaySlots` 删除；`skillRuns` 的 overlay 只剩 manifest 回退（老快照）。
- 校验：`tracks` 键满足 `TRACK_ID_RE`；每条分支按同一 step-graph 规则校验（错误前缀 `tracks.<id>.`）；default 的每条分支 + 通用分支都过 `validateDefaultWorkflowStructure`。
- 生成器 `tools/generate-default-workflow.mjs`：改为完整 YAML 解析（复用 kernel `parseWorkflow` 经 tsx？——脚本是 .mjs 且刻意零依赖：保留窄扫，但按 `tracks:` 顶层块分别扫描各分支的 steps；`DEFAULT_ARTIFACT_DECLARATIONS` 改为 `Record<track | '_base', Record<step, decl[]>>`，`defaultArtifactsForStep(step, track)` 先查分支再回通用，不再用 `requiredWhen`。`check-default-skill-matrix.mjs`：逐分支比对 manifest mandatory 表。
- track 策略：`resolveTrackForBranch(registry, id, def)`：registry 有 → 原定义；无但 `def.tracks[id]` 存在 → 合成缺省 `TrackDefinition`（builtin false, label = 分支 label ?? id, workflow {default: def.name, allowed: [def.name]}, 缺省 policyProfile）。`init` 与 `effectiveWorkflowForState` / server snapshot 的 track 解析统一走它。

## 2. 门禁

```ts
export type GateKind = 'review' | 'auto' | null
```

- `auto`：compile 时对该 step 每条 transition 追加 `nonempty-output`（现有守卫，展开为每个 output 的 `output-present`）。文档类输出仍由文档策略守卫。
- `review`：不变。
- `confirm`：compile 报错 `gate 'confirm' 已移除：需要人工停下用 review，输出齐全即放行用 auto`。`advance.ts` 删除 `step.gate === 'confirm'` 分支（marker 类型里的 `confirm` 是 router 的「是否进入 pipeline」确认，与阶段门无关，保留）。
- 前端说明文案（i18n `workflow.gate_help_review|auto|none`）：评审 = 「产物完成后需 tenon review request → 人工 acknowledge 才能进入下一阶段」；自动 = 「本阶段声明的输出全部齐全即放行」；无 = 「只检查显式守卫」。

## 3. server

- `GET /api/workflows/:name` → `{ ...def（含 tracks）, source, branches: Record<'_base' | trackId, { label, effectiveIo }> }`。`PUT yaml` / `POST` 原样接受 `tracks`。
- `GET /api/skills/:name/readme` → `{ name, source, path, markdown }`；从 `skillsRegistry` 已探测到的根解析 `SKILL.md`，未找到 404。名称白名单同 `SKILL_TOKEN_RE`。
- `GET /api/workflows/:name?track=<id>`：不新增；前端从 `branches` 取。

## 4. dashboard 工作流页

- 左列 `WorkflowRail`：工作流卡可展开（chevron）；展开项：`通用` + 各 track（`label ?? id`）；选中项 = `{workflow, branch}`；底部动作加「新建轨道」（输入 id / label，复制通用分支）与「删除轨道」（当前为 track 时）。
- 中列 `PipelineList`：所选分支的阶段；卡片只显示 `label ?? id`、技能数、门禁标签。
- 右列 `StageEditorPane`：
  - 技能：只读波次视图 + 「编辑」→ `SkillComposer` 浮层（`Dialog variant="workspace"`）。左：搜索框、技能列表（`/api/skills/registry`）——名称、来源徽标（本地插件 / 市场 / 内建 / 用户）、点名称展开来源路径与一句话描述、眼睛 → 右侧 `Drawer` 内 `Markdown` 渲染 `/api/skills/:name/readme`。右：波次画布（`@dnd-kit` `DragOverlay` + `useSortable` 过渡；`pointerWithin` 落列 = 并行，落到列间 gap = 新波次）；每个已放技能可移除。保存 → `editor.setSkills(stepId, wavesToSkills(waves))`。
  - 输入 / 输出：两行入口（图标 + 数量）→ `Drawer`。每个槽位：名称、类型、来源：输入 = `来自 <阶段 label> · <技能 ids>`（`branches[b].effectiveIo` 的 producers），输出 = `<本阶段技能 ids>`；末行 mono 显示 YAML 路径 `tracks.<id>.steps[<step>].outputs[<field>]`。
  - 门禁：三项单选 `评审 / 自动 / 无`，每项后 `Info` 图标，`title` + `aria-describedby` 显示说明。
- 名称统一：删 `trackPresentation.trackDisplayName`；所有展示 `label ?? id`。

## 5. 工作台

- `useWorkflowDefinition` 返回 `branches`；`TaskDetailPane` 取 `branches[change.track] ?? branches._base` 的 `effectiveIo`。
- `taskFacets`：阶段 facet 仅当筛选结果只剩一个工作流且一个 track；选项来自这些任务的 `workflowRules.steps`（已是分支后的阶段）。

## 6. 测试

- kernel：parse/serialize 往返含 `tracks`；`selectTrackBranch`；`gate: auto` 编译出 output-present；`confirm` 报错；default 每条分支过骨架校验；生成器对新 YAML 的 declarations 表；track 合成定义。
- cli：`init --track mobile --workflow custom`；`transition` 在 `auto` 门输出缺失时 exit 非 0。
- server：workflows GET 含 `branches`；readme 端点 200 / 404；snapshot 分支阶段。
- web：Rail 展开 / 切换分支；SkillComposer 搜索、预览、拖拽（dnd-kit 键盘传感器）保存；IO sheet 溯源文本；门禁 hover；名称单一；App 级 i18n 完整性 / 泄漏。
- 门禁：`typecheck:web`、`test:web`、kernel/server/cli vitest、`test:hooks`、`check:design-scale`、`check:comments`、`check:default-workflow-freshness`、`check:default-skill-matrix`、`build:web/server/bundle`。
