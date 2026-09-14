# Workflow 节点契约方案：反证审查与最小闭环

日期：2026-09-11。范围：对候选设计做静态反证，不实施业务代码、不执行样本 Skill、不新建或切换 外部任务工具 task。样本沿用 [真实 Skill 抽样](/Users/a1234/Documents/code-manager/projects/tenon-local/docs/research/2026-09-11-skill-io-sample-audit.md)，复读 code-review、pdf、external-brainstorm、tenon-open 相关原文。源码包含并行未提交修改；不代表安装中的插件或运行中宿主已具备相同能力。

**建议采纳“契约属于受管理任务节点，Skill 是执行方法”，但必须把“自动产生正确契约”和“运行时强制已知契约”分开。** 前者仍需任务事实、复用模板、准备步骤与必要的人类决策；后者可以通过受控发布、验证、版本绑定实现。把 Markdown 改成 YAML、把 Skill I/O 字段移到 workflow 中，都不足以解决用户的问题。

## 1. 反证清单

### R1：只把 I/O 的编写工作移给 workflow 作者，并没有自动化

**反例。** PDF Skill 同时支持阅读、创建、编辑、填写；数量和操作模式来自本次请求，不能从 Skill 名推导。Code-review 的结果是双轴回复，原文并未要求 `review.md`。下游如果要求一个报告路径，系统还要提供把回复持久化的适配器，不能假装原 Skill 本来就产文件。

**决定性证据。** [PDF:17](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:17)要求按本次请求调整 count/mode；[PDF:147](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:147)区分 Q&A/no-op 与 create/edit；[code-review:76](/Users/a1234/.agents/skills/code-review/SKILL.md:76)只规定回复结构。

**必要修正。** 由系统提供少量操作模板与确定性 resolver：例如“审查代码→结构化双轴报告”“读取 PDF→回答及来源引用”“生成 PDF→指定数量的最终文件”“需求发现→PRD 草稿及未决问题”。Workflow 作者提供业务目标、结果消费者和少量例外，系统从已知参数、项目惯例、上游结果和 Skill 声明补齐。每个补齐字段记录来源：用户要求、模板、静态声明、观察事实、待确认推断。无法确定的业务语义必须保留未知，不能编造文件名、数量、通过条件。

**设计边界。** 这减少重复配置，不消除业务定义成本。系统能自动检查“是否有两份有效 PDF”，不能仅凭 schema 证明“两份内容都符合用户真正意图”。不要许诺自动提取覆盖率或成本，本次没有测量。

### R2：Discovery 节点需要先产出 acceptance，若先要求完整 acceptance 才运行会死锁

**反例。** Brainstorm 的工作就是通过研究和多轮回答收敛目标、范围、验收；未知参数并非安装时读漏了。一个计划编译器若要求最终 acceptance 才肯启动 brainstorm，就依赖尚未运行的结果。

**决定性证据。** [external-brainstorm:44](/Users/a1234/Documents/code-manager/projects/tenon-local/.agents/skills/external-brainstorm/SKILL.md:44)反复更新 PRD、直到未知收敛；[external-brainstorm:129](/Users/a1234/Documents/code-manager/projects/tenon-local/.agents/skills/external-brainstorm/SKILL.md:129)才要求 acceptance 可观察、blocking questions 为空。轻量任务与复杂任务的文件要求不同（同文件 138、168–170 行）。

**必要修正。** 采用分阶段准备。Discovery 只冻结阶段性结果类型、允许资源、问题预算/退出条件，例如 PRD 草稿、已知事实、未决问题、已作决策；允许产生 `waiting-input`，不得用未知最终答案填一份假完整契约。未来 build 只有在需求被接纳后才准备其具体 acceptance。Bootstrap/发现不是“不受约束”，只是受不同阶段的有限契约约束。

### R3：tenon-open 创建 run，而 invocation 绑定要求 run 先存在，存在身份循环

