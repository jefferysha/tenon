# 技术设计：工作流收敛为一个 default，轻重与领域都用轨道表达

## 背景

现状（2026-10-10，main `f9b5bd18`）：

- 内建 4 个工作流：`default`（7 步、3 个评审门、OpenSpec 文档）、`standard`（立项 → 实现 → 验证 → 完结，1 个评审门、无文档，`templates/workflows/standard.yaml`）、`simple`（错字级、不跑测试，`builtin-workflows.ts`）、`design-system`（专用）。
- `default` 的 5 个轨道（对话、产品、前端、后端、自由）骨架完全相同，只在每步挂的技能、评审者、测试策略上不同；「对话」「自由」名字轻、流程一样重。
- 「轨道」在代码里是两套：路由用的轨道登记表（`packages/kernel/src/tracks/builtins.ts` 的关键词、排除词、优先级、绑定的工作流，加项目手写的 `.pipeline/tracks.yaml`；Tenon 没有任何命令或页面会写它），与工作流 YAML 的 `tracks.<id>` 分支（决定步骤）。simple、standard 在登记表里是轨道，在工作流层面又是独立工作流。
- 路由器（`hooks/router.sh` + `hooks/router-gen.mjs`）是写死的正则打分，不读工作流文件：用户新增的工作流不会被选中也不会被列为候选；「修复」「新增」这类字眼直接把请求送进 standard，没有评估改动范围。
- `openspec` 只能写在工作流顶层（`compile.ts` 的 `TRACK_BRANCH_KEYS` 只有 label / documentContract / steps），standard 因此只能做成独立工作流。`openspec: true` 只做一件事：让 `documentGovernancePolicy()` 返回策略，下游的文档台账、骨架、转换取证、规格迁移检查、`openspec archive` 收尾都由它驱动。
- 所有任务目录写死在 `openspec/changes/<c>/`。本仓库锁定的 OpenSpec 1.6.0 对该目录下没有 delta 的子目录一律判失败（`Change must have at least one delta`），只排除 `archive/` 与 `.` 开头的目录；1.7.0 起才有 `skip_specs`（见 researcher 报告 `openspec/changes/consolidate-workflow-tracks/.pipeline-agent-reports/f556cc33-…md` §2）。standard 完结时会提交整个工作区但不移目录，导致 CI 的 `check:openspec` 失败，只能手动排除。
- 工作台的「已归档」开关（`tenon task archive`）实际是「只对你隐藏」，与「完结」重名；服务端列任务时跳过 `openspec/changes/archive/`（`snapshotProjectScan.ts:146`），走完 default 的任务在工作台里看不到。

用户 2026-10-10 在调研步逐项确认了下面的决策。

## 决策

### 1. 概念模型：工作流 = 一组轨道分支，轨道只此一套

- 内建只保留 `default` 与 `design-system`。`default` 的轨道为：**轻量（lite）、产品（pm）、前端（frontend）、后端（backend）**。删除 `standard`、`simple` 两份工作流，删除 `default` 的「对话」「自由」两个分支。
- 轨道的身份是「工作流 + 轨道 id」；路由候选、`tenon init --workflow --track`、Dashboard 都用这一对。
- 分支新增两个可选键：
  - `spec: openspec | none`：本分支是否走 OpenSpec（文档台账、骨架、规格迁移检查、`openspec archive` 收尾）。不写时继承工作流顶层：顶层 `openspec: true` 视为 `spec: openspec`，旧文件不用改。
  - `route`：`keywords`、`exclude`、`priority`、可选 `fallback: true`。不写表示该分支不参与自动路由，只能点名使用。
  - `automation`：`eligible`（能否进 AFK）、`enqueue_after_spec`（规格完成后自动入队）。沿用现值：产品 / 前端 / 后端 `eligible: true`，产品 `enqueue_after_spec: true`，轻量 `eligible: false`。原登记表里的其余策略位（技能矩阵 profile、coverage profile、reviewSeed）随规则精简一并删除。
