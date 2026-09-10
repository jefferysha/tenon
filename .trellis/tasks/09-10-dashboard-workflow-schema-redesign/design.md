# Design — 工作流定义规范化与两页重设计

## 1. 边界

```
templates/workflows/default.yaml ──generate──▶ kernel default-workflow.generated.ts (builtin)
.pipeline/workflows/<name>.yaml  ──parse/validate──▶ WorkflowDef (kernel)
                                                     │
server: GET /api/workflows/:name  ──▶ WorkflowDef + effectiveIo（物化每步 IO）
        GET/PUT /api/workflows/:name/yaml ──▶ 原文导入导出
        GET /api/skills/registry · GET /api/config/effective · POST /api/config/mandatory-skills（已有）
                                                     │
dashboard-app:  workspace/（只读）   workflow/（编辑）   shell/（顶栏）
```

kernel 改数据（default.yaml）、一个纯函数（物化 IO）与 default 计划解析的 3 个分支（接受项目覆盖，校验不变）；server 加两条路由、一个响应字段并放开 default 写入；前端重写两页的列组件与领域模型。

## 2. 契约

### 2.1 物化 IO（server → web）

`GET /api/workflows/:name?root=` 响应在现有 `WorkflowDef` 之外追加：

```ts
effectiveIo: Record<stepId, {
  outputs: IoSlot[]
  inputs:  IoSlot[]
}>
type IoSlot =
  | { kind: 'document'; id: DocumentKind; label: string; producers: string[]; consumers: string[]; locked: boolean }
  | { kind: 'field';    id: FieldName;    label: string; type: 'file_path' | 'string' | 'boolean'; producer: string | null; consumers: string[] }
```

- 计算函数 `materializeWorkflowIo(def): EffectiveIo` 放 kernel `workflow/effective-io.ts`（纯函数，可被 CLI 复用）：
  - 文档：`documentGovernancePolicy(def.name, def)` → `outputsByStep[step]` 为输出、`readsByStep[step]` 为输入；`locked = (name==='default' || openspecContract==='required')`。
  - 值 / 文件字段：`step.outputs` 为输出；`step.inputs` 为输入；`producer` = 最近上游声明该 field 为 output 的 step；`consumers` = 下游声明 input 的 steps。
  - `label`：文档 kind 用 `documents/document-presentation-registry` 的中文名；字段用 `FIELD_LABELS`（新增小表，仅覆盖 FIELD_ORDER 中会出现在工作流里的字段）。
- 前端 `decodeWorkflowDefinition` 放宽：`effectiveIo` 可选（旧 server 兼容 → 前端退化为仅字段 IO）。

### 2.2 YAML 导入导出

| 路由 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `GET /api/workflows/:name/yaml?root=` | 无（本机回环 GET） | — | `200 text/yaml; charset=utf-8`：自定义 = 文件原文（`readWorkflowForApi` 同路径的受信读）；内建 = `serializeWorkflow(builtin)`。404 不存在，400 非法名 |
| `PUT /api/workflows/:name/yaml?root=` | Bearer token | `Content-Type: text/yaml` 或 `text/plain`，≤256KB | 200 `{ok:true, name}`；400 `{ok:false, errors[]}`（解析 / 校验 / name 与路径不一致 / track 引用非法）；401；413；409（内建名） |

- PUT 流程：读体 → `parseWorkflow` → `validateWorkflow` + `validateWorkflowTrackReferences` → `def.name === :name` → `writeWorkflowForApi(root, name, def)`（已有的原子写）。
- 同名覆盖即「导入」；UI 在覆盖前弹确认。

### 2.3 default 项目覆盖

现状：`compileEffectiveWorkflowPlan('default')` 恒读 `DEFAULT_WORKFLOW_SOURCE`；`loadEffectiveWorkflowPlan` / `resolveEffectiveWorkflowPlan` 对 default 传 `undefined`；server POST/DELETE 对 default 直接 400；列表过滤 `default.yaml`。

