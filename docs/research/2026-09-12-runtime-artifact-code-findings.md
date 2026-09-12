# 执行期产物登记、版本消费与 UI 分层：代码事实

日期：2026-09-12。调查范围是当前 checkout 中的 hook、文档登记、上下文压缩、调度失效和对应 UI 接口；未执行样本 skill，未修改运行时代码，未新增或切换 Trellis task。当前分支为 `codex/autonomous-loop-v1`，存在大量并行脏文件；以下位置以本次读取的工作区内容为准，不是发布状态证明。

## 1. 最重要的结论

1. 当前仓库已经有“文档路径 + 内容摘要 + 生产者 + 当前阶段读取回执”的基础，但它针对有限的治理文档类型，不是任意 skill 的通用产物注册中心。
2. 已有 native Skill PostToolUse 只证明技能加载/调用开始。不能把该 hook 当成业务完成；当前自动登记入口存在这个时机混淆，最终治理检查仍有独立的完整生产证据检查。
3. 已有摘要、全文、引用三种上下文物化形式，以及按内容变化使读取证据过期的机制。可以扩展成执行前的产物目录，但尚不能声称所有 runtime 已自动获得这个目录。
4. 目前 workflow 编辑页展示的是定义推导的字段/文档槽位；运行页把同样槽位与当前文档快照拼接。因此任意未声明的执行产物不会自然出现在运行页。
5. 适合用户新边界的最小方向：编辑页配置阶段关系和结果继承策略；执行时宿主观察真实变化并形成版本；阶段开始生成可用产物目录；实际读取记录精确版本；运行页独立展示发现、接纳、消费和失效。

## 2. Hook 与登记：哪些是事实，哪些不能推导

### 已有 native hook

- `hooks/skill-tracker.sh:52-70` 只识别 Skill、Agent/Task 或符合条件的 SKILL.md 读取命令，不是所有文件写入的通用观察器。
- `hooks/skill-tracker.sh:101-110` 明确写明 native Skill PostToolUse 是 governed skill application 的开始，绑定宿主 session、tool use 和当前 StepVisit；裸 history 不能制造完成态。
- `packages/kernel/src/skill-invocation/document-confirmation.ts:216-278` 实际发布的是 `invocation-started`，包括 run 和 transition sequence 对应的 canonical visit。
- `packages/cli/src/nativeSkillReceipt.ts:36-51` 随后调用 `autoRegisterDocuments`；这里“完成态证据已齐”的注释与上述真实事件语义不一致。

### 自动登记具体会做什么

- `packages/kernel/src/documents/auto-register.ts:38-41` 候选仅来自当前阶段 outputs/mutable 文档槽位，并要求生产者匹配。
- `packages/kernel/src/documents/auto-register.ts:54-71` 只探查规范路径，文件存在且与台账 digest 不一致才调用 `recordDocument`。
- `packages/kernel/src/documents/document-paths.ts:10-13,28-49` 路径来自生成的 presentation registry，可展开 change 与 capability；不会发现任意新 skill 写出的任意文件。
- `packages/kernel/src/documents/document-recording.ts:84-98` 校验历史与精确当前生产者回执，再写文档台账。

### 时机与归属上的实际缺口

当前入口没有“本次 invocation 开始前的内容基线”，因此规范路径上一个未登记的既有文件，也可能被登记到本次生产者名下。根据函数调用链，自动入口只写文档台账，未调用 CLI 显式登记路径中的 canonical application 完成与绑定流程。

不能据此断言旧文件已经通过全部完成门禁：`packages/kernel/src/state/document-evidence.ts:274-297` 还会核对精确 application/artifact 证据；缺失时呈现 stale。正确结论是自动登记可能产生不完整/时机不正确的台账记录，不是“现有系统已经可靠完成自动交付”。

显式登记路径位于 `packages/cli/src/commands/document.ts:247-273`：登记文档后挑出唯一 canonical record，再调用 `recordCanonicalDocumentSkillInvocation`。后者在 `packages/kernel/src/skill-invocation/document-producer.ts:150-175` 发布完成、绑定意图和验证后的绑定。