**反例。** 让任意节点执行前必须绑定 canonical run，但把 `tenon init` 仍藏在第一个被管理 Skill 内，就无法记录该 Skill 的首次执行。借旧 active change 或事后补一个开始事件会制造错误归属。

**决定性证据。** [tenon-open:78](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:78)、[tenon-open:152](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:152)规定先 init/activate，再读下级 Skill；[invocation repository:88](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/repository.ts:88)要求已有 canonical WorkflowRun/Step identity，缺失即拒绝。

**必要修正。** 把创建并绑定运行壳作为受控 bootstrap 命令的职责，记录 bootstrap 自己的 request/operation identity；成功返回 canonical run 后才创建第一个节点 attempt。Bootstrap 只创建必要壳，不把骨架文件标为业务验收完成。若没有创建任务的授权，保留请求态即可；不得为了满足机制偷偷创建任务或借用旧任务。

### R4：把所有可能结果并成必交集合，会使条件分支永远无法通过

**反例。** PDF read-only 不应该产新 PDF；交互表单和扁平表单的验收条件互斥；brainstorm 轻量任务不必生成 design/implement；tenon-open 的短自定义 workflow 不套用默认三文档。另一方面，code-review 找不到 spec 不自动等于“Spec 检查不适用”：原文要求先查找、必要时询问。

**决定性证据。** [PDF:36](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:36)、[PDF:77](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:77)给出不同表单模式；[tenon-open:195](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:195)按文档契约选择 slot；[code-review:25](/Users/a1234/.agents/skills/code-review/SKILL.md:25)规定 spec 查找及无 spec 分支。

**必要修正。** 先选择本次 operation variant，再实例化该分支的 outputs/validators。结果可以是文件、原文件的新版本、结构化值、持久化的回复。`no-op` 只有契约允许且有事实依据时才成功；样本 code-review 的空 diff 按原文是准备失败，不应被通用 no-op 默认值改写。分支仍未知则继续准备或进入等待输入，不以 missing input 冒充 N/A。

### R5：一节点多 Skill 不等于现有 runtime 支持多个并发 SkillRun 共享节点

**反例。** tenon-open 调度 openspec-propose 写文档；code-review 先串行准备，再并行 Standards/Spec，最后聚合。如果每个 Skill 都被标为该节点的唯一 producer/完成主体，会提前完成、重复统计或把子代理产物算给加载 Skill 的代理。只把 selected_skill_id 改成数组也没有解决领取、重试、聚合等语义。

**决定性证据。** [code-review:58](/Users/a1234/.agents/skills/code-review/SKILL.md:58)及 76–80 行定义分支与聚合；[tenon-open:197](/Users/a1234/Documents/code-manager/projects/tenon-local/skills/tenon-open/SKILL.md:197)指定真实 producer 为 openspec-propose；[WorkItemV2:181](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/orchestration/v2-types.ts:181)只有 `selected_skill_id`、`active_run_id`，同文件 209–227 行的 SkillRun 也绑定单一 skill；[runtime-v2-scheduler:4](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/runtime-v2-scheduler.ts:4)使用 `.find()` 取该 WorkItem 的第一个 binding。

**必要修正。** 初版一个节点只有一个 coordinator execution/attempt；多 Skill 是该次执行的使用/贡献关系，不各自宣称节点完成。独立调度、并发、重试的子任务按现有 WorkItems + group/dependency 拆开，聚合者消费各子结果并负责节点验收。关系至少区分 owner WorkItem、实际执行 actor/子 attempt、使用的 Skill coordinate、输出 slot。不要把“观察到读取了 Skill”自动转换成真实业务执行或 producer 证明。

### R6：同一个模型同时生成要求、结果和通过声明，会形成自证循环

**反例。** 模型漏掉“表单保持交互”要求，再生成一份扁平 PDF，并为它选择“页面可渲染”检查，全部 schema 都能通过。或者 code-review 把 Spec 缺失解释成“不需要 Spec”，删掉原本 mandatory lane。Runtime 强制执行的只是错误计划。