- 删除代码里写死的路由登记表与 `.pipeline/tracks.yaml` 的读取；`tenon tracks` 改为列出所有工作流的分支。
- 没有 `tracks:` 的平铺工作流（如 `design-system`、用户自定义的一串步骤）视为只有一个轨道：`tenon init` 不用写 `--track`；顶层可写 `route` 参与路由。原「自由」承担的「任意工作流的中立入口」由此不再需要。
- 内核把文档治理开关与生效计划改为按轨道计算；`workflow-run-repository.ts:109`、`state-init.ts:49,64` 两处「不带轨道、取第一条分支」的调用改为带轨道。

### 1a. default 改为按 YAML 执行（不再有写死的阶段规则）

- 现状：执行模型按工作流名选择——名为 `default` 走 phase-manifest（转换表 `flow/transition-table.ts`、事件策略 `flow/default-event-policy.ts`、阶段出口表 `flow/guard.ts` 的 `EXIT_RULES`、`templates/manifest.yaml` 的 phases / transitions 全部写死在代码里），其余走 step-graph；存储校验要求 default 的每个分支恰好是 7 步（`document-contract-validation.ts:179-215`）。lite 分支直接放进去会让 default 整份加载失败。
- 决定：default 全部改为 step-graph，按 `default.yaml` 每步的 `guards`、`transitions[].actions`、`outputs` 执行；写死的规则搬进 YAML，搬的同时精简——逐条规则的保留 / 删除 / 修改由用户逐条确认（清单见 §1b）。现有 YAML 词表表达不了的检查或动作，补成通用的 guard / action 类型，不再按工作流名或阶段名特判。
- 删除 `templates/manifest.yaml` 的「阶段 × 轨道」技能矩阵叠加（与 `default.yaml` 每步技能完全重复，去重后无效果），连同直接改插件目录 manifest 的服务端写接口与无人渲染的前端状态；技能只看工作流 YAML。
- 在途任务：快照里记录了旧执行模型的任务继续用旧代码走完（旧引擎只服务旧快照），新建任务一律按 YAML 执行；旧引擎在下一个版本删除。
- 存储校验不再要求 default 是固定 7 步；只校验一般工作流规则与 `spec: openspec` 分支需要的文档与规格步骤。

### 1b. 写死规则的去留（用户 2026-10-10 逐条确认，全部按推荐）

照原样写进 `default.yaml`（行为不变）：9 条转换（含 `requirements-changed`、`verify-fail` 两条回退）；实现前评审 `pre_verify_review_result=pass`；`spec-complete` / `requirements-changed` / `verify-fail` 时 `reset-pre-verify-review`；`build-complete` 时 `freeze-build-sha`，`verify-pass` 前 `build-head-unchanged`；`mark-verification-passed` / `mark-verification-failed`；规格步 `tasks-at-least 3`；调研步 `design_doc` 存在；规格步 `plan` 存在（`when: track_not_in: [pm]`）；`spec: openspec` 分支交付步 `spec-migration-applied`；交付步 `pr_url`（产品轨道 `prd_path`）；评审门、`max_rounds: 2`、完结 `archive-run`。

| # | 规则 | 决定 |
|---|---|---|
| Q1 | 实现出口 `build_mode` / `isolation`（∈ branch/worktree/in-place）/ `direct_override` | 删除字段与检查 |
| Q2 | 验证通过前 `branch_status=handled` | 删除 |
| Q3 | 每个阶段出口 statefile | 删除 |
| Q4 | 立项出口按字面路径查 proposal.md / tasks.md / design.md、至少 1 条任务 | 删除 |
| Q5 | 每个阶段出口：截至本阶段的 tasks.md 任务都已勾选 | 保留，做成通用 guard（任何工作流可用） |
| Q6 | 规格出口 coverage 矩阵（设计文档 coverage 块 × 轨道 profile） | 删除 |
| Q7 | 实现出口：AFK 排队中不许手动完成 | 保留，做成通用 guard |
| Q8 | 实现出口：`depends_on` 依赖已结束 | 保留，做成通用 guard |
| Q9 | 验证出口（产品）与完结出口再查 `verify_result=pass` | 删除（验证通过的动作已写入） |
| Q10 | 首错即停、旧版逐字文案、退出码 1 | 统一为一次列出全部失败、退出码 2；旧版逐字对比的 oracle 用例改写或退役 |
| Q11 | `tenon advance` 在前进 / 回退两条出边时 | 通用规则：只有一条前进边时走它，回退边只在显式选择时走 |