改动（kernel，3 处 + 1 helper）：
- `loadEffectiveWorkflowPlan(root,'default')` → `provided = loadWorkflow(root,'default') ?? undefined`（`loadWorkflow` 对 default 已经会读项目文件，builtin 表里没有 default）。
- `resolveEffectiveWorkflowPlan('default', loadCompiled)` → 新签名接受 `loadDefinition?: (name) => WorkflowDef | null`，default 分支 `compileEffectiveWorkflowPlan('default', loadDefinition?.('default') ?? undefined, track)`；所有调用点（server `workflowSnapshot.ts`、`workflowDefinitionReader.ts`、`serverPostChangesRoutes.ts`、cli）传入项目读取器。
- `compileEffectiveWorkflowPlan('default', provided)` 不变：`assertValid(definition,'default')` = `compileDefaultWorkflow` → 七阶段契约由此强制。
- `documentGovernancePolicy('default')` 不变（契约固定文档集合）。

server：
- `GET /api/workflows` 列表恒含 `default`，每项 `{ name, source: 'builtin' | 'project' }`。
- `GET /api/workflows/default` → 覆盖文件存在读它（`readWorkflowForApi` 走 `validateWorkflow(wf,{origin:'default'})`），否则 `parseWorkflow(DEFAULT_WORKFLOW_SOURCE)`；响应加 `source`。
- `POST /api/workflows/default`、`PUT …/default/yaml` → 允许；校验用 `validateWorkflow(wf, { origin: 'default' })`（已有 options.origin 分支）；失败 400 列错误。
- `DELETE /api/workflows/default` → 删除覆盖文件（= 恢复内建）；无覆盖时 404。
- `definitionCatalog.ts` 的 default 解析同样优先覆盖文件。
- 移除两处「default 不可编辑 / 运行时不读」的拒绝分支与注释。

### 2.4 默认工作流 YAML 变更

```yaml
- id: ship
  outputs: [{ field: pr_url, type: string }]
- id: archive
  inputs:  [{ field: pr_url, type: string }]
  outputs: [{ field: archived, type: boolean }]
```

其余不变。`npm run generate:default-workflow` 后 `default-workflow.generated.ts` 更新；`check:default-workflow-freshness` 作为门禁。

### 2.5 技能合一：轨道条件进 YAML（方案 B）

现状：一个阶段的技能来自两处——YAML `steps[].skills`（全轨道、先执行）与机器级 manifest `mandatory_skills[phase.profile]`（按轨道、后追加，`skillPolicy: manifest-overlay`）。

改动：
- kernel `SkillRef.when?: TrackPredicate`（parse：`when:` 块 + `track_in/track_not_in`；serialize 对称；compile `SKILL_KEYS` 加 `when`；track-reference-validation 校验引用的 track 存在）。
- `planFromIr(track)`：`capabilities.skills.steps[].requiredSkillIds / declared` 按 `when` 过滤——匹配 `track.id`，或（track 的 `skills.matrix=true` 时）匹配其 `skills.profile`（自定义轨道继承 profile 的技能）；被过滤掉的技能同时从其他技能的 `dependsOn` 移除。未传 track 时不过滤。
- `skillPolicy`：`phase-manifest` 且定义里**没有**任何 `when` → 仍 `manifest-overlay`（老快照、老 default 逐字不变）；定义里出现 `when` → `step-declared`（YAML 是唯一技能真相）。历史 fingerprint 公式不动。
- `templates/workflows/default.yaml`：把 manifest 矩阵按阶段并入（`open._all` → 无条件；其余 → `when: track_in: [...]`，chat/simple 因 matrix=false 天然不在名单）。矩阵技能不加 `depends_on`（与 manifest 一致：必跑、不定序）。
- `tools/check-default-skill-matrix.mjs` + `npm run check:default-skill-matrix`：断言 default.yaml 各阶段带 `when` 的技能集合 = manifest `mandatory_skills` 展开后的集合（manifest 退化为路由提示投影，不允许漂移）。
- 前端：`WbSkillRef.when`；`SkillDag` 节点带轨道标签（无 = 全部），节点弹出层勾选轨道；DAG 上方轨道芯片按轨道查看有效链（纯视图过滤）；删除 `TrackSkillsSection` 与 `mandatoryState` 写路径；`wavesToSkills` 保留 `when`。
- 已知限制（写进 spec）：项目覆盖文件里改的轨道条件不会反映到 manifest 路由提示文案；`/api/config/mandatory-skills` 写接口保留但 Dashboard 不再调用。