**决定性证据。** PDF 明确“视觉正常不证明逻辑字段正确”（[PDF:34](/Users/a1234/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md:34)、77 行）；当前 TaskPlan validation 只验证 requirement/acceptance 引用、依赖与 validator-output 引用一致性：[validation.ts:281](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/task-plan/validation.ts:281)、313–324 行。覆盖关系存在并不证明自然语言要求被正确理解。

**必要修正。** 需求与验收保留可追溯来源；受信模板定义必需验证器，模型只能提出待审的条件选择。模板/下游要求与选中 Skill 的限制冲突时显式报 conflict，不静默以较弱一方覆盖。结构/文件完整性由代码判断，内容质量由有范围和版本的 reviewer/validator 判断；required 检查不可被同次执行自行删除。三轴分开记录 applicability、capability availability、verdict，未知或工具不可用不是 N/A。

### R7：同名文件和“最新成功结果”会污染重试、动态分支及并发读者

**反例。** 第一次 attempt 仍写 proposal.md，第二次 attempt 已开始；旧 attempt 迟到登记覆盖新结果。上游重新规划输出 v2，下游一半消费 v1、一半消费当前路径。两个 skill 操作不同命名 slot，实际指向同一个物理路径，也不能真正并行。

**决定性证据。** 现有 document ledger 按 slot 替换当前记录：[document-ledger.ts:299](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/document-ledger.ts:299)。V2 依赖读取会寻找该 WorkItem 最新 completed run：[runtime-v2-scheduler.ts:8](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/runtime-v2-scheduler.ts:8)。已有 task-plan publication 的 expected revision 和 immutable lineage 可复用：[task-plan-store.ts:381](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/task-plan-store.ts:381)。这些证据显示需要版本绑定，不表示本次复现了数据污染。

**必要修正。** Bound execution 固定 `plan_revision + work_item + attempt + input artifact versions/digests + contract digest`。发布携带 expected slot version 和幂等键，旧 attempt 没有新版本写权；下游在准备时选择已接纳的明确结果版本，不在执行中反复查 latest。并发资源按实际路径/逻辑资源判断，不能只按 Skill 名或 slot 名。实际写文件不受控制时，仅登记 CAS 不能撤销此前污染；严格并发隔离还要受控 writer 或 attempt 隔离目录。

### R8：末尾统一提交能验收，但仍无法满足“运行中能看到产物”

**反例。** 一个 coordinator 工作二十分钟，最后提交一次，即使 I/O 定义完美，前十九分钟 UI 仍不知道已有草稿。若 publish 与 accepted 共用一个状态，又会让下游读取半成品。

**决定性证据。** 当前 invocation 的 artifact intent 强制在 completed 后出现：[domain.ts:119](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/domain.ts:119)。这不是把 owner 改成 WorkItem 就能自动解除的限制。

**必要修正。** 最小协议必须包含执行中的显式 `publish(slot, version, ref/digest, draft)`，最后再 submit + validate + accept。运行中 draft 可以看，只有 accepted 版本能满足依赖。推荐把这类生命周期绑定到节点 attempt，保留 Skill usage 为 provenance；不要给同一次 Skill 的每个文件补造另一个 started/completed 来绕过旧事件模型。持久化事件成功后再通知 UI，重连以 cursor 补齐。

### R9：JIT 的“可准备”不能被误说成所有宿主都“可强制拦截”

**反例。** 模型已经读过某 Skill，此后在同一上下文里继续操作，没有新的加载事件。某宿主只提供 PostToolUse；即便之后发现违规，外部副作用可能已发生。未知 Skill 首次分析发现需要另一 Skill，若没有边界，又会无限扩展准备树。

**决定性证据。** 当前 preflight 能拦原生 Skill 和识别到的命令读取，但 node/bundle 缺失与内部异常 fail-open：[gate.sh:314](/Users/a1234/Documents/code-manager/projects/tenon-local/hooks/gate.sh:314)、[internalSkillGate.ts:317](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/internalSkillGate.ts:317)。当前 Pi adapter 只注册 SessionStart/PostToolUse：[Pi settings:4](/Users/a1234/Documents/code-manager/projects/tenon-local/adapters/pi/settings.json:4)。这只能证明本仓声明的能力，不证明具体宿主运行时覆盖率。