配套的通用化（无行为变化）：`check` / `status` 字段投影 / 结论字段写入闸改为同时读取边级 guard；artifact 产出策略统一为 `effective-step-skills`；路由 breadcrumb 改用步骤标签与提示词；`templates/manifest.yaml` 的 phases / transitions / review_phases 只服务旧快照。

### 2. 轻量轨道（lite）

- 步骤、门禁、测试照搬现 `standard`：立项（无门，一句话复述目标与验收标准，错字级改动也从这里进）→ 实现（TDD；改动范围单测、登记了就跑类型检查；改动风险探针，阈值不变：改动文件 ≤ 8，契约 / 鉴权 / 依赖 / 迁移 / 删测试 / 受保护测试配置均为 0）→ 验证（唯一评审门；全量单测，其余登记了就跑；`code-review` 必需、medium 阻断，`security` 只在碰到鉴权 / 依赖 / 契约路径时加入；验证轮次上限沿用默认 2 轮）→ 完结；终态 `escalated`（已升级）保留。
- `spec: none`，不声明文档契约。
- 升级：探针超限时只能走 `scope-expanded` 到「已升级」，本任务结束、不提交，改动留在工作区；随后新建 `default` 的重型轨道任务并 `tenon set <新任务> depends_on <本任务>`。`depends_on` 的已有检查（`flow/guard.ts:352` 的 `depends-archived`）保证旧任务已结束。新任务的轨道沿用轻量任务创建时路由判定的领域（建任务时记入任务状态），`escalate.then` 直接给出；当初没有领域时列出 前端 / 后端 / 产品 让用户选。
- 交付：与现 standard 相同，验证通过后只在当前分支本地提交，没有推送与开 PR 的交付步；推送与 PR 由用户决定。

### 3. 路由与 `tenon assess`

- `router-gen` 改为收集所有可用工作流（项目 `.pipeline/workflows/` → 全局存储 → 插件模板）里每个带 `route` 的分支，生成打分表；缓存失效条件加入所有工作流文件的修改时间，保存工作流后下一条消息即按新规则路由。缓存格式升为 `router.v6`，旧缓存作废重建，路由继续 fail-closed、bash 薄 shim 不引入解释器依赖。
- 路由只决定「是不是开发请求、属于哪个领域」，**不按关键词决定轻重**：
  1. 消息点名了轨道（「用 X 轨道」、`--track X`）或工作流（「用 X 工作流」、`X:轨道`）→ 直接用，不评估。
  2. 带重型信号（架构、跨模块、迁移、schema、鉴权、依赖升级、发布、全栈等）→ 直接走领域重型轨道，不评估。
  3. 其余开发请求 → dispatch 带 `assess: required`，候选为「轻量 + 领域重型轨道」。agent 在建任务前读相关代码、列出预计要改的文件，运行 `tenon assess --files <…>`，把评估结果与推荐摆给用户，用户确认后才 `tenon init`；持续执行模式直接采用推荐。
  4. 最高分并列，或最高分落在自定义工作流的分支 → `selection_required`，列出候选「工作流 + 轨道」让用户选。
  5. 都没命中 → 不建任务；像在改代码时提示一行。
  6. 被排除词挡掉、又没有分支认领 → 落到声明了 `route.fallback: true` 的分支（default 中为后端），取代 bash 里写死的兜底。
