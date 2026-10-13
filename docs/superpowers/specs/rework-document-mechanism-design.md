# 技术设计：文档机制重做——运行时观察步骤产出，只交接直接上游

## 背景

现状（2026-10-12，origin/main `f474225f`，已含 consolidate-workflow-tracks）：

- **预定义契约**：`templates/workflows/default.yaml` 的产品、前端、后端分支各有一份 `document_contract`（`slots` 规定每个 kind 由哪一步、哪个技能产出，`reads` 规定每一步读哪些 kind），三份内容相同；另有步骤级 `inputs` / `outputs`（字段通道）与 `artifacts`（`design_doc`、`plan`、`verification_report` 字段由 `tenon artifact register` 登记），`file-exists` 守卫检查字段里的路径。`design-system.yaml` 有一份 `design-md` 契约。
- **契约编译进快照**：`documentGovernancePolicy()`（`packages/kernel/src/workflow/document-contract.ts:80`）只要分支 `spec: openspec` 就返回策略；`planFromIr()`（`effective-plan-build.ts:95`）把它冻结进 `.pipeline-workflow-plan.json`，`capabilities.documents.governed = (policy !== undefined)`。
- **运行时账本**：`.pipeline-documents.json`，每 kind 一条记录；`tenon document record` 要求本次步骤访问里有该产出技能的宿主确认（`.pipeline-skill-confirmations.jsonl`）；`tenon document read` 写绑定步骤访问与精确摘要的读取回执；`evaluateDocumentEvidence()` 在转换（`transition-application.ts:140`）与 `status` / `check`（`step-exit-report.ts`）两处拦截；必需技能要等它在契约里绑定的文档登记后才算完成（`skill-document-binding.ts`）。
- **错误契约**：调研步规定 `adr` 由 brainstorming 产出。调研确认（researcher 报告 §2）：vendored brainstorming 只在架构路径写 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`，整个 SKILL.md 没有 ADR；ADR 由 domain-modeling 按「难回退、脱离上下文会意外、真实取舍」三条件写到 `docs/adr/`；verification-before-completion、grilling、codebase-design 都不写文件。
- **累积读取**：`reads` 手写且逐步累积，实现步要读 8 类文档。
- **绑死 OpenSpec**：kind 目录、`openspec-v1` 账本、只许 `openspec/` 与 `docs/` 路径（`state/document-path.ts`）、`tenon init` 铺 OpenSpec 骨架（`state/default-openspec-scaffold.ts`）。
- **Dashboard**：工作台 `workspace/stageIo.ts` 只显示契约槽位对应的账本记录（每槽一条路径）；工作流页 `workflow/StageEditorPane.tsx` 用 `IoTable` 显示并编辑契约（`workbench/documentContractEdits.ts`），数据来自 `effective-io.ts` 的 `materializeWorkflowIo()`。
- **已有的可用部件**：步骤访问身份 `{run_id, transition_sequence}`；技能加载由 PostToolUse hook 写入 `.pipeline-skill-invocations.jsonl`（`invocation-started` 事件带步骤访问与秒级 `recorded_at`）；`workspace/changed-files.ts` 已用 git 列改动文件；AFK 的 `packages/automation/src/artifact-runtime/stage-runtime.ts` 有一套「开始拍基线、结束比较、来源记 unknown、只看上游」的产出谱系。
- **2026-09-15 删掉的 hook 自动登记**（`a05a1ce3` 加、`f4a9c88c` 删）：在 Skill 的 PostToolUse 里按规范路径登记文档。失败在时机：PostToolUse 在技能内容载入时就触发，此时技能的工作还没开始，结果把 `tenon init` 的骨架记成技能产出、并提前关闭了技能调用。researcher 报告 §3 确认：Claude Code 与 Codex 都没有任何「技能工作结束」的事件。

## 目标与成功标准

用户定下的原则（不改）：

1. 不提前定义每一步的输入、输出文档；产出就是技能按自己 SKILL.md 写出的东西；Tenon 只记录实际产出与来源技能。
2. 删除 adr←brainstorming 这类契约。
3. 每一步的产出在运行时登记，作为后续步骤的输入；按渐进式披露只交给下一步直接上游的产出；交给下一步的输入必须全部读完，读取回执照旧保留，没读完不能离开这一步。
4. 门禁只保留按路径的「必须产出」；文档约束与 OpenSpec 解耦，要能支持 Spec Kit 这类自定义规范。
5. Dashboard：工作台每一步的输入、输出显示真实发生的产出；工作流页不再有手写的输入输出表。
6. 在途任务（旧快照、旧文档契约）照旧走完。

成功标准即提案的「可验证结果」：`default.yaml` 不再列输入输出文档；新任务每次离开步骤都记下实际新增 / 修改 / 删除的文件与来源技能；下一步 `read-documents` 只列直接上游产出、没读完不能前进；契约不再绑 OpenSpec；Dashboard 显示真实产出；旧快照任务走完、新的轻量与后端任务各走完一遍。

## 方案比较

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 技能声明产出 | 给技能加产出元数据，Tenon 照声明收 | 否决：技能多是第三方的，无法标注；仍是预定义 |
| B. hook 里登记 | Skill 的 PostToolUse 或某个写文件 hook 里登记 | 否决：PostToolUse 在载入时触发（9-15 已踩坑）；按写文件工具登记又看不到 Bash 与子代理的写入（Claude Code 自己的 checkpointing 也有这个盲区，researcher 报告 §4.1） |
| C. 转换时观察（推荐） | 进入步骤记 git 检查点，离开步骤时比较；hook 只提供技能加载时间用于来源标注 | 采纳：与写入方式无关，覆盖 Bash、子代理、技能自己的写入；在离开步骤这一个确定时刻发生 |

方案 C 里检查点的做法再比两种：全量遍历哈希（AFK 运行时的做法）要读全仓文件、不认 `.gitignore`、基线只在单进程内存里；基于 git（推荐）只哈希相对 HEAD 有改动的文件，天然尊重忽略规则，检查点很小可以持久化。

## 决策

### 1. 术语

- **步骤访问**：一次进入到离开某个步骤的过程，身份 `{run_id, transition_sequence}`，每次转换递增。
- **检查点**：步骤访问开始时的工作区状态——git HEAD 与相对 HEAD 有改动的文件（含未跟踪、不含被忽略）及其内容摘要。
- **步骤产出**：一次步骤访问里内容发生变化的文件（新增 / 修改 / 删除），每条带来源技能或「未知」。
- **交接输入**：直接上游那次步骤访问产出的文档；当前步骤必须读完。
- **必须产出**：步骤用路径模式声明的门禁；本任务里这一步产出过匹配的文件才能离开。
- **观察模式 / 契约模式**：冻结快照里没有文档契约的任务（新任务）走观察模式；带契约的旧快照走契约模式，行为不变。

### 2. 产出账本

- 文件：`openspec/changes/<change>/.pipeline-step-outputs.json`（`.pipeline-` 前缀，是 Tenon 状态，随任务目录提交与归档）。
- 结构（v1）：`{ version: 1, visits: [ { run_id, sequence, step, entered_at, checkpoint, exit, outputs, reads } ] }`
  - `checkpoint`：`{ head: <sha|null>, files: { <path>: <sha256|null> } }`，只有当前访问保留，离开后清空。
  - `exit`：`{ event, to, at, observation: observed | unavailable | truncated }`，未离开时为 `null`。
  - `outputs`：`[{ path, change: added | modified | deleted, sha256 | null, skill | null }]`，按路径排序，上限 2000 条，超出记 `truncated`。
  - `reads`：`[{ path, sha256, read_at }]`。
- 只在任务锁内经 kernel 读写，原子替换；上限 512 次访问、4 MiB。

### 3. 检查点与比较

- 采集：`git rev-parse --verify HEAD`；`git --no-optional-locks status --porcelain=v1 -z --untracked-files=all --no-renames` 得到相对 HEAD 的改动路径（`--no-optional-locks` 避免刷新索引时与用户的 git 操作抢锁，researcher 报告 §4.2）；对每个改动路径记当前内容的 sha256，已删除记 `null`。改动路径超过 20000 条记 `truncated`。
- 比较（离开时）：候选路径 = 进入检查点的改动路径 ∪ 当前改动路径 ∪ HEAD 移动带来的路径。每个候选路径的「之前」取进入检查点里的摘要，没有就取进入时 HEAD 里的内容摘要；「之后」同理取当前。前后不同即为产出：之前没有是新增，之后没有是删除，否则是修改。
- HEAD 移动（提交、rebase、merge）：带来的路径用 `git log --format= --name-only -z --no-renames <进入 HEAD>..<当前 HEAD> --not <上游引用>` 取得，只算本任务自己的提交。上游引用取 `refs/remotes/origin/HEAD`，以及当前分支的 `@{upstream}`（它与当前分支同名时不算，避免把推送过的本任务提交当成上游）。这样 rebase 到最新 origin/main 时，别人合并的改动不会被算成本步产出。
- 不观察：任何一段以 `.pipeline` 开头的路径；首段为 `.git`、`.tenon`、`.claude`、`.agents`、`.codex`、`.superpowers`、`.worktrees`、`.turbo` 的路径；任何一段为 `node_modules`；`.github/hooks/`；`openspec/.gitignore`（Tenon 生成）；`openspec/changes/` 下不属于本任务目录的路径（其他任务与归档）；本任务目录下直接的点文件（`.breadcrumb`、`.openspec.yaml` 等）。被 `.gitignore` 忽略的文件本来就不出现。
- 非 git 目录或 git 命令失败：`observation: unavailable`，不记产出，不阻断转换。

### 4. 来源标注

- 读本次步骤访问的 `invocation-started` 事件（技能 id + `recorded_at`），排除编排技能 `tenon` 本身。
- 对每个新增或修改的产出取文件当前的修改时间，来源 = 本次访问里加载时间不晚于它的最后一个技能（按秒比较，因为 `recorded_at` 只到秒）；没有这样的技能记 `null`，显示为「未知」。删除的产出记「未知」。
- hook 不登记任何产出，只提供加载时间；观察发生在转换时，避开 9-15 的时机问题。

### 5. 交接输入与读取回执

- 直接上游 = 同一 run 里 `sequence` 比当前小 1 的那次访问（转入当前步骤的那次）。第一步没有输入。
- 交接输入 = 直接上游的产出里，新增或修改、且是文档（扩展名 `.md`、`.mdx`、`.markdown`）、当前仍存在的文件。代码等其他文件照样记为产出并在 Dashboard 显示，但不要求下一步读。
- `tenon document read <change> all`（或给一个输入路径）对当前内容取 sha256，写进当前访问的 `reads`。
- 一个输入算读过：当前访问里有它的回执，且回执摘要等于上游记下的摘要或文件当前的摘要（读过上游版本后本步再改它，回执仍有效；改动会成为本步产出）。
- 离开这一步的所有边（前进、完成、回退）都要求全部读完，只有放弃边（终止任务）不要求。契约模式回退边不查文档，是为了避免文档变了要重新登记时卡死；观察模式读取永远做得到（回执接受当前内容，已删除的输入不列入），没有这个死锁。缺回执的阻断：`source: document`、`code: input-unread`、`subject: <path>`，提示里点名上游步骤与修复命令。

### 6. 必须产出守卫

- YAML：`{ type: required-output, path: <模式> }`，可写在步骤 `guards` 或边的 `guards` 上，支持 `when`。
- 模式：项目相对 POSIX 路径；`{change}` 替换为任务名；`*` 匹配一段内的任意字符，`**` 匹配任意多段，`?` 匹配一个字符。校验拒绝空串、绝对路径、`..` 与未知占位符。
- 满足条件：观察可用时，本 run 里这一步的某次访问（已离开的访问来自账本，当前访问来自实时比较）产出过匹配的新增或修改文件，且该文件现在存在；观察不可用（非 git、`truncated`）时退化为存在匹配的文件。
- 失败提示：「本步须产出匹配 `<路径>` 的文件，本任务里这一步还没有写出」。

### 7. 内建工作流

- `default.yaml`：删除 `pm` / `frontend` / `backend` 的 `document_contract`，删除所有步骤的 `inputs` / `outputs` / `artifacts`。守卫替换为：
  - 产品、前端、后端的立项：`required-output openspec/changes/{change}/proposal.md`。
  - 调研：`file-exists design_doc` → `required-output docs/superpowers/specs/*.md`。
  - 规格：`required-output openspec/changes/{change}/specs/*/spec.md`；前端、后端另加 `required-output docs/superpowers/plans/*.md`（替代 `file-exists plan` 与 `track_not_in: [pm]`）。
  - 验证 `verify-pass` 边：`file-exists verification_report` → `required-output docs/superpowers/reports/{change}-verify.md`。
  - 轻量轨道：只删 `inputs` / `outputs`，不加必须产出。
- `design-system.yaml`：删除 `design-md` 契约与顶层 `openspec: true`（它只为契约而设；收尾改由 Tenon 直接移目录，结果相同）；方向步加 `required-output design/direction.md`，生成步加 `required-output DESIGN.md`；提示词里「`tenon artifact register` / `tenon document record` 登记」的句子删掉。前端交付步提示词里登记 `design-md` 的句子同样删掉。
- `build_sha`、`pr_url`、`prd_path` 等状态字段不受影响：`freeze-build-sha` / `build-head-unchanged` / `field-nonempty` 已显式写在 YAML 里。
- 重新生成 `default-workflow.generated.ts`（`npm run generate:default-workflow`）。

### 8. 工作流 YAML 键

- 校验（保存、建任务、编译新计划时）拒绝：顶层或分支的 `document_contract`；非空的步骤 `artifacts`、`inputs`、`outputs`。报错给替代写法：文档门禁写 `required-output`，字段门禁写 `field-nonempty` 等。
- 空列表 `inputs: []` / `outputs: []` / `artifacts: []` 照收不报错（Dashboard 以前保存的文件都带它们），序列化不再写出。
- 解析器仍能读这些键进 IR，IR 字段保留：冻结快照与测试夹具要表示旧定义；快照恢复不重新校验。
- 由 `build_sha` 的 `inputs` / `outputs` 推断修订生命周期（`semanticRevisionLifecyclePolicy`）只对旧 IR 生效；新的自定义工作流要显式写 `freeze-build-sha` 与 `build-head-unchanged`（与 `default.yaml` 一致）。
- `gate: auto` 以前由 `outputs` 推导「输出齐全」守卫（`auto-gate.ts`）；`outputs` 删除后，自动门禁 = 离开条件全部满足。`default.yaml` 的 `pr_url` / `prd_path` 已显式写成守卫，不丢检查；`nonempty-output` 守卫依赖 `outputs`，新定义里一并拒绝并提示改用 `field-nonempty` 或 `required-output`。
- `effective-io.ts` 只留给编排图（旧计划的文档流与 OpenSpec 技能注入，属于画布，并行任务 unify-stage-skill-canvas 在改）：工作流 API 不再返回 `effectiveIo` / `branches[].effectiveIo`，任务编排接口的 `io` 换成按真实产出算的 `stepIo`；新计划没有契约与字段 IO，编排图里自然没有文档流。

### 9. 新旧分流

- `documentGovernancePolicy()` 只在分支声明了 `documentContract` 时返回策略；新计划没有策略。
- `capabilities.documents` 改为 `{ governed, mode, profile?, policy? }`：`governed` = 分支 `spec: openspec`（只表示走 OpenSpec 生命周期：breadcrumb、规格校验与应用、`spec-migration-applied`、`openspec archive` 收尾），`mode` = 有策略为 `contract`，否则 `observed`。旧快照恢复后有策略、`governed` 仍为真，行为不变。
- 固定生命周期（`governed-lifecycle-policy.ts`）里引用文档字段的 `file-exists plan` / `file-exists verification_report` 只在契约模式注入；实现前评审、冻结与校验 build 修订、验证标记、`spec-migration-applied` 照旧按 `governed` 注入。
- 契约模式的全部代码路径（账本、骨架、登记、按 kind 读取、`pending_documents`、`editable`、`register-field`）不改，只服务旧快照。
- 没有冻结快照、绑定了 `legacy-full` 的更早任务会按当前定义重算计划：当前 `default` 已没有契约，为它们挂上冻结的 `openspec-v1` 表（`LEGACY_DOCUMENT_GOVERNANCE_POLICY`）；指纹对不上时照旧失败关闭。
- 旧契约派生的几处 `next` 判定在观察模式改由 YAML 推出：本步「负责 delta spec」（发 `validate-spec`）= 走 OpenSpec 且本步有指向 `openspec/changes/{change}/specs/` 的必须产出；本步「负责应用规格」（发 `apply-spec`）= 走 OpenSpec 且本步离开条件含 `spec-migration-applied`；测试配置提示的「计划步」= 走 OpenSpec 且本步 `test_policy.plan` 为 required。
- `tenon init` 新任务：不建文档账本、不铺 proposal / design 骨架、不写文档语言文件；`spec: openspec` 的分支照旧铺 `tasks.md`（Tenon 的 Todo 来源，`tasks-through-step` 按步骤标题判定）；在任务锁内写第一次访问的检查点。
- 转换（CLI 与 Dashboard 服务端共用 kernel 用例）：所有门禁通过之后、提交之前，在同一把锁里比较得到本次访问的产出、写离开记录与下一次访问的检查点（按访问身份幂等覆盖：提交若失败，重试会重写同一条）。

### 10. CLI

- `tenon status --json` 观察模式的 `step.documents`：`{ mode: "observed", observation, inputs: [{ path, from_step, skill, status: read | unread }], outputs: [{ path, change, skill }], required: [{ path, status: produced | missing }] }`。契约模式保持 `{ reads, records, updates }` 并加 `mode: "contract"`。
- 观察模式的 `next` 只发 `read-documents`（`documents` 为未读输入，`note` 说明可以改、改动记为本步产出），位置与现在相同（`load-tenon` 之后最先）；不发 `scaffold-document` / `record-document` / `register-field`。必须产出没满足时走现有的 `fix`（出口阻断）。
- `tenon document read`、`tenon document status` 两种模式都支持；`document scaffold` / `record` / `migrate-delta` / `init` 在观察模式退出码 2，提示「本任务的产出由 Tenon 在离开步骤时自动记录，该命令只服务升级前创建的任务」；`tenon artifact register` 仍按冻结步骤是否声明 artifact 判定（新定义没有 artifact，自然拒绝，文案同上）。
- `tenon step run` 照旧批量做 `read-documents`。
- 测试报告动作（追溯矩阵写进验证报告）在观察模式取当前步骤前进边上唯一不含通配符的必须产出路径作为报告路径；契约模式照旧取 `verification-report` 记录。只改取路径这一处，不改测试体系语义。
- `tenon check --event verify-fail` 在观察模式不再要求 `verification_report` 字段，改为要求本次验证访问产出了验证步前进边声明的必须产出。
- 上下文包（`compress/ledger-context-bundle*`）在观察模式用当前访问的交接输入。

### 11. Dashboard

- 服务端 `stepIo(change)`：`Record<step, { inputs: IoFile[], outputs: IoFile[] }>`，`IoFile = { path, change?, skill, fromStep?, read? }`。观察模式取每个步骤最近一次访问（当前步骤用实时比较）；契约模式把旧账本映射成同一形状（记录按归属步骤进 `outputs`、来源技能为登记的 producer；读取表进 `inputs` 并带已读状态）。
- 工作台：输入行显示「路径 · 来自<步骤> · <技能 | 未知> · 已读 / 未读」，输出行显示「路径 · 新增 / 修改 / 删除 · <技能 | 未知>」；没有时显示「本步还没有产出」「本步没有输入」。删除按契约槽位兜底的 `fallbackStepIo`。
- 工作流页：删除输入、输出两个 `IoTable` 段与文档契约编辑（`documentContractEdits.ts`、`useStageMutations` 的三个方法、草稿 IO 计算）；门禁段列出 `required-output`（「必须产出 `<路径>`」）。
- 与并行任务 unify-stage-skill-canvas 避让：不碰画布文件（`OrchestrationFlow`、`SkillFlow`、`StageFlowSection` 等）；`StageEditorPane.tsx` 只改输入输出两段。

### 12. 技能与文档

- `skills/tenon/SKILL.md`：`read-documents` 行改为观察模式口径（输入是直接上游的文档产出，读完再 `tenon document read <c> all`，本步可以改，改动记为本步产出）；`scaffold-document` / `record-document` / `register-field` 行标为「只出现在升级前创建的任务」；「上游技能怎么用」改为：技能按自己的 SKILL.md 写文件，Tenon 在离开步骤时自动记录，必须产出由出口阻断提示。不动测试相关的动作行。
- `CONTEXT.md` 新增术语（由 domain-modeling 写）；`docs/usage/` 中英文的文档与证据、自定义工作流、CLI 参考、默认工作流、Dashboard 页；`docs/CONTRACT.md`；发布说明。

### 13. 不直接复用 AFK 产出运行时

`StageArtifactRuntime` 的模型（基线、比较、来源 unknown、只看上游）与本设计一致，但运行时本身不适合交互式步骤：基线只存在单个进程的内存里，而交互式步骤跨越多个命令进程；它全量遍历哈希、不认 `.gitignore`；AFK 只观察任务目录；状态文件每次整份重写并复制全部内容。所以复用模型、在 kernel 新写基于 git 的检查点；AFK 改用它不在本任务内。

### 14. Spec Kit 支持

不做专门适配：观察、交接、读取回执与必须产出不认识任何规范。用一个 Spec Kit 风格的平铺自定义工作流做测试夹具（researcher 报告 §1：`specs/<NNN-短名>/spec.md`、`plan.md`、`tasks.md` 是各命令必写的稳定产出；命令名在不同 agent 上不同，所以只按路径断言）：步骤 specify → plan → tasks → implement，`spec: none`，必须产出 `specs/*/spec.md`、`specs/*/plan.md`、`specs/*/tasks.md`。

## 交互技能里的问题（按推荐作答）

用户授权全程按推荐执行，以下问题均按推荐确定：

1. 代码文件要不要交给下一步读？——不要。只交文档（Markdown）；代码照样记为产出、在 Dashboard 显示，由评审者与 diff 覆盖。全交会让验证步读几十个源文件，违背防止 token 过大。
2. 「文档」的判定要不要做成工作流可配置？——不要，固定为 `.md` / `.mdx` / `.markdown`（YAGNI）。
3. 回退边要不要求读完输入？——要，「没读完不能离开这一步」对所有离开的边成立，只有终止任务的放弃边例外；观察模式没有契约模式那种重新登记的死锁。
4. 非 git 项目怎么办？——不观察，必须产出退化为存在检查。
5. 来源对不上怎么办？——记「未知」，不猜。
6. 更早的步骤产出要不要也交给下一步？——不要，只交直接上游；技能需要更早的文档时自己去读，不强制。
7. 必须产出按什么口径满足？——本任务里这一步任一次访问产出过、且文件仍在；回到这一步时不要求重写。
8. 观察记录什么时候写？——转换的锁内、提交之前，按访问身份幂等。
9. 编排技能 `tenon` 算不算来源？——不算。
10. 自定义工作流里的旧键怎么办？——报错给替代写法；空列表照收。
11. 新任务还铺 proposal / design 骨架吗？——不铺，`tasks.md` 保留。
12. Dashboard 当前步骤要不要实时显示产出？——要，按选中的任务实时比较，不进全局快照轮询。
13. 本步改了读过的输入怎么办？——读过上游版本的回执仍有效，改动成为本步产出。
14. AFK 产出运行时要不要直接复用？——不直接复用，见决策 13。
15. CONTEXT.md 这类每次就地更新的累积文件算什么？——按内容比较，已存在就是修改；被交给下一步时下一步读当前全文。
16. brainstorming 走 Spike / Bounded 路径不写文档时调研步怎么办？——产出为空是正常的；但 default 的调研步要求设计文档，这时出口阻断会提示写出设计文档。
17. 前端轨道「立项前项目 DESIGN.md 必须就绪」怎么办？——它来自旧契约的 `role: require` 槽，是预先规定的输入，随契约一起退出新任务；立项前置检查（`design-system/precondition.ts`、`infrastructure/design-precondition.ts` 与 CLI 的接线）因此只剩死代码，一并删除。DESIGN.md 的有效性仍由前端交付步的必需测试 `design-system`（`tenon design validate`）把关；旧快照任务不受影响。这是用户可见的行为变化，写进发布说明。

### 拷问补充（grilling 一轮，按推荐作答）

1. **当前访问没有检查点**（升级前创建、快照里没有契约的在途任务，如轻量轨道或不走 OpenSpec 的自定义工作流）：本次访问记 `observation: unavailable`、没有交接输入、不阻断；下一次转换照常写检查点，观察从下一步恢复。旧快照里的 `artifacts` 与 `file-exists` 守卫照旧生效，`tenon artifact register` 是否可用仍只看冻结的步骤有没有声明 artifact（不按模式一刀切）；`document scaffold` / `record` 照旧只在有契约时可用，只改报错文案。
2. **符号链接与子模块**：符号链接按链接目标字符串取摘要，不跟随；目录项（子模块、嵌套仓库）不观察。
3. **大文件**：流式取 sha256，不设单文件上限；改动路径总数上限 20000 已兜底。
4. **账本增长**：最多保留最近 512 次访问，超出丢最旧的已离开访问。
5. **并发**：转换与 `document read` 都在任务锁内写账本；`status` / Dashboard 只读，不加锁。
6. **`tenon step run`**：观察模式照旧批量执行 `read-documents`。
7. **Codex 的技能加载**：转换先过技能门禁（门禁会把 Codex 的待对账回执写进调用事件），再做观察，所以来源标注能看到 Codex 加载的技能。
8. **Dashboard 刷新**：快照指纹把 `.pipeline-step-outputs.json` 纳入，产出与回执变化会触发刷新；归档后账本随任务目录移动，「已结束」详情照样显示真实产出。
9. **build 修订指纹**：工作区指纹不含 `openspec/`，验证步写读取回执不会让 build 修订失效。
10. **防篡改**：账本与旧账本同级，不新增受保护写入；仍遵守「状态只经 tenon 命令写」的约定。
11. **性能**：转换与 `status` 各多一次 `git status` 与改动文件哈希；git 失败一律降级为 `unavailable`，不阻断。
12. **文案**：新增的 CLI 文案走现有中英文消息目录。

## 模块与接缝

按 codebase-design 审过一遍（删除测试、接口即测试面、一个适配器只是假想接缝）：

- **深模块 `packages/kernel/src/documents/step-outputs.ts`**：调用方只需要五个入口——
  - `startStepVisit(ctx)`：写某次访问的检查点（`tenon init` 与转换调用）。
  - `recordStepExit(ctx, exit)`：比较、标注来源、写离开记录并开始下一次访问（转换调用）。
  - `recordInputReads(ctx, paths | 'all')`：写读取回执（`tenon document read` 调用）。
  - `readStepOutputs(ctx, { live })`：只读视图——当前访问的观察状态、交接输入（含已读）、产出预览，以及每个步骤最近一次访问的输入输出与「这一步产出过的路径」（`status`、`check`、转换门禁、必须产出守卫、Dashboard 共用）。
  - `matchesOutputPattern(pattern, change, path)`：纯函数。
  检查点比较、HEAD 移动与上游引用、排除规则、来源标注、文档判定、账本结构与上限都藏在实现里。
- **内部接缝**（不从 kernel 公共出口导出，只给本模块自己的测试用）：`workspace/step-checkpoint.ts`（git 检查点采集与比较，依赖 git 子进程与文件系统，测试用临时 git 仓库，不用替身）；`state/step-output-ledger.ts`（账本读写）。账本单独看是浅模块，删掉它复杂度会回到 step-outputs 里，所以作为内部实现而不是对外接口。
- **转换不新增依赖注入**：`transition-application.ts` 在观察模式直接调用 `readStepOutputs` 判定输入是否读完、调用 `recordStepExit` 记录。只有一个实现，加注入点只是假想接缝；直接调用还保证 CLI 与 Dashboard 服务端两条转换路径不会漏接。git 不可用时降级为 `unavailable`，kernel 的转换测试不受影响。
- **守卫能力**：`required-output` 照通用离开条件的写法，从 `GuardInput` 取能力；能力在 kernel 构造守卫输入时由任务目录生成（与 `tasks-through-step` 相同），未注入时失败关闭。
- **单一分流点**：`capabilities.documents.mode`。`step-exit-report.ts`、`transition-application.ts`、CLI 的 `statusStepParts` / `statusStepNext` / `document` 命令与服务端 `stepIo` 都只按它分流：契约模式走现有 `evaluateDocumentEvidence()` 与旧动作，观察模式走 `readStepOutputs()`。

## 测试

- kernel 单测（临时 git 仓库）：新增 / 修改 / 删除；忽略规则与排除规则；HEAD 移动时只算本任务提交（模拟 rebase 到新上游）；非 git 为 `unavailable`；来源标注（加载时间早于 / 晚于修改时间、同秒、没有技能）；交接只取直接上游且只取文档；读取回执两种摘要；必须产出模式匹配与满足条件；校验拒绝旧键、空列表照收；内建工作流没有契约与输入输出。
- CLI 集成：新后端任务从立项走到完结（每步离开都有产出记录、下一步 `read-documents` 只列直接上游、未读完前进被拒、必须产出缺失被拒）；新轻量任务走完；旧快照（带契约）任务按旧账本与旧动作走完；Spec Kit 风格工作流的观察与必须产出；观察模式下旧命令退出码 2。
- server / Dashboard 单测：`stepIo` 两种模式；工作台输入输出渲染；工作流页没有输入输出表、门禁段列出必须产出。
- 既有覆盖契约行为的测试改用旧快照夹具，继续覆盖契约模式。

## 风险

- 同一检出里并行的其他会话改动的文件会被算进本步产出：靠 worktree 与「不观察其他任务目录」缓解，剩余的如实标「未知」。
- 来源标注依赖修改时间：同一秒内无法区分；`git checkout` / rebase 重写文件会刷新修改时间（researcher 报告 §5），只能尽力而为。
- 上游引用推断（`origin/HEAD`、`@{upstream}`）在少见的分支布局下可能把上游改动算进来；结果只影响显示与交接，不影响门禁的正确性。
- 转换多了一次 git 比较（数百毫秒级）；`status` 实时预览同理，需要上限与失败降级。
- 新旧分流点要少：只有 `capabilities.documents.mode` 一个开关，否则容易误伤在途任务。
- 与并行任务冲突：`default.yaml`、`skills/tenon/SKILL.md`、`statusStep*`、文档只改本任务相关段落；生成物用脚本重新生成。
- 验证步代码规模上限（新增 ≤ 2000 行）大概率超出，需要按约定申请测试豁免、由用户批准。

## 覆盖

本任务运行在升级前冻结的快照上，它的规格步要求设计文档带覆盖块（新的 default 已删除这条检查）：

```coverage
touches: api, data, rules, state, errors, security, perf, deps, terms
L1_api: filled -> §10 CLI（status JSON、document 命令、退出码）、§11 Dashboard（stepIo 接口）
L2_data: filled -> §2 产出账本（结构、上限、原子写）
L3_rules: filled -> §4 来源标注、§5 交接与读取回执、§6 必须产出守卫
L4_state: filled -> §9 新旧分流（mode、governed、在途任务）
L5_errors: filled -> §3 git 失败降级为 unavailable、§8 旧键报错与替代、拷问补充 1
L6_security: filled -> §3 排除 Tenon 状态与宿主目录、§6 路径模式校验（拒绝绝对路径与 ..）、§11 不返回摘要与绝对路径
L7_perf: filled -> 拷问补充 3、11（流式哈希、路径上限、git 比较的耗时）
L8_deps: filled -> 不新增依赖；git CLI 为既有受控外部依赖（§3）
L10_terms: filled -> CONTEXT.md「Step outputs and handoff」
```

## 备选方案（已否决）

- 技能声明产出、hook 里登记、全量遍历哈希检查点：见「方案比较」。
- 把代码也交给下一步：token 过大。
- 下一步读取全部上游累计产出：违背渐进式披露。
- 保留 `document_contract` 作为可选高级功能：等于保留预定义契约，违背原则 1、2。
- 观察只看 `docs/` 与 `openspec/`：Spec Kit 写在 `specs/`、domain-modeling 写根目录 `CONTEXT.md`，按目录限定会漏。