**必要修正。** 强制入口是 coordinator execution 的 prepare/start 和受管 publish/accept，而不是 Skill 文件读取事件。未知方法按需提取有限 metadata，遇到递归依赖做 cycle 检查并受深度/数量预算约束；缓存键含内容 digest、解析器/模板版本。新增方法若影响输出义务、资源或权限，创建新计划修订并重新准备相关节点；无影响则增加 contribution 记录即可。不可拦截宿主明确标为 observed，可拒绝其产物成为 accepted 或阻止后续执行，不宣称能追溯阻止已经发生的行为。

## 2. 怎样避免把负担转移给作者

采用“系统维护操作模板，运行时补值，作者只表达差异”，不要要求每份 workflow 手写完整 schema。

| 信息 | 默认提供者 | 何时冻结 | 决定不了时 |
|---|---|---|---|
| 业务目标、不能违反的要求 | 用户请求/已接纳需求 | 相应节点准备前；discovery 只冻结阶段目标 | 保留未决要求，不猜未来答案 |
| 结果类型、默认字段和验证器 | 少量版本化操作模板 | 编译 effective contract | 选择通用 typed result，降低自动验收等级 |
| 必需数量、模式、现有文件范围 | 本次参数 + 受控探查 | 有副作用的 start 前 | 必要的用户问题或先执行 discovery |
| project/change/path、输入版本 | 项目惯例 + canonical binding | 本次 attempt 准备时 | 定位失败明确阻断绑定 |
| Skill 能提供什么、依赖什么 | 受信声明/adapter；未知来源做有出处的候选提取 | 首次引用按内容 digest 解析 | unknown，不能由模型自称 enforceable |
| 下游是否要求文件/特定字段 | 消费端口声明 | 边连接与兼容性检查时 | 系统插入有契约的转换节点，或报不兼容 |
| 实际产生的内容、物理版本 | 执行器显式 publish，runtime 测 digest | 发布时 | 仅 observed，不宣称自动发现全部产出 |

自动化的价值在于复用、派生和反馈错误，而不是推测用户尚未表达的意图。首次未知领域可能仍需要一次业务说明；一旦做成稳定模板，后续同类 workflow 不应重复填同样 I/O。不要为每个 Skill 各维护一套 schema：优先复用“操作/结果类型”的 schema，再让 Skill adapter 说明自己的兼容范围。

## 3. 推荐的最小闭环

### 3.1 先只选一个现有 canonical WorkItem 的受管执行入口

复用 [WorkItemV1:62](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/task-plan/types.ts:62)已有 requirement_refs、acceptance_refs、expected_outputs、validators、resource_claims；不要新增另一份权威 TaskPlan。当前 ExpectedOutput 只有 id/kind/ref，TaskValidator 只有 kind/version/output_ids（同文件 49–60 行），承载不了所有动态条件，所以通过明确版本升级添加节点契约；实例里的 bound contract 是该 revision 的不可变快照，不是另一处可任意编辑的计划。

初版一节点一个 coordinator attempt。多 Skill 仅贡献关系；需独立调度的部分拆已有 WorkItems，不重造一套 Skill 内嵌调度系统。现有 V2 单绑定 runtime 不能直接声称支持任意多 Skill 并发。

### 3.2 五步协议