- 纯讨论的消息照旧不建任务（原「对话」身份承担的语义由路由器的讨论判断承担）。
- 新增 `tenon assess --files <paths…> [--workflow default --track lite] --json`：用与 lite 改动风险探针完全相同的分类规则与阈值（读生效工作流 YAML 里 lite 实现步 `diff-risk` 的 `pass.metrics`）评估一组预计改动的文件，输出是否超限与理由。所选分支没有 `diff-risk` 测试时报错说明「该轨道没有改动风险阈值」，不猜阈值。探针在实现后按实际改动再查一次，作为安全网。
- Dashboard 工作流页的门禁段下，只读列出该步的离开条件（一行一条，如「实现前评审通过」「本阶段任务已勾选」「依赖任务已结束」），编辑仍只在 YAML 里做。
- `skills/tenon/SKILL.md` 选通道规则改为：以 dispatch 为准；`assess: required` 时先评估再建任务；`/tenon` 手动新建时同样先评估；不再提 standard。

### 4. 完结、终止与工作台分类

- 所有轨道完结都移进 `openspec/changes/archive/<日期>-<名字>/`：
  - `spec: openspec` 的轨道：`next` 的 `finish-change` 给出 `tenon task finish <c>`，由 Tenon 调用 `openspec archive <c> --skip-specs --yes --json` 完成移动，并在任务状态里记下结果与归档位置；提交沿用现有归档提交。agent 不再直接执行 openspec 命令。
  - lite 完结：`next` 的 `finish-change` 给出 `command: tenon task finish <c>`，由 CLI 在锁内原子地把目录移进 `archive/`（同样命名，不依赖 openspec 命令），再按 `commit` 提交整个工作区 `chore(tenon): finish <c>`。
  - lite 已升级：`scope-expanded` 之后的 `finish-change` 同样给出 `tenon task finish <c>`，`commit` 为 `null`（不提交）。
  - `tenon task finish` 与 `tenon task terminate` 共用同一个移动实现；`finish` 只接受已到终态（完结 / 已升级）的任务。
- 新增 `tenon task terminate <c>`：任务结果记为「已终止」，目录移进 `archive/`，并只提交这个任务目录（`chore(tenon): terminate <c>`）；任务改过的代码不提交、原样留给用户处理。想继续就新开任务并 `depends_on`。`tenon task delete` 保留。
- 删除「隐藏」：`tenon task archive / unarchive`、工作台「已归档」开关、每用户 `archived.json` 的读取全部删除；旧命令报错并提示 `terminate`。此前被隐藏的任务会重新出现在进行中。
- 工作台分类为：全部 · 需要你 · 进行中 · 已结束；「已结束」列出 `archive/` 下的全部任务，卡片标出任务结果（完结 / 已升级 / 已终止），按结束时间倒序；「全部」也包含它们，排在进行中之后。（分类名用「已结束」而非「已完成」：已终止、已升级的任务并没有做完。）
- 服务端列表层额外扫描 `archive/`，只读名称、工作流、轨道、结果、完结时间、PR 链接、负责人；归档目录内容不再变化，按目录身份缓存，不进入实时变更检测；点开时才加载完整详情（只读）。

### 5. 兼容与迁移

- 进行中的 standard / simple / 对话 / 自由任务：建任务时冻结的工作流快照足以支撑其走完——查状态、切换阶段只认快照，不再回读当前工作流文件或路由登记表（`effective-workflow.ts:23-25`、`branch-track-lookup.ts:32-39` 的回读路径改为优先快照）。没有快照的早期任务报错并提示 `tenon task terminate`。
- `tenon init --workflow standard|simple` 报错，提示改用 `--workflow default --track lite`；`--track chat|free` 同样报错并提示可选轨道。`design-system` 按平铺工作流建任务（不再用 `--track free`），同步 `design-precondition.ts` 的提示文案与相关测试。
- AFK 自动修复（`cli/src/commands/triage.ts`）：仍用 default + 后端，但修正为按后端分支取计划（现在不传轨道、取到第一条分支，与轨道不一致）。
- 删除无人调用的 Dashboard 接口与状态：新建任务 `POST /api/changes`、路由预览（`routerPreview.ts`，其中镜像了 standard 规则）、技能矩阵编辑状态、未使用的轨道文案；工作台空态只保留 `/tenon` 提示词（会走评估），不再给写死轨道的 `init` 命令。
- 存过的工作流文件：顶层 `openspec: true` 作为分支缺省 `spec: openspec`；旧任务的工作流指纹在不出现新键时保持不变。
- `.pipeline/tracks.yaml`：不再读取，检测到时提示一行迁移方法。
- 规格：新增轨道能力；修改 `workflow-definition`、`declarative-document-governance`、`effective-workflow-plan`、`normal-chat-routing`（删除「自由」中立入口与「对话」轨道身份，讨论判断保留）、`simple-task-routing`（退役 simple，由 lite 承接）。
- 文档：用法文档、`docs/CONTRACT.md`、`skills/tenon/SKILL.md` 同步；发布说明写明 standard / simple / 对话 / 自由 已退役、「隐藏」已删除。