### 2.6 编辑器保存前校验（前端）

`lintWorkflowDraft(def, effectiveIo): LintIssue[]`：
- `step-no-output`：`effectiveIo[step].outputs.length === 0`
- `input-not-upstream`：field input 没有更早 step 产出
- 有 issue → 保存按钮禁用，中列节点右侧显示「缺产出」标签。

## 3. 前端领域模型

### 3.1 工作台 `workspace/taskModel.ts`

```ts
interface StageState { id; label; status: 'done' | 'current' | 'todo' }
interface TaskRow {
  name; track; workflow; archived; updatedAt
  stages: StageState[]                     // 来自 workflowRules.steps + change.phase
  summary: { stage: string; text: string } // 一行状态，见下
}
```

一行状态优先级（全部由数据得出，不引入抽象状态词）：
1. `documents.blockers[0]` 或 `workflowExecution.readinessByTransition[phase].*.blockers[0]` → 「缺 <slot label>」（用物化 IO 的 label 替换字段名）
2. `reviewHandshake.status === 'requested'` 且 gate=review → 「评审待确认」
3. 任一 transition `ready` → 「可进入 <to label>」
4. 否则 → 「进行中」

筛选：`stageFilter: stepId | 'all'` + `includeArchived: boolean`；计数按 `change.phase`。

阶段详情 `stageOutputs(change, io)`：文档槽位 → `documents.items[kind]` 的 `status / paths[0] / producers / timeline.at(-1)`；字段槽位 → `change.fields[field]`（file_path 有值即可读）。输入同理但只显示 就绪 / 未就绪。

### 3.2 工作流页

- `workflow/pipelineModel.ts`：`pipelineEdges(def)`：前向边（transitions 中 `to` 序号 > 当前）画连接线；回流边（`to` 序号 ≤ 当前）单列为 `backEdges[{from,to,event}]`。
- `workbench/skillWaves.ts` 增加 `wavesToDependencies(waves: string[][]): WbSkillRef[]`：第 k 列每个技能 `depends_on = waves[k-1]`（k>0）。DAG 拖拽只操作 `waves`，落盘时转换；读取时用现有 `skillExecutionWaves` 还原。
- 拖拽（@dnd-kit）：
  - 容器：`wave-<k>` 列、`gap-<k>`（列间隙 = 新列）、`palette`（本机技能）、`trash`（拖出画布即移除；同时提供节点上的移除按钮）。
  - 传感器：Pointer + Keyboard（`sortableKeyboardCoordinates`），焦点节点空格拾起、方向键换列。
  - 轨道附加技能：`SortableContext` 单列排序 + 从 palette 拖入；`onDragEnd` 得到新数组 → `postMandatorySkills({phase, track, skills})`；成功后刷新 `/api/config/effective`。
- 产出区候选：`availableSlots(def, stepId, effectiveIo, catalog)`：文档 kind（`DOCUMENT_KINDS` − 已被占用 − locked）、字段（catalog：`design_doc/plan/verification_report/prd_path` file_path；`build_sha/pr_url/branch/scope` string；`archived` boolean）。写回：文档 → `documentContract.slots` 增删（仅非 openspec 契约工作流）；字段 → `step.outputs` 增删（file_path 同步维护 `artifacts` 一条 `producerPolicy: 'effective-step-skills'`）。
- 输入区：`upstreamOutputs(effectiveIo, stepIndex)` 勾选 → `step.inputs` / `documentContract.reads`。

## 4. 组件