1. **prepare**：用任务目标/所选操作模板生成候选槽位；探查必要事实、解析方法 metadata、绑定 exact inputs；得到 `prepared | waiting-input | blocked`。无需为了准备普通节点先把全部未来 workflow 完全实例化。
2. **start**：核验 plan revision、inputs、contract digest、权限及宿主能力；分配 attempt 与资源。Bootstrap 在此之前创建 canonical run 壳。只在已验证可拦截的受控入口宣称执行前强约束。
3. **publish**：执行器可反复提交文件、文件版本或结构化回复；runtime 分配 artifact version、校验身份和内容 digest、持久化 draft 事件，然后更新 UI。回复的存储由 adapter 完成，不把存储文件倒推成 Skill 的交付义务。
4. **submit / validate**：提交本次结果集合；系统按 frozen contract 决定哪些检查 applicable，按 verifier 能力记录 unavailable/unknown，执行结构校验及需要的领域验收。部分失败只重试受影响子节点/attempt，不删除已经有效的无关结果。
5. **accept**：所有必需槽位和检查满足才产生 accepted receipt；原子地选中 accepted artifact versions。下游用 receipt + versions 重新 prepare。缺输入、N/A、验证失败和宿主不可用都有不同状态，不能都叫 completed。

### 3.3 第一个落地切片

先覆盖 **一个文档结果节点 + 两个顺序子任务/消费者**：第一个 coordinator 可使用任意已绑定的方法生成文档，运行中发布草稿；第二个消费者只能读 accepted 精确版本。第一轮仅支持 `file/document` 与 `value/message` 两种结果载体、固定数量槽位和少量确定性 validators；动态数量在 prepare 后冻结。Discovery 用一个明确的阶段性结果模板，复杂分支后续分阶段绑定，不先建设全能 schema 推理器。

实现接缝：

- 定义/修订：现有 canonical [WorkItem 类型:62](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/task-plan/types.ts:62)、[outputs/validators codec:316](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/task-plan/codec.ts:316)、[引用校验:281](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/task-plan/validation.ts:281)、[CAS publication:381](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/task-plan-store.ts:381)。
- 执行准备：CLI 的 [AFK preparation 组装:200](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/afk-executor.ts:200)是已存在的具体接缝，增添 bound node contract；同处 locator/内容 digest 只负责方法身份，不升级为业务验收证据。普通宿主另需接通受管理 coordinator 命令，不能由这一处能力推广为所有宿主已接线。
- 产物：收口一个节点级 publish/submit/accept 应用用例，文档路径和非文件结果共用；可参照现有 [invocation append/lock:446](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/repository.ts:446)的身份、幂等和落盘边界，但旧事件模型须明确升级。现有 [recordDocument:84](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/documents/document-recording.ts:84)转为兼容投影接缝，不再由多处各自推断完成。
- 可见性：持久事件先写入，再推送 UI；复用 [V2 SSE cursor/replay:250](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/serverOrchestrationV2Routes.ts:250)的模式，把这条切片实际接到页面；这里建议复用模式，不代表两个不同 ledger 已互通。仅暴露 GET API 不算实时链路交付。

这些是设计接入建议，不是当前代码已经完成的能力。没有把实施范围扩展到本会话其他任务，也没有要求首次就迁移所有历史 workflow/Skill。

## 4. 闭环是否成立的五个最小验收

1. **不增加无谓配置**：请求“审查这段变更”自动得到双轴值结果契约，不要求作者手写 review.md；PDF 阅读不得出现必交新 PDF 的红灯。
2. **准备不会自锁**：没有 run 时 bootstrap 能返回新 run；brainstorm 能发布含未决问题的 PRD 草稿，build 仍不能在验收未接纳时开始。
3. **看见草稿不等于放行**：长任务 publish 后，UI 在配置的延迟预算内显示 draft；消费者在 accept 前被挡，accept 后取得同一 artifact 的确切版本。
4. **贡献不篡改所有权**：同一 coordinator 使用两个 Skill，节点仍只有一个完成主体；独立 child WorkItems 各有 attempt，聚合必须等必需子结果，不因读过所有 SKILL.md 而完成。
5. **重试/断线保持一致**：迟到旧 attempt 无权覆盖新 slot version；重复 publish 幂等；UI reconnect 无漏事件；validator 不可用不变成 N/A；observed 宿主不能获得 strict 标识。