### 6. 测试

- 内核单测：分支键 `spec` / `route` 的解析、校验、序列化；按轨道的治理策略；旧任务指纹不变。
- 路由：`router-gen` 从工作流分支生成数据，工作流文件变化使缓存失效；评估分派、并列与自定义候选、兜底规则；迁移 `tools/test-hooks.sh` 的路由夹具。
- `tenon assess`：与改动风险探针用同一组夹具，结论一致。
- 轻量轨道集成测试（迁移 `standard-lane.integration.test.ts`）：≤ 25 次 tenon 调用、2 次用户回复；完结移进 `archive/` 并提交、已升级移进 `archive/` 不提交；结果树在本仓库跑 `check:openspec` 通过。
- `tenon task terminate` 单测；服务端列出 `archive/`，`bench-snapshot` 加一组 60 个归档任务，p95 < 1.5 s；Dashboard 分类筛选单测；e2e 覆盖「已结束」分类与任务结果标记与工作流页的轨道列表。
- 交付前本地跑齐 `check:*`（含 `check:openspec`、`check:default-workflow-freshness`、`check:repository-hygiene`）、hook / adapter / bundle 测试，CLI 与 server 产物重建。

### 6a. 模块与接缝（codebase-design）

| 模块 | 接口 | 接缝与适配器 | 取代 / 删除 |
|---|---|---|---|
| M1 轨道解析 | `resolveTrack(workflow, trackId?) → TrackBranch`（步骤、规范、路由、自动化）；平铺工作流返回唯一的隐式分支；轨道不存在时报错并列出可选轨道 | 无外部适配器，纯函数 | 删除 `tracks/builtins.ts`、`registry.ts`、`tracks.yaml` 解析与校验、`branch-track*.ts` 的合成、`assertWorkflowAllowed`；init、server、automation 统一调用它 |
| M2 工作流执行 | `planTransition(plan, state, event, ctx) → 计划结果 \| 拒绝`；离开条件词表新增三个通用 guard：任务已勾选（截至本步）、未在 AFK 排队、依赖已结束；所需能力经 `GuardInput` 注入 | 一个接缝两个适配器：step-graph（所有新任务）与旧 phase-manifest（只服务快照里记着旧模型的任务），按快照的执行模型选择；旧引擎整体收进 `workflow/legacy-phase-manifest/`，下个版本整目录删除 | 新任务不再经过 `flow/transition-table.ts`、`default-event-policy.ts`、`guard.ts` 的 `EXIT_RULES`、manifest phases |
| M3 生效计划 | `compileEffectivePlan(workflow, track) → plan`：能力（是否走 OpenSpec、自动化开关）全部来自 M1 返回的分支；新计划一律 step-graph | 无 | 不再按工作流名 `default` 特判；删除技能矩阵叠加（`effective-skill-resolver` 的 manifest 分支） |
| M4 改动风险分类 | `classifyChange(paths, thresholds) → { metrics, exceeded, reasons }` | 一个接缝两个适配器：路径来源为 git diff（实现后的探针）或显式列表（`tenon assess` 的预计文件）；阈值读自轨道的 `diff-risk` 测试 | 探针与评估共用同一份分类规则，事前事后结论一致 |
| M5 路由表生成 | `buildRouterTable(workflows) → rows` 纯函数；加载工作流（项目 → 全局 → 模板）与写缓存在边缘 | `router.sh` 只读缓存（`router.v6`），不变 | 删除 router 对登记表的投影；`routerPreview.ts` 删除 |
| M6 任务归档 | `tenon task finish <c>` / `tenon task terminate <c>` 背后的 `archiveTask(change, result) → { archivedDir, result }`：先在任务状态里记下结果，再移动目录，再记下归档位置与（完结时的）提交信息 | 一个接缝两个适配器：`spec: openspec` 的轨道由 Tenon 调用 `openspec archive <c> --skip-specs --yes --json`；`spec: none` 的轨道由 Tenon 在锁内原子移动目录（同样的 `YYYY-MM-DD-<name>` 命名）。`next.finish-change.command` 对所有轨道都是 `tenon task finish <c>`，agent 不再直接执行 openspec 命令 | 删除每用户隐藏存储（`task-archive.ts`、`archivedGuard.ts`、`tenon task archive / unarchive`） |
| M7 已结束任务列表 | `listEndedTasks(root) → summaries`（名称、工作流、轨道、任务结果、结束时间、PR 链接、负责人） | 按归档目录身份缓存，不进实时变更检测；详情复用现有的单任务扫描、指向归档路径 | 服务端快照不再只扫 `openspec/changes/` 的活跃目录 |
| M8 Dashboard | 工作流页按分支读 `spec` / `route` / `automation`；轨道设置可改「规范」与「关键词」；门禁段只读列出离开条件；工作台分类 全部 · 需要你 · 进行中 · 已结束 | 经现有 `src/api/` 客户端边界 | 删除技能矩阵编辑状态、新建任务与路由预览客户端、「已归档」开关与未使用的轨道文案 |