**推荐接入点**：新增宿主文件操作观察适配器，在成功的写入/编辑工具后记录候选变化。保留上述 Skill hook 作为调用身份起点。阶段结束、暂停、失败和重连时，对本次受管资源做一次对账。观察事件和最终接纳必须使用不同事件，不复用“Skill 已读”表示“文件已交付”。

这项推荐是新增设计，不是当前已经存在的能力。

## 3. 当前变更检测与旧证据过期

### 已实现

`packages/kernel/src/state/document-ledger.ts:41-62` 定义：

- 文档：kind、path、sha256、producer、recordedAt、producerInvocation、reads。
- 读取回执：phase、sha256、readAt、可选 visitId。

`document-ledger.ts:299-319` 按命名槽位替换记录：内容 digest 没变时保留 reads，变了就清空 reads。它保存每个槽位当前状态，**没有保存该槽位全部历史内容版本**。

`document-ledger.ts:386-429` 在登记读取时重新读取文件、比对摘要，然后写入 phase + 当前 visit + digest 回执。文件被修改但没重新登记时直接拒绝。

`packages/kernel/src/state/document-evidence.ts:265-311` 现场检查当前文件 hash、生产证据及当前 visit 的读取回执，分别呈现 stale/unread/recorded。

`packages/kernel/src/task-scheduler/read-model.ts:48-53,96-110` 已有 work-item 上游 output digest 改变时让 validation/下游结果 invalidated 的派生逻辑；其输入是 attempt 中已经提供的 input_digests/output_digest，不能替代文件观察器。

### 通用化还缺什么

- 产物身份应与路径分离，路径可移动，同路径可多版本。
- 当前内容 digest 只能检测变化，不能让消费者重新获取旧版本。需要不可变内容存储或可验证的版本引用。
- 新增、修改、删除、重命名分别处理；不能把删除当作空文件新版本。
- 并行共享工作区中，文件路径 + 时间相近不能证明是谁写的。必须由受管工具上下文/进程沙箱/明确资源所有权归属，或把来源标记为不确定。推荐默认按 stage attempt 归属，只有精确调用关联存在时再细化到 skill invocation。
- 快照扫描发现的历史已有文件要与本次新产出区分；其他用户或其他 agent 的修改不能自动领到当前节点名下。
- 验证结果要绑定内容版本和规则版本。内容变化使对应检查过期，不应把无关文件变化放大成所有 stage 必须重跑。
- `recordDocumentReads` 是 CLI 登记消费的协议回执，不能证明模型语义上理解了内容；渐进披露的目录送达与正文实际读取也必须区分。

## 4. 下游上下文：已有接缝与限制

`packages/kernel/src/compress/ledger-context-bundle.ts` 提供主要接缝：

- `51-52`：proposal、tasks、delta-spec 采用全文，其余采用摘要。
- `117-124`：target 必须是 canonical phase，所需 kind 来自静态 `readsRequiredForPhase`。
- `162-182`：按需要的 kind 从账本选出记录。
- `266-295`：先校验实际内容 hash 与登记 hash，再产生带 digest 的引用/摘要/全文。
- `310-320`：超过预算返回可解释错误，不静默伪装缺失证据。

已核对的公开使用入口：

- `packages/cli/src/commands/handoff.ts:126-138` 的 `--bundle` 分支生成 JSON。
- `packages/server/src/contextBundlePreview.ts:143` 调用有受控读取端口的编译器，供预览。
- 在本次限定搜索范围内，没有发现所有自动执行入口统一调用上述 compiler 的证据。`packages/automation/src/admission/execution-preparation.ts:338-345` 当前固化的是 skill bundle 与可选 stepPrompt，适合作为新增 artifact context 引用的接缝。

**推荐**：保留低成本确定性目录，然后按需展开，而不是每次让模型解析所有技能或重读所有文件。

1. stage 启动时计算允许访问的上游产物视图：上游完成的 attempt、接纳版本、类型、大小、简短标题和来源。
2. 将目录以固定 envelope/schema 注入运行时；schema 定义目录结构，不由发现文件去修改 workflow 定义。
3. 必需的上游变更通知以独立小节显示，不能因摘要预算被截断。
4. 只在请求摘要或正文时加载对应内容，并登记消费的 artifact/version/digest；摘要缓存键包含内容 digest 与摘要器版本。
5. 运行中的消费者固定已绑定版本。上游新版本先产生 changed/stale 通知；默认在安全的阶段边界重新绑定，而不是静默改变正在执行的输入。