```
shell/TopBar.tsx            去胶囊与头像；Settings 图标按钮
shared/Drawer.tsx           右侧抽屉原语（portal、560px、backdrop、Esc、焦点捕获/还原、aria-modal）
shared/Markdown.tsx         react-markdown + remark-gfm，映射到 token 样式；仅渲染 text/markdown
workspace/
  WorkspaceView.tsx         三列装配
  TaskListPane.tsx          阶段 chips + 含已归档开关 + 列表
  TaskCard.tsx              名称 / 轨道 / MiniPipeline / summary
  MiniPipeline.tsx          7 段 done|current|todo
  TaskDetailPane.tsx        头部 + StageRail + StageIoPanel
  StageIoPanel.tsx          输出列表 / 输入列表（文件行可点 → DocumentDrawer）
  DocumentDrawer.tsx        上一份 / 下一份 + Markdown/纯文本
  taskModel.ts · stageIo.ts · useWorkflowDefinition.ts（读 effectiveIo）
workflow/
  WorkflowView.tsx · WorkflowRail.tsx（导出 / 删除菜单）
  PipelineList.tsx          节点 + 连接线 + 回流边 + 添加阶段节点
  StageEditorPane.tsx       头部 · SkillDag · OutputsSection · InputsSection · GateSection · TrackSkillsSection · 底栏
  SkillDag.tsx              列式 DAG + SVG 边 + dnd 容器
  SkillPalette.tsx          本机技能（registry，搜索）
  TrackSkillsSection.tsx    折叠：轨道 → 可排序技能链
  OutputsSection.tsx · InputsSection.tsx
  NewWorkflowDialog.tsx     模板三选一（复制 default / 空白 / 导入 YAML）+ 命名
  ImportYamlDialog.tsx      粘贴 / 选文件 → PUT yaml
  pipelineModel.ts · slotCatalog.ts · lint.ts
workbench/useWorkflowEditor.ts   增加 setSkillWaves / addOutputSlot / removeOutputSlot / setInputs / importYaml / exportYaml / hasWriteToken
api/workflowYamlClient.ts        fetchWorkflowYaml / putWorkflowYaml
```

删除：`workspace/FileWorkbench.tsx`、`workspace/stageFiles.ts`（改 `stageIo.ts`）、`workflow/DerivedIoPanel.tsx`、`workflow/StageListPane.tsx`、`workbench/workbenchDefinition.ts` 的 `buildDefaultDef/DEFAULT_DEF/governedWorkflow`（新建改为服务端读 default 后改名）、`workbench/mandatoryState.ts` 中矩阵 UI 专用残余（保留读写 hook）。

## 5. 错误处理

- 无写凭证（`getToken()` 为空）：编辑器进入只读态，底栏与新建 / 导入置灰 + 一句说明；不再发出会 401 的请求。
- PUT yaml 失败：对话框内列出 `errors[]`（服务端文案已是中文），文件不落盘。
- 抽屉读取失败：抽屉内显示错误（字段名 `detail`），不关闭抽屉。
- 矩阵写回失败：该轨道行内红字，保留本地顺序供重试；409 → 重新拉取 effective 配置。
- 旧 server（无 `effectiveIo`）：工作台只显示字段 IO，工作流页产出区禁用文档槽位编辑并提示需升级服务端。

## 6. 取舍

- **不改 kernel 校验**加「每步必须有输出」：CLI 与既有自定义 YAML 不受影响；编辑器与导入路径（PUT yaml 也只跑 kernel 校验，导入以 kernel 为准）——导入合法但缺产出的 YAML 会在编辑器里标「缺产出」并阻止再次保存。
- **DAG 只表达波（列）**而非任意依赖：`depends_on` 任意图能表达更多，但用户要的是「串行 / 并行」可视，列模型足够且可逆（读取时按现有 `skillExecutionWaves` 分列）。
- **文档槽位写入 `document_contract`** 仅对非 `openspec_contract` 工作流开放：kernel 禁止两者共存；default 及其副本文档集合固定，UI 用锁标（无文字）表示。
- **default 可编辑但契约不可破**：覆盖文件通过 `compileDefaultWorkflow` 才落盘，保证 phase-manifest 运行模型、文档策略与 artifact 表仍成立；用户要改七阶段结构时新建自定义工作流。
- **运行时自动登记不在本任务**：见子任务 `09-10-skill-output-auto-registration`；本任务只保证展示面（物化 IO、输出状态、产出技能与时间）已就位。
- **Markdown 只渲染文本**：react-markdown 默认不输出原始 HTML，无需 sanitizer。

## 7. 兼容与回滚

- 新响应字段可选、新增路由独立，旧客户端不受影响。
- default.yaml 仅追加非文件字段的 outputs / inputs，不影响 transition、guard、artifact 编译。
- 回滚：revert 提交即可；`.pipeline/workflows` 内用户文件不被迁移或改写。