删除测试（删掉后复杂度消失、不会散到调用方）：`templates/workflows/standard.yaml` 与 `builtin-workflows.ts` 的 simple；`templates/manifest.yaml` 的 `mandatory_skills`；`tools/check-default-skill-matrix.mjs`；服务端 `config.ts` 的技能矩阵读写接口；`POST /api/changes`。

### 6b. 安全与依赖

- `tenon assess --files` 只接受仓库内的相对路径，拒绝绝对路径、`..` 与指向仓库外的符号链接；不读取文件内容，只按路径分类。
- 归档只在仓库根下的 `openspec/changes/` 与 `openspec/changes/archive/` 之间移动目录，锁内原子 rename，不跟随符号链接；目标已存在时追加序号，绝不覆盖。
- `tenon task terminate` 的提交只带被移动的任务目录这一组 pathspec，不会把工作区里其他任务或用户的改动带进提交。
- 路由缓存仍是有界的纯数据，bash shim 不 `source` / `eval` 它；工作流 YAML（含全局存储里用户保存的）只经闭集 codec 解析，未知键与非法值一律失败关闭，写坏的工作流在路由生成时被跳过并警告。
- AFK 排队中的任务不能被手动推进（§1b Q7），避免人工与自动化同时改同一任务。
- Dashboard 的轨道设置保存走现有工作流写接口（登录会话、写 token、Host 校验不变）；删除的无人调用接口（`POST /api/changes`、路由预览、技能矩阵写接口）同时缩小了写面——技能矩阵写接口原本会直接改插件目录里的 manifest。
- 依赖：不新增 npm 依赖，不升级锁定的 OpenSpec 1.6.0；归档仍调用本机已安装的 `openspec`。