## 5. 当前 UI 数据路径

### Workflow 定义编辑页

- `packages/dashboard-app/src/workbench/useWorkflowEditor.ts:243-280` 请求 workflow 定义，接收后端 effectiveIo，未保存草稿使用前端近似推导。
- `packages/dashboard-app/src/workflow/StageEditorPane.tsx:47-100` 明确输入/输出由定义推导，构造的是字段/文档槽位表。
- `StageEditorPane.tsx:139-160` 将这些槽位显示为输入、技能、输出分区。
- `packages/dashboard-app/src/api/governanceClient.ts:240-241` 明确 effectiveIo 是读投影，不写进定义 DTO。

### 运行页

- `packages/dashboard-app/src/api/snapshotClient.ts:5-21,41-70` 通过 `/api/snapshot` 和 `/api/stream` 获取与订阅运行快照。
- `packages/server/src/snapshot.ts:131-163` 从当前 workflow document policy 产生文档证据快照；无该 policy 时 items 为空。
- `packages/dashboard-app/src/workspace/TaskDetailPane.tsx:38-46` 仍从 workflow definition 取槽位，再与 change 快照拼接实际文件。
- `packages/dashboard-app/src/workspace/stageIo.ts:34-44` 每个 document slot 只取匹配 kind 的首路径，不能完整展示多文件集合及历史版本。
- `packages/dashboard-app/src/workspace/DocumentDrawer.tsx:35` 点开文件后再读正文，可复用为渐进披露式预览。

### 推荐 UI 边界

编辑页：展示阶段顺序、skill、上下游可见范围、更新后的处理策略；“承接上游已接纳产物”可以是默认，不要求用户逐文件配置。显式治理文档契约可以保留在高级配置；没有声明时不要显示“无输出”作为错误。

运行页：直接查询运行时产物视图，不依赖静态 slots 才展示文件。每个阶段显示“可用上游资料、实际已读取版本、本阶段发现的文件、已接纳交付、待处理更新”。设计草稿中的 stage 不存在实际 run artifact，因此不展示假文件清单。

## 6. 现有通用结果 schema 也应复用，但不能过度信任

`packages/kernel/src/orchestration/v2-types.ts:239` 已定义 file/diff/document/json/text/url/report/value/unknown 等产物类型。`packages/automation/src/orchestration/runtime-v2-boundary.ts:127-160` 可归一化工具回传的 artifacts envelope。

但该归一化函数在没有 digest 时使用 `digest(ref)`（`135`），这只是引用字符串摘要，不是文件内容摘要。通用产物版本库必须由宿主读取稳定内容得到真实内容 hash；不能把这个 fallback 当作内容变化证据。工具自报 schema/type/digest 都要保留来源及验证状态。

`packages/kernel/src/skill-invocation/domain.ts:119-150` 的 artifact binding 只允许在 invocation-completed 之后，且必须满足声明输出与验证器。因此执行中发现/草稿事件应有独立模型，不宜通过放宽现有绑定语义来凑实时预览。

## 7. 最小实施顺序（建议，未实施）

1. 建立宿主归属与候选事件：stage attempt、tool call、资源路径、前后内容摘要、事件 id。先覆盖受管写入/编辑工具，阶段结束对账补缺；未知来源显式标记。
2. 增加版本与状态视图：observed / candidate / accepted / superseded / deleted 等可组合事实，不把“被观察”误判成“交付成功”。复用文档证据路径和 v2 结果 envelope。
3. 从已接纳版本构建阶段上下文目录；固定 schema + 动态记录，版本消费回执与检查失效沿用现有 digest 逻辑扩展。
4. 运行页切到该产物视图与流更新；编辑页收敛为编排和继承策略，不触发模型解析 I/O。
5. 后续再扩外部系统产物、批量集合、专用格式检查；不以解析所有 SKILL.md 作为前置条件。

必须验证的行为：未写文件的 skill 加载不产生交付；同路径变更产生新版本且旧检查过期；并行节点不互领文件；断线补账不会重复或漏记；用户手工改文件不冒充某 skill 产出；下游运行中不会静默换版本；普通自由 workflow 可配置并运行而不需要输入输出 schema。