```coverage
L1_api: filled -> §1 分支键、§3 dispatch 字段与 tenon assess、§4 tenon task finish / terminate、§6a 模块接口
L2_data: filled -> §1 工作流 YAML 分支键、§4 任务结果与归档目录、§5 快照兼容
L3_rules: filled -> §1a、§1b 离开条件与规则去留、§2 轻量轨道、§3 路由与评估规则
L4_state: filled -> §1a 执行模型与旧快照、§2 轻量轨道步骤与已升级、§4 任务结果
L5_errors: filled -> §1b Q10 一次列出全部失败与退出码 2、§3 assess 无阈值报错、§5 旧入口报错与替代提示
L6_security: filled -> §6b 安全与依赖
L7_perf: filled -> §4 已结束列表只读摘要与缓存、§6 快照基准 p95
L8_deps: filled -> §6b 不新增依赖、不升级 OpenSpec
L10_terms: filled -> CONTEXT.md「Workflows, tracks and task lifecycle」
```

### 7. 不在本任务内（后续任务）

- **任务 2：文档机制重做**（用户原话要点）：不要提前定义每一步的输入与输出文档——产出必须是技能自己的要求（技能按它自己的 SKILL.md 写什么就是什么），Tenon 只记录实际产出与来源技能，不规定「哪个技能必须交哪份文档」。反例：现行 default 契约规定调研步的 `adr` 由 brainstorming 产出，而 brainstorming 只写设计文档、ADR 是 domain-modeling 的职责，且设计文档与 ADR 两份模板几乎重复。不再在每一步事先登记要哪些文档、输入哪些、输出哪些；每一步的产出在运行时登记后，作为后续步骤的输入；按「渐进式披露」只把直接上游的产出交给下一步，防止 token 过大；交给下一步的输入**必须全部读完**（保留读取回执）。门禁只保留按路径的「必须产出」；文档约束与 OpenSpec 解耦，支持 Spec Kit 这类自定义规范；Dashboard 每一步的输入输出改为显示真实发生的产出。产品、前端、后端三个轨道在本任务内暂保留现有文档契约。
- **任务 3：测试设置简化**（在任务 2 之后）。
- 已知不足：任务状态目录仍在 `openspec/changes/` 下，不用 OpenSpec 的项目也会出现 `openspec/` 目录；本任务不迁移。

## 备选方案

- 保留 standard / simple 为独立工作流（现状）：轻重与领域分在两层，用户分不清；否决。
- 升级时原地切换轨道：体验更顺，但要重新冻结快照、迁移步骤状态；复杂度与风险高，否决（OpenSpec 官方对范围爆炸也建议新开变更）。
- 不走 OpenSpec 的任务目录：升级 OpenSpec 到 ≥ 1.7.0 并写 `skip_specs` 标记（要改锁定依赖，旧版 CLI 的项目仍会失败）；只改本仓库校验脚本过滤（只修好本仓库）；移到 `.` 开头目录或 `openspec/changes/` 之外（路径写死处太多）。均否决，选择统一移进 `archive/`。
- 按「修复 / 新增」等关键词直接进轻量：用户否决，要求先评估改动范围。
- 保留「对话」「自由」：「自由」的中立入口在轨道并入工作流后已无必要，「对话」的 7 步分支无用；用户确认删除。
- 「搁置」分类：用户否决，只保留「终止」。
- 轨道级布尔 `openspec`：任务 2 会扩展为规范选择，直接用 `spec: openspec | none` 避免二次改格式。
- 文档机制重做放进本任务：一个规格装不下，拆为任务 2。

## 风险

- 冻结快照自足性：若 `status` / `transition` 仍有回读当前工作流或登记表的路径，删除模板后在途任务会失败；需用测试覆盖 standard / simple / 对话 / 自由的在途任务各走一步。
- 路由行为变化面大：`tools/test-hooks.sh` 有大量路由夹具，迁移时不得降低 fail-closed 与零解释器要求。
- 轨道级 `spec` 进入工作流指纹：只在新键出现时改变序列化，需测试旧指纹不变。
- `governed-lifecycle-policy.ts` 按步骤 id 隐式套用 default 的 guard：改成轨道级后其作用范围要随 `spec` 精确界定。
- 列出 `archive/` 的性能：归档会持续增长，必须只读摘要并缓存。
- 环境：本任务在独立 worktree 中执行；不运行 `tenon setup --from-source`（会改全机共用的运行时），验证一律用 worktree 内构建与隔离 HOME。
