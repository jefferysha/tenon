# Skill 输入输出契约与实时产出物：Koishi、Cordis、DeepSeek Harness 调研

调研日期：2026-09-11。范围：官方文档、公开源码与 Tenon 当前工作区的静态阅读。本文是调研及改造建议，没有实施运行时代码，也没有把静态发现作为已复现的线上故障。

**当前方案入口（2026-09-12 更新）：**用户明确编排 UI 只负责操作，不与模型协商文件 I/O。当前推荐为[执行期产物登记、内容版本与消费关系、按需上下文读取](/Users/a1234/Documents/code-manager/projects/tenon-local/docs/research/2026-09-12-runtime-artifact-lineage-and-workflow-ui.md)。该报告替代本文第 6、8、9 节及此前节点契约方案中要求编排时准备文件 I/O 的部分；以下保留来源和历史推导，不应作为当前实现规格。

用户早期补充的要求是：每个 skill 尚未执行时，工作流 UI 就能展示它的输入、预期输出和检查规则。对应的历史方案见第 8 节；这一 UI 前提现已被上述 2026-09-12 边界调整替代。

第二次补充明确了开放技能生态的前提：技能可能在新建 workflow 或执行途中才被选中，且未必定义 I/O。第 9 节给出按需发现、分级分析、预算、并发与宿主可观察性边界；安装 skill 不默认触发模型解析，任意技能的完整 I/O 不能被保证提前推断出来。

随后完整阅读 7 个真实 skill，发现输出还包括对话结果、既有文件变更、多轮更新、条件产文与嵌套 skill 的产物。具体证据和对前期简化假设的校正见[真实 Skill 抽样审计](/Users/a1234/Documents/code-manager/projects/tenon-local/docs/research/2026-09-11-skill-io-sample-audit.md)。本文后续的契约与调度结构均为设计建议，不能理解为这些现有 skill 已经提供完整 I/O，也不能把示例文件槽位无条件套到任意 skill 上。

## 1. 结论与问题拆解

要约束 skill 并在执行中获取产出物，需要把四件事分开实现：**声明契约、运行时校验、产出物登记、可恢复的事件传输**。增加 SKILL.md 中的输入输出描述，只覆盖第一件事的一部分。

Agent Skills 当前规范定义了名称、描述、兼容性、metadata、实验性的 allowed-tools，以及 Markdown 指令；没有统一的业务 inputSchema、outputSchema、产出物提交或完成验收协议。metadata 可以指向自定义契约，但需要宿主解释和执行。[Agent Skills 规范](https://agentskills.io/specification)

本文使用以下区分：

| 对象 | 具体含义 | 能保证什么 |
| --- | --- | --- |
| Skill 指令 | 告诉模型怎样完成任务的说明书 | 提供行为引导，不能单独保证交付 |
| Tool 契约 | 一次程序调用的参数与返回值 | 执行入口和出口可运行校验 |
| SkillRun 契约 | 一次有身份、状态、输入快照的技能执行 | 明确何时开始、如何重试、何时允许成功 |
| Artifact 契约 | 有身份、版本、来源和内容的产出物 | 能获取、检查和绑定到具体执行 |
| 事件协议 | 把状态与产出物变化传给消费者 | 及时可见；重连可靠性取决于持久化、游标和补读 |

最重要的约束边界是：**模型可以尝试提交；只有宿主验证通过，才接受产出物或完成状态。** 这能保证“不合格结果不被系统接纳”，不能保证模型每次都成功完成任务。

## 2. DeepSeek Harness：最接近你的执行契约问题

对象已确认是官方开源项目 deepseek-ai/deepseek-harness。源码快照：`c291e7961a515f6d7af9304e7fd1d257929aef26`；此次读取的 tools 包版本为 `0.1.5-rc.2`。它仍在开发者预览阶段，本文使用固定提交链接，避免把未来主干变化混进结论。[官方仓库](https://github.com/deepseek-ai/deepseek-harness)

### 2.1 一个工具定义同时承载输入、输出与展示

工具作者用 defineTool 声明 parameters、output.schema、output.render 和 execute。输入 schema 被编译为 JSON Schema，并在调用 execute 前校验；因此参数提示与执行校验可以来自同一份声明。[defineTool 实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/schema.ts#L566-L588)

输出也有真正的执行出口：createSuccessResult 对返回值做 JSON 快照、按 output.schema 校验、冻结，然后调用 render 生成面向模型的内容。非法返回值产生 INVALID_TOOL_OUTPUT；后置插件替换业务 value 时，也会重新通过这个出口。因而可以保留供程序消费的 canonical value，再生成文字或展示数据。[输出执行边界](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/index.ts#L1754-L1812)

不能把它理解为支持完整 JSON Schema：当前自有校验器使用明确子集，包含 type、properties、required、additionalProperties、items、enum、const、oneOf；不支持的词汇会被拒绝。description 等注释字段不参与校验。[schema 子集](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/json-schema.ts#L20-L86)

**可借鉴点：**统一契约源、入口校验、出口校验、业务数据与展示投影分离。一个名为 schema_id 的字符串、TypeScript 接口或漂亮的结果卡片，都不能替代这些运行时检查。

### 2.2 子代理通过 structured_output 提交最终结果

这是最值得迁移到 SkillRun 的机制。对支持 outputSchema 的进程内子代理，宿主在其私有作用域注册 structured_output 工具，把目标结果 schema 放到工具参数中。模型调用这个工具时，宿主校验结果并暂存；只有最终 tools/result 成功才接纳。外层 run_code 失败时，内部暂存值也不会提前变成已接纳结果。提交之后的 guard 会阻止后续工具调用。[结构化提交实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent-in-process-driver/src/structured.ts#L49-L141)

如果子代理正常停止，却从未提交必需的结构化结果，driver 会把 completed 转成 error。这是程序执行的完成条件；仅在提示词里说“必须输出 JSON”没有这个效果。[缺少结果的结算逻辑](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent-in-process-driver/src/index.ts#L211-L237)

约束还有明确的宿主能力边界：共享服务先检查 provider.capabilities；请求了不支持的 outputSchema 会报 UNSUPPORTED_CAPABILITY。当前进程外 Codex、Claude Code、ACP 等适配器不能因此被视为拥有同样的结果约束。[能力检查](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/src/index.ts#L640-L657)、[进程外能力定义](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent/subagent/src/out-of-process.ts)

这里的暂存与接纳首先是**运行时结果的提交边界**，不能直接宣传为文件内容与数据库之间的持久化事务。

### 2.3 它的 skill loader 仍然只是加载技能说明

tool-skill 的 schema 约束的是加载结果：name、provider、resourceBase、content。execute 读取 skill 定义并返回内容，没有在这里执行技能业务，更没有为每个 Markdown skill 自动生成业务产出物契约。[skill loader 源码](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L81-L155)

因此，“Harness 的工具有 output schema”和“每个 skill 的业务输出都受到约束”是两条不同结论。要得到后者，需要把一次 skill 执行包进受管理的运行单元，或者显式提供 artifact.publish / skill.complete 之类的受校验提交入口。

### 2.4 实时观察与持久记录有不同语义

Session.append 为事件分配 seq，校验数据和下一条事件的合法性，写入内存日志，再发布 session/event。tool/call 与 tool/result 可以对应调用与结果。[Session 追加](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/index.ts#L720-L754)、[工具事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/types.ts#L337-L360)

持久化由另一层负责：事件序列连续且追加，flush 才是明确的持久化屏障。不能把“发出了事件”写成“断电后一定还在”。[持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/session/session-persistence/src/index.ts#L115-L133)

客户端 RemoteJournalStream 负责补页、重连追赶、去掉完整重复区间和修复缺口；普通转发通知没有自动重放保证。会话跟随还区分临时流式片段和已经结算的日志事件。这种分层适合参考，但不是开箱即用的“任意 skill 文件自动成为实时 artifact”。[Gateway 流契约](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/gateway/README.md#L50-L76)、[会话订阅](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/README.md#L29-L33)

## 3. Koishi 与 Cordis：插件基础设施的边界

研究快照：Koishi `5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde`；Cordis `f8ea3cd50f1a5724e8e715995bcde131c9c12b2c`。cordisjs/cordis 当前重定向到 cordiverse/cordis。

### 3.1 Koishi：配置、命令参数、消息返回分层

插件 Config 的 TypeScript 类型提供编辑期提示，Config Schema 对象在运行时校验配置、补默认值，并驱动控制台表单。缺失必填配置可以阻止插件启动。这是插件安装/启动配置，不能直接当成每次命令的输入输出。[Koishi 配置构型](https://koishi.chat/zh-CN/guide/plugin/schema)

命令调用另有真实的输入解析：参数类型对应 domain transform，number / integer 等会转换和检查字符串，错误进入 argv.error 并在 action 前返回。参数数量和未知选项检查有独立开关，当前默认关闭，不能泛称所有输入默认严格校验。[命令 domain](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/command/index.ts#L152-L183)、[执行入口及默认配置](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/command/command.ts#L271-L388)

命令 Action 返回可 await 的 void 或消息 Fragment，核心路径取非空返回值，随后由 session.execute 发送消息；审核过的 core command 路径没有按每个命令的业务 outputSchema 校验，也没有为文件产物登记身份与版本。这个结论不排除第三方插件自行实现这些能力。[Action 类型及返回路径](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/command/command.ts#L289-L325)、[消息发送](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/session.ts#L422-L433)

可借鉴的是统一入口、参数声明与解析、配置驱动 UI。文件交付的可信登记和实时追踪，需要增加业务层。

### 3.2 Cordis：运行时管配置、依赖、作用域和清理

当前 Cordis main 的插件 Config 使用 Standard Schema；resolveConfig 实际调用验证器，错误变成 ValidationError，并明确拒绝异步配置验证。apply 返回也有检查，但返回值被解释为 effect/disposer 等生命周期协议。因此准确表述是：Cordis 有配置与生命周期返回检查，没有自动替所有业务服务和事件安装 outputSchema。[配置校验](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/fiber.ts#L34-L46)、[effect 协议](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/fiber.ts#L229-L271)

Context 和 Events 接口主要提供 TypeScript 的服务/事件名称、参数和返回类型；运行时负责依赖是否可用、插件是否激活、监听器的作用域和卸载。dispatcher 直接调用 callback，没有自动对每个业务 payload/result 做 schema parse。[事件类型及实现](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/events.ts#L10-L151)、[依赖控制激活](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/fiber.ts#L371-L397)

当前 main 的几个分发方法容易被误读：

| 方法 | 真实语义 | 不能据此推断 |
| --- | --- | --- |
| emit | 同步调用，忽略返回，不等待异步任务 | 返回即代表文件已保存 |
| parallel | 等全部监听器结束、聚合错误，返回 void | 自动收集业务产出物 |
| serial / bail | 首个非 null / false / undefined 的值短路；前者 await | 所有阶段都执行的顺序工作流 |
| waterfall | next() 环绕下游执行 | 自动持久化或验证下游结果 |

0 和空字符串也会触发短路。监听器保存在内存，派发本身没有持久序号、历史补读、artifact hash 或崩溃恢复。[Cordis 事件源码](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/events.ts#L6-L151)

**版本差异必须保留：**本次 Koishi core 为 4.18.11，依赖 cordis ^3.18.1。Koishi 自己 deprecated 的 waterfall 是逐步把返回值传给下一监听器；当前 Cordis main 的同名方法是 next 环绕中间件。不能混用两套源码解释同一个版本。[Koishi 依赖](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/package.json#L36-L43)、[Koishi waterfall](https://github.com/koishijs/koishi/blob/5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde/packages/core/src/context.ts#L83-L95)

## 4. 其他业界方案解决了哪一部分

| 方案 | 已有机制 | 对 Tenon 的直接启发 | 仍需自己实现 |
| --- | --- | --- | --- |
| MCP Tools | inputSchema、可选 outputSchema、structuredContent、resource link | 用机器可读对象交付工具结果，文件作为资源引用 | skill 生命周期、文件真实性与版本、增量 artifact 提交 |
| A2A | Task、Artifact、TaskArtifactUpdateEvent、任务订阅 | 产出物拥有独立 ID，可以在任务未结束时更新 | 业务内容 schema、持久化实现、内部执行归属与验收 |
| PydanticAI | output_type、output_validator、ModelRetry | 结构校验后再做业务校验，返回明确错误供模型修正 | 文档产出物管理、跨进程事件可靠投递 |
| LangGraph | 节点状态、updates/custom 流、checkpoint | 显式发中间进度，保存可恢复的执行状态 | 自定义 artifact 类型、校验与专用登记协议 |

MCP 的 outputSchema 如果被提供，服务端 MUST 返回符合它的结构化结果，客户端 SHOULD 校验；它约束的是 server-produced structuredContent。progress 通知用于进度信息，不能据此认为客户端自动拿到了文件及其合法性证明。[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)

A2A 最贴近“运行中获取产出物”：Artifact 有 artifactId 和 parts，TaskArtifactUpdateEvent 带 taskId、contextId、artifact，以及 append / lastChunk。任务状态和产出更新分别传输。当前规范的订阅从 Task 快照开始，再发送后续变化；这提供协议结构，不能替代服务端数据库或任意历史事件重放。[A2A 产出物与流事件](https://a2a-protocol.org/latest/specification/#422-taskartifactupdateevent)

PydanticAI 可以把字段合法性之外的检查放进 output_validator，失败时用 ModelRetry 反馈。部分流式输出与最终输出需要区别验证，缺少尚未生成的字段不应立即等同最终失败。[PydanticAI 输出与验证](https://pydantic.dev/docs/ai/core-concepts/output/)

LangGraph 通过 get_stream_writer 和 custom 流显式发送中间数据，节点状态更新又是另一类事件。checkpoint 解决状态恢复；并不意味着每个自定义流片段都已经持久保存。[LangGraph Streaming](https://docs.langchain.com/oss/python/langgraph/streaming)、[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

## 5. Tenon 当前实现与断点

本地检查开始时 HEAD 为 `607d455`，分支为 codex/autonomous-loop-v1，有 112 项未提交变更。以下针对所读工作区源码；未验证安装版本、运行中 server 的 build、浏览器行为。现有 default-chat-contract-skills 任务属于其他改动，本轮未切换、实施或归档该任务。

### 5.1 已有基础，不是从零开始

| 路径 | 已有能力 | 本轮确认的边界 |
| --- | --- | --- |
| Skill Markdown 与工作流定义 | step 的 fields / documents / artifacts、producer 和依赖 | 普通 SkillRef 没有可执行的业务 I/O 签名 |
| host document flow | 宿主读取证据、canonical path、producer、digest、StepVisit | 仅覆盖受管文档，登记不代表内容语义验收 |
| invocation JSONL | 生命周期、schema_id、字段 digest、artifact intent/bound、AFK attempt | 主要记录证据，输出绑定发生在完成之后 |
| V2 execution runtime | 输入内容物化、output.json、validator、lease/retry、board replay | 仍等待 execute 返回；本轮未找到生产 CLI/server 直接启动入口 |

SkillRef 的字段是 id、kind、review_lane、depends_on；parser 拒绝其他键。现有 I/O proof 保存 schema_id 和字段 classification/digest/validator，没有业务值本体；codec 验证的是证据格式，没有在这里按 schema_id 解析业务 schema 并验证数据。[SkillRef 定义](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/types.ts:61)、[引用解析](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/parse-skill-refs.ts:28)、[证据类型](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/types.ts:65)、[证据 codec](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/codec.ts:123)

文档登记会检查阶段、producer、文件摘要和槽位；普通 artifact register 则更接近受声明约束的路径字段写入，不要求文件存在、也不持久化 producer。这两条路径不能都简称为“已验证产出物”。[文档登记](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/document-ledger.ts:232)、[普通 artifact 命令](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/artifact.ts:4)

### 5.2 三个最直接影响实时获取的断点

**断点一：模型只允许完成后绑定产出。** domain 明确要求 artifact-binding-intent 在 invocation-completed 之后，output_id 必须已存在于完成字段中，再进行一次绑定。当前事件集合没有运行中 artifact-created / updated / chunk。它适合最终证据登记，不足以承载同一次 skill 的多个草稿版本。[绑定前置条件](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/domain.ts:119)、[事件集合](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/skill-invocation/types.ts:165)

**断点二：技能加载时扫描一次，不等于后续产出持续登记。** hook 的注释把 Skill PostToolUse 定义为 application 开始；receipt 后立即 auto-register，只扫描 canonical 路径中当时已存在的文件，没有持续 watcher。若真实文件在模型后续执行时才写出，这次扫描可能看不到；这是代码顺序支持的推断，未做宿主复现。[hook 时机](/Users/a1234/Documents/code-manager/projects/tenon-local/hooks/skill-tracker.sh:101)、[receipt 后登记](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/nativeSkillReceipt.ts:29)、[扫描范围](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/documents/auto-register.ts:25)

**断点三：rich invocation 数据没有完整进入实时界面。** 主 SSE 的 fingerprint 覆盖 state、tasks.md、documents ledger 和 activity，不包括 invocation JSONL。独立 skillInvocationClient 只有 GET；本次搜索没有找到 Dashboard 组件调用 fetchSkillInvocations，只有定义与测试。旧 snapshot.skillRuns 仍从 history 推导 idle/running/done，不代表产出物通过验收。[刷新检测](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/snapshotFingerprint.ts:62)、[调用客户端](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/dashboard-app/src/api/skillInvocationClient.ts:177)、[旧状态投影](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/skillRuns.ts:89)

### 5.3 登记一致性也需要收进统一入口

自动文档登记调用 recordDocument；显式 document CLI 还会调用 recordCanonicalDocumentSkillInvocation。因此 document ledger 中出现一份文件，不能保证 invocation ledger 同时完成 bound 记录。[自动登记入口](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/nativeSkillReceipt.ts:40)、[显式登记入口](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/document.ts:247)

静态检查还发现：自动路径没有覆盖整个登记过程的外层 Change lock，而 document ledger 要求调用者持锁并执行读改写；显式路径则存在先更新文档账本、再追加 invocation 事件的跨文件窗口。这些是后续需要复现的并发/崩溃一致性风险，本轮不能声称已经造成数据丢失。[调用锁边界](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/nativeSkillReceipt.ts:29)、[ledger 调用契约](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/document-ledger.ts:1)

### 5.4 V2 可以复用，但不能当成已接通的现状

V2 executor 接口是 Promise<unknown>，runtime await 完成后才 normalize、persist 和生成 output artifact；validator 是独立可选端口，缺乏有效验证会阻断后续。它已有比纯 prompt 更好的输入物化和完成验收基础，但尚无统一执行中 publish 端口。[executor 端口](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/runtime-v2.ts:49)、[结果处理](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/runtime-v2.ts:336)、[输入物化](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/input-materialization-v2.ts:192)

V2 board SSE 已支持 revision、after_revision / last-event-id、快照和回放，可复用其思路；它并不自动覆盖旧 invocation ledger。本轮搜索仅发现 runtime 与 orchestrator 自身及包装器调用，未确认生产启动接线，仍需实施前核对实际运行入口。[V2 SSE](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/serverOrchestrationV2Routes.ts:245)、[orchestrator 包装器](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/autonomous-orchestrator-v2.ts:62)

优先落点应是：把当前已接线的 document / artifact 登记抽成统一发布用例，补执行中状态和真实校验，再让 Dashboard 消费这一数据源；仅增加 fingerprint 文件或新建 schema 字段，都不能单独完成这条链路。

## 6. 建议的落地方向：给 Skill 增加执行契约

以下 API、字段和状态均为本文建议，**不是现有标准，也不是已经实现的 Tenon 接口**。

### 6.1 一份契约源，三个校验对象

保留 SKILL.md 作为操作说明，在其旁边增加宿主读取的 contract 文件；如果已有统一 registry，则把契约放进该 registry。核心是只维护一份业务定义，工作流输入输出、模型工具参数、UI 表单和完成检查都从它产生，避免再维护彼此漂移的 YAML/Markdown/TS 副本。

建议的概念示例：

~~~yaml
skill: research
contractVersion: 1
inputSchema:
  type: object
  additionalProperties: false
  properties:
    topic: { type: string }
  required: [topic]
outputSchema:
  type: object
  additionalProperties: false
  properties:
    summary: { type: string }
  required: [summary]
artifacts:
  report:
    required: true
    mediaTypes: [text/markdown]
    validators: [exists, nonempty, markdown-report]
completion:
  requireValidOutput: true
  requireAcceptedArtifacts: true
~~~

需要检查三个不同对象：输入值是否合法；最终结构化结果是否合法；引用的文件内容是否存在、可读、属于当前执行且通过指定校验。路径字符串合法，不代表文件存在；文件存在，不代表内容满足质量要求。结构规则用 schema，文件格式与必需章节用确定性 validator，研究结论和设计质量另做业务验收。

每次运行记录 skill 版本、contract 版本或哈希、输入快照及上游 artifact 的精确版本。工作流启动时检查所需输出名是否存在；运行时再检查具体值与文件。复杂 JSON Schema 的兼容性不应仅靠两个 schema 名称相等来判断。

### 6.2 用宿主控制的提交入口收集产出

推荐给执行单元提供以下三个能力：

1. `artifact.publish`：提交一个命名产出物的内容或 staging 文件，返回宿主创建的 artifact ID 和版本。
2. `artifact.update`：在运行中更新草稿或发布新版本，明确追加与替换语义。
3. `skill.complete`：提交最终结构化结果，宿主核对所有必需产出物后，才能转为 succeeded。

runId、invocationId、attempt、skillRef、宿主身份由执行器绑定；调用参数不能任意声称自己代表另一个 skill 或 attempt。LLM 的“完成了”、进程退出码 0、读取过 SKILL.md 都只能作为观察信息，不能单独替代最终验收。

文件操作应走受管理的 writer 或发布工具。兼容第三方 shell skill 时，可以观察其 staging 目录及宿主工具调用，把新文件列为候选产出；正式接纳仍需内容验证和执行归属。文件 watcher 无法可靠猜出“这次同一会话中的哪个 skill 产生了这个文件”。不能接入宿主钩子的外部 CLI，应如实标记约束能力不足，并拒绝依赖该能力的强约束运行。

### 6.3 运行中先可见，验收后才可消费

建议让 artifact 独立经历 draft → submitted → accepted / rejected，SkillRun 独立经历 running → validating → succeeded / failed / cancelled。一个 run 可以有多个草稿、多个已接纳文件；run 失败时保留既有产出物的来源和状态，由下游策略决定是否可使用。

~~~mermaid
flowchart LR
    A[Skill 契约与输入] --> B[宿主校验并创建 Run]
    B --> C[模型与工具执行]
    C --> D[发布或更新产出物]
    D --> E[校验内容并保存版本]
    E --> F[登记记录与事件]
    F --> G[实时界面与订阅者]
    C --> H[提交最终结果]
    H --> I[检查必需产出物与输出 schema]
    I --> J[完成或返回可修正错误]
~~~

建议事件至少包含 eventId、seq、runId、invocationId、attempt、artifactId、artifactVersion、type、time；accepted 事件附 URI、媒体类型、内容哈希和 validator 结果。界面可以立即展示草稿，默认下游只消费 accepted 版本。

### 6.4 事件实时性必须与可恢复性一起设计

由一个明确的写入者为运行事件分配序号，先持久登记再发通知；数据库中可用事务同时更新 artifact 元数据并写 outbox。文件字节与数据库通常不是一个事务，应先完成 staging 写入和原子发布，再提交元数据；崩溃遗留文件由恢复流程处理，不能先把不存在的文件宣布为 accepted。

SSE / WebSocket 只是传输。客户端保存游标，重连先获取一致快照或从游标补读；服务端用 eventId 去重、attempt 隔离旧运行、artifactVersion 处理更新顺序。目标应是至少一次投递加幂等消费，不宣称网络上的 exactly-once。

accepted 绑定不可变内容版本：如果工作区同路径后来被改写，应生成新版本或将旧引用标为过期，不能让原哈希继续代表变化后的文件。大文件只传 metadata 和 URI，正文通过资源接口按需读取。

### 6.5 先打通一条路径，再扩展到所有技能

建议用一个有明确文档输出的 skill 做最小闭环：注册契约 → 在编辑器展示预期输入输出与检查项 → 执行前绑定及校验 → running → 草稿写入预期槽位 → 完成验收 → 下一阶段消费。第一阶段不需要整体迁移到 Cordis，也不需要把所有 skill 改写成 TypeScript 插件。

迁移顺序建议：先做契约注册与工作流预览，满足执行前可见；再把同一份计划用于执行前校验、执行中提交和完成门禁，最后打通可靠事件与旧宿主兼容。旧 ledger 中的“已完成”证据必须保留原语义；新增 draft 事件比直接放松旧 binding 的完成条件更容易保持兼容。

## 7. 建议验收场景

这些是未来实现的验收要求，本轮没有执行：

1. 输入缺少必需字段，运行在产生业务副作用前失败，并返回字段路径。
2. 模型只回复“完成”却未提交结果，不能进入 succeeded。
3. artifact URI 不存在、文件空白或格式错误时，展示具体错误；不得作为 accepted 下游输入。
4. 任务尚未结束时发布草稿，界面在约定的实时延迟目标内显示并更新它；最终验收与草稿展示分开。
5. 中途断线重连，可恢复同一组 artifact 版本；重复通知不生成重复卡片。
6. 同一 skill 并发两次或发生重试，产出物不会跨 run / attempt 绑定。
7. 取消或超时后迟到的提交被拒绝；已经发布的草稿仍可追溯到原执行。
8. 文件写入、元数据提交、事件发布任一边界崩溃后，都能恢复到可解释状态；不存在“显示成功但文件不可获取”。
9. 已接纳路径被外部改写，旧版本内容仍可获取，或明确报告失效，不能悄悄复用旧哈希。
10. 宿主不支持强制结构化完成或实时事件时，能力检查返回明确结果；不能把 prompt 约定显示为硬约束已生效。

建议采用的组合是：**DeepSeek Harness 的执行入口/出口与完成提交、A2A 的独立 artifact 更新、持久日志的游标与补读**。Koishi/Cordis 提供插件组织和生命周期思路；它们不替代上述业务协议。

## 8. 按执行前、执行中、执行后展开：工作流预览、注册与审查

本节为结合用户补充需求提出的 Tenon 设计，不是 Koishi、Cordis、DeepSeek Harness 已实现的统一协议。

### 8.1 执行前知道的是契约和绑定，运行中得到的是实例

对于已有声明或本次 workflow 已明确交付约定的 skill，系统应提前展示其输入端口、预期输出端口、类型、必需性、条件、数量约束和检查规则。例如“需要 design 文档，将产生一份 plan 文档，需要检查章节与任务完整性”。没有这些信息时必须展示未知/待约定，而不能假定能自动识别齐全。文件最终正文和内容哈希在此时尚不存在。

因此 UI 要分别保存并呈现三种信息：

- Contract：这个 skill 的能力签名，跨 workflow 复用。
- Planned invocation：这个 workflow 中某个 skill 实例的输入来源、输出槽位和检查计划。
- Run observation：这次运行实际读取的输入版本、生成的产出物版本与检查证据。

同一个 skill 可以在同一 workflow 出现多次，instanceId 不能等于 skill 名称。稳定端口身份应包含 workflow 分支、stepId、skillInstanceId、portId；运行观察另外带 runId 和 attempt。编辑器里的 expected 输出行在文件产生前就存在，不能提前创建一条看似真实的 artifact 记录。

### 8.2 每件事究竟在什么时候发生

| 时点 | 触发事件 | 系统执行 | UI 提前/实时展示 |
| --- | --- | --- | --- |
| 执行前：安装/更新 skill | 首次发现、来源索引或文件变化 | 低成本更新目录及使受影响缓存失效；有显式契约则解析，不默认调用模型 | 技能目录、来源、可用性、已知契约或待分析状态 |
| 执行前：编辑 workflow | 添加/替换 skill、切换分支、修改连线或参数 | 展开实例端口，解析绑定，检查类型与依赖，生成初步检查计划 | 每个节点的预期 I/O、来源/去向、缺失绑定、必检及条件检查 |
| 执行前：创建 workflow run | 点击运行或调度触发 | 固定 workflow revision、skill/contract/validator 版本和初始计划 | 本次运行的预期产出全貌；上游未完成的输入显示等待 |
| 执行前：启动某个 skill | 依赖就绪、调度即将 dispatch | 物化该 skill 的实际输入，求值条件，固定当前 invocation plan，执行输入校验 | 实际输入版本、此次应产出的槽位、不能启动的具体原因 |
| 执行中 | 启动、进度、文件发布/更新 | 使用预分配槽位接收产出；验证草稿 envelope，保存版本和事件 | 同一输出行从待生成变成生成中、草稿、待检查 |
| 执行后：申请完成 | skill.complete 或受管 executor 返回 | 对必需槽位、最终结果、文件和所需立即检查进行结算 | 缺失/失败详情，或者已产出并通过本节点验收 |
| 执行后：进入审查阶段 | 到达 review gate 或产出变更使审查失效 | 对检查计划求适用性、绑定精确版本、执行或合法复用证据 | 必检、条件不适用、待证据、运行中、通过、失败及原因 |

所以原先提出的四项能力的时间是：显式契约可在安装/编辑期读取，缺失信息在首次引用或启动前按需处理；发布接口在执行中调用；完成门禁在申请完成时调用；事件协议覆盖编辑期的计划变化与运行期的状态变化，但两种事件使用不同 revision 域。

每个 skill 都要做启动前校验，但不应在整个 workflow 启动时要求尚未执行的上游已提供文件。此时只检查绑定合理；等对应 skill 获得执行资格时，才要求具体输入已就绪。

### 8.3 Skill 的输入输出如何识别

| 来源 | 处理方式 | 可作为强制契约的条件 |
| --- | --- | --- |
| skill 自带 contract/schema | 解析明确的机器声明 | schema 合法、引用完整、绑定正确的 skill 内容版本 |
| 已有工作流声明或宿主工具 schema | 通过有版本的 adapter 转换 | 明确转换覆盖范围；工具加载器的返回值不能冒充 skill 业务输出 |
| 只有 SKILL.md、脚本、模板 | 首次被引用且存在值得分析的缺口时，预算内提取；内容变更只失效缓存 | 提取候选保留来源；正式约束来自确认的契约或本次任务约定，不能将推断自动升级为事实 |
| 描述含糊或缺少信息 | 登记 unresolved，并暴露缺口 | 不把 unknown 填成空输出，也不把模型猜测显示为保证 |

自动提取可以由模型辅助，但提取结果必须经过确定性 schema 校验。模型只能提议字段、条件和检查器，不负责凭空授予某次执行“无需检查”的权利。候选整理和确认是一次迁移/变更治理，不要求每次运行都让用户逐项确认。

确实不产生文件的 skill 可以显式声明零个 artifact，输出改为结构化值或已验证的副作用回执；“明确无文件输出”和“尚未识别出输出”必须分开。

### 8.4 动态注册到每个 workflow 的具体链路

~~~mermaid
flowchart LR
    A[Skill 内容与契约] --> B[版本化 Skill Registry]
    C[Workflow 分支与 Skill 实例绑定] --> D[契约解析与计划生成]
    B --> D
    E[项目事实与检查策略] --> D
    D --> F[输入输出计划]
    D --> G[检查计划]
    F --> H[Workflow UI]
    G --> H
    F --> I[执行器与提交入口]
    G --> J[Validator 与 Review Gate]
~~~

1. Registry 登记能力定义一次；workflow 按 skill 的来源、名称和版本引用它。来源解析必须与实际执行器一致，不能 UI 读用户目录里的同名 skill，执行器却加载另一个插件版本。
2. 用户向某个节点加入 skill 时，解析器创建实例，展开其输入输出，保留输入绑定与输出导出。其他未引用该 skill 的 workflow 不受影响。
3. 只有一个类型兼容、作用域和依赖路径都合法的候选来源时，可自动连线。多个候选时显示绑定歧义；不能仅按字段同名或“最近一个阶段”猜测。
4. 每个 skill 实例的全部端口都能在节点内部查看；只有显式导出的输出成为 workflow 的公共输出，实例之间的内部产出保持局部命名，避免端口冲突。
5. 编辑器改动时增量重算受影响节点。引用关系采用 instanceId+portId，重命名显示标签不改变连线。
6. skill 更新时登记新版本，刷新受影响草稿的预览或提示可升级。已保存的固定版本和运行中的 plan 不静默漂移；升级生成新的 workflow revision。
7. 计划结果同时供 UI、执行器、完成校验和审查使用。前端不再用另一套近似算法猜测服务端最终采用的 I/O。

概念伪配置如下；它不是当前 Tenon 可直接运行的 YAML：

~~~yaml
skills:
  - instance: create_plan
    use: tenon/writing-plans@1.2.0
    bind:
      design: steps.explore.skills.research.outputs.design
    export:
      plan: outputs.implementation_plan
~~~

workflow 只维护引用与连线，端口类型、必需性和基础校验来自被引用的契约。workflow/project 策略可以增加检查，不能静默删除 skill 必需契约；确需例外时走可追溯的策略例外，状态也不能伪装成检测通过。

### 8.5 输入相关或执行中才知道的输出怎么提前显示

当 skill 或任务约定已经提供形状信息时，执行前可以展示输出约束而不必知道所有具体文件名；完全没有定义时仍应保持未知。可以表达的形状包括：

- 固定输出：提前展示 report 一个槽位，固定类型与必需性。
- 条件输出：提前展示 when(input.target == web) 的 preview；条件未决时显示“条件待定”，不能显示不适用。
- 集合输出：提前展示 modules[]，明确 item schema、允许数量和命名规则；实际识别出多少模块后再展开子项。

已知输入后的条件解析可以使用受控、无副作用的 resolver。依赖真实调查才能确定的文件清单，应由前置 discovery/plan skill 产生结构化 manifest，作为下一 skill 的输入；这样下一 skill 仍然在启动前知道其具体交付集合。

运行中发现新增工作需要修改预期集合时，先提交 plan revision，检查新依赖和规则并发布 UI 更新，再启动新增任务。不能偷偷改掉原来必需的输出以使完成校验通过；已启动 invocation 保留原契约，新计划用于后续实例或显式重启。

### 8.6 审查如何动态决定“检测不检测”

检查器本身也需要 descriptor：id/version、支持的输入/产出类型、执行能力、触发时点、适用条件、作用范围、检查结果 schema，以及它是否构成当前 gate 的必需条件。该 descriptor 是可执行规则的定义，不能依赖 skill 名称中是否包含 review/test 来选择。

检查计划由四类规则组合：skill 契约的必需规则、产出类型绑定的规则、workflow/project 策略、基于实际变更和影响范围命中的规则。去重时保留规则来源，条件冲突应可见。实际变更可以增加必要检查，不能因为本来应生成的文件缺失而把完整性检查删掉。

例如同一个 writing-plans skill，在纯文档 workflow 中可以命中文档结构和需求覆盖检查；在软件开发 workflow 中，后续代码修改再命中代码检查和受影响测试。它们通过不同触发点与 target 绑定，不需要把所有测试都塞进生成计划文档的那次 skill 执行。

每次处理检查项，依次回答四个问题：适不适用、到没到执行时点、检查目标是否就绪、是否存在仍有效的证据。

| 状态/事实 | 调度决定 | UI 与 gate 语义 |
| --- | --- | --- |
| 明确适用、时点已到、目标就绪、无有效证据 | 执行检查 | 必检待执行/运行中 |
| 明确不适用，且判定依据完整 | 不执行 | N/A，记录命中规则与事实 |
| 条件所需事实未知或未计算 | 暂缓求值 | 待判定；必需 gate 不放行 |
| 适用但尚未到触发时点/上游未完成 | 等待 | 已计划，待时点/待输入 |
| 必需产出到了截止点仍缺失 | 判定完整性失败 | 失败；内容检查可等待，但不能整个检查计划 N/A |
| 检查器不可用、能力缺失或执行错误 | 记录阻断/错误 | 不冒充 N/A 或通过 |
| 有对应同一目标和环境的有效通过证据，且规则允许复用 | 复用证据 | 已通过并标明证据来源，不叫跳过 |
| 目标、规则、依赖或环境发生变化 | 失效并重检 | 旧证据过期，重新排队 |

适用条件应使用 true/false/unknown 三态。false 只有在相关事实完整时成立；例如尚未计算 changedFiles，不能把空值当成“没有改代码”。结构与存在性在提交时可先检查；跨文件行为、需求覆盖、回归测试等按相应 review gate 运行。

存储时至少分开 applicability（适用/不适用/未知）、capability（可用/不可用/未知）和 verdict（通过/失败/未运行），另记录调度与等待原因。一个已排定但尚未运行的检查，不会因此变成不适用；一个不适用的检查，也不能伪造一条通过证据。

证据复用至少绑定：检查器版本、规则与配置版本、检查目标的完整摘要、相关输入/依赖、运行环境或工具链，以及契约/策略版本。仓库级测试目标可能是整个候选 revision，不能只因单个 artifact 未变而复用。无法稳定指纹化的外部状态应按规则重新检查或使用明确有效期。

如果审查由另一个 skill 实施，调度器把检查计划和精确 artifact/revision 引用作为其输入；审查 skill 返回每个 checkId 的结论与证据，宿主验证报告覆盖率再结算 gate。审查者可以补充发现或建议新检查，但不能自行删去必需项。

### 8.7 Tenon 的具体改造接点与实施顺序

当前 materializeWorkflowIo 明确是 step 级展示投影，输入来自字段与文档策略，不改变运行时判定；server 按分支返回这份 effectiveIo。因此可以复用现有工作流 UI 入口，但需要补一个面向 skill 实例的契约解析结果，并让执行器也消费它，不能只增加展示列。[当前 I/O 投影](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/effective-io.ts:1)、[分支 API](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/workflows.ts:128)

当前 SkillEntry 主要是安装状态、来源和描述；draftEffectiveIo 在前端近似重算字段槽位。建议把 schema/validator 注册放在独立的共享服务中，给已有 registry API 提供投影，并由服务端权威解析草稿计划。[技能目录字段](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/server/src/skillsRegistry.ts:13)、[前端近似投影](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/dashboard-app/src/workflow/lint.ts:31)

当前 when 只有 track-in / track-not-in；条件未命中的 guard 被直接省略。Review lanes 来自 workflow 静态声明，没有按变更路径和 artifact 类型自动选检的统一层。建议在现有 effective plan 中加入可冻结的检查计划，并把不适用的判定依据也保留下来。[条件类型](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/predicates.ts:16)、[guard 选择](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/guard-handlers.ts:241)、[review 范围投影](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/workflow/effective-plan.ts:117)

review-attempt begin 已取得 candidate、requiredLanes 和 workflow 身份；聚合要求所有必需 lane 齐全。可以扩展该边界，把规则版本、target artifact digest 和具体 checkIds 一起固定。现有 active attempt 的恢复要求 candidate/lanes 一致，不等于已支持任意历史结果缓存；跨运行证据复用是本文新增建议。[审查开始](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/review-attempt.ts:55)、[attempt 恢复](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/review-attempt-budget.ts:134)、[结果聚合](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/kernel/src/state/review-attempt-budget.ts:242)

V2 也有 descriptor.validators → task-plan validator/output_ids 的编译点，可复用其绑定结构；但当前仅转录声明，不能作为已经实现了适用性规则引擎的证据。[V2 validator 绑定](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/planner-v2.ts:347)

建议按可验收的完整切片实施：

1. **执行前可见**：版本化契约 registry → workflow skill 实例解析 → 输入输出槽位与初步检查计划 → 编辑器展示；未执行任何 skill 就能验收。
2. **执行前可拦截**：run/skill 计划固定、输入物化、三态条件求值、宿主能力检查；坏输入或不可满足必需输出时不会启动该 skill。
3. **执行中可更新**：产出发布绑定预期槽位、版本记录与实时事件；任务未结束时 UI 能看到草稿和实际文件。
4. **执行后可结算**：必需产出和最终结果检查、审查计划调度、证据覆盖与失效、下游放行；缺产物与缺检查能力不会被判为不适用。

四个切片共享同一份契约和计划模型。第一片同时定义检查规则结构与后续端口，不等到最后才重新设计审查协议；后续逐片补齐执行能力。

新增验收重点：编辑器添加 skill 即显示已知 I/O 或明确的待分析/unknown 状态；输入来源未就绪仍可预览；同 skill 两个实例不冲突；契约升级不影响正在运行的版本；unknown 不变成 N/A；缺失必需文件不跳过检查；检查证据随目标变更失效。

## 9. 开放技能生态：按需发现、缺失契约、成本与并发

本节修正前两版过于理想化的前提。目标不是提前穷举未来会用到的全部技能，而是在技能首次被实际引用时，以有预算的过程确定已知信息和本次执行要求。

### 9.1 两个不能混淆的保证

如果 workflow 允许模型在运行中自由新增 skill，就不能同时保证在整个 workflow 开始前列出所有未来技能和精确 I/O。可以提供两个层次：

- 已编排节点：运行前显示已知 I/O、待约定字段、可能的条件分支与动态扩展位置。
- 动态新增节点：在可拦截的调用入口解析这个 skill、生成本次计划并更新 UI，然后允许执行该节点；未知内容如实显示，不伪造完整契约。

如果产品必须在首次启动前拥有完整固定图，就必须先结束规划并限制未声明的动态调用；这是执行模式的约束，不是更强的模型能消除的信息缺口。

另一项边界是：skill 可能只是一段进入模型上下文的说明，并没有独立函数调用和返回。若宿主不暴露 activation/dispatch，模型甚至可能直接复用已经读过的内容。外部观察器无法可靠知道它在语义上“使用了哪个 skill”。要逐 skill 硬约束，必须有受管激活/执行单元；只有读取后通知的宿主，只能提供有限观察，不能承诺相同执行前保证。

### 9.2 已安装、新安装、外部来源分别怎样检测

发现过程是普通程序工作，不用模型读懂全部技能。Agent Skills 官方集成指南也采用目录/注册源发现、先读元数据、激活时再取完整指令和资源的渐进方式；它并未承诺业务 I/O 推断。[官方集成指南](https://agentskills.io/client-implementation/adding-skills-support)

建议通过来源 adapter 暴露 listMetadata / resolve / readRevision / invalidate：

| 来源或事件 | 检测方式 | 什么时候做 |
| --- | --- | --- |
| 已安装的项目/用户技能 | 配置范围内枚举 SKILL.md 和 frontmatter，保存来源定位信息 | 首次进入项目/宿主连接；后续增量更新 |
| 宿主或插件自带技能 | 读取宿主可用技能列表、插件安装/启用元数据及版本 | 连接宿主、安装/启用状态变化 |
| 用户手动放入目录的新技能 | watcher 提示变更，失焦/重连/按需刷新时补扫描 | 变化后；首次引用仍重新 resolve |
| 新 workflow 引用陌生 skill | 按确切引用向相关 adapter 查询，尝试已配置的来源 | 添加节点、导入 workflow、启动前 |
| 远程/沙箱技能 | 从执行宿主的 API/manifest 获取版本和内容 | 引用时；不可访问则标记不可解析 |
| 执行中动态选中的 skill | activation/dispatch 入口触发同一按需解析 | 该 skill 的业务执行之前，前提是宿主支持拦截 |

扫描目录必须有深度/数量/字节上限，避免遍历整个用户磁盘。没有安装事件的生态必须保留按需 resolve 和刷新兜底，不能把 watcher 当作唯一正确性来源。插件 cache 中有文件不等于当前宿主已启用/可调用，要分别保存 discovered、available 和 resolved revision。

名称不是身份：记录 provider、作用域、规范化来源、版本或内容 digest。展示和执行必须调用同一来源解析规则。同内容的静态分析可以复用，但不能合并它们不同的启用状态或项目覆盖关系。

本地已有按 skillId 请求的生产 locator，且会按 runner 选择来源；同候选池内容不同的同名技能会报歧义，不能擅自改成“取第一个”。locator 缓存了部分来源枚举，新安装时还需刷新。bundled 路径已有 registry 内容哈希检查；外部单候选 locate 返回目录不等于已完成内容摘要。这些能成为按需发现与缓存的接点。[生产定位入口](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/skillBundleAssembly.ts:389)、[runner 来源](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/skills/production-content-locator.ts:149)、[歧义处理](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/skills/content-locator.ts:131)、[bundled 摘要检查](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/skill-provenance-locator.ts:212)

### 9.3 并非所有 I/O 都是“从 skill 里识别出来的”

必须保留字段级来源与覆盖范围：

| 信息类别 | 可以声称什么 | 后续处理 |
| --- | --- | --- |
| 显式声明 | 源文件确实声明了该字段/输出 | 编译并由受管运行时执行约束；声明本身不证明能完成任务 |
| 证据支持的推断 | 指令/模板暗示可能产生某结果 | UI 标为推断，保留证据；不自动据此建立必需依赖 |
| 本次任务约定 | workflow/task 指定了本次应交付的结果 | 固定成 invocation contract，由完成门禁验收 |
| 历史观察 | 过去若干次产生过某类结果 | 用于建议和排序，不保证下次必然如此 |
| 未知 | 当前没有足够信息 | 展示未知、补本次约定或按已定义的弱约束策略运行 |

例如一个通用 research skill 只说“调查问题并给出建议”，并不天然保证每次都生成 report.md。workflow 可以明确约定此次输出 research_report: Markdown；这是编排方提出的交付要求。适配器须把该要求传给执行者并接收受校验提交，不能把它标成 skill 原生能力。若运行方式无法承接要求，就不能让强依赖该文件的下游启动。

没有文本定义的信息，反复换更大的模型解析也无法变成确定事实。自动分析的职责是找出已有证据和缺口；对本次任务给出建议属于规划，两者在数据模型和 UI 上应区分。

### 9.4 是否调用模型：按需、缓存、再看缺口价值

建议使用以下分层处理，不因安装成功或打开 UI 就付出模型分析成本：

1. **目录层**：名称、描述、来源、可用性、文件标记。普通程序执行；无需模型分析。
2. **确定性解析层**：被引用时查内容缓存、读取显式 contract/schema、已支持 adapter 与明确模板。只读相关文件；解析不完整则保留字段级 unknown。
3. **辅助分析层**：只有当前节点需要解决的缺口确实影响展示、连线、调度或验收，且源材料可能给出答案时，才提交有界模型任务。
4. **任务约定层**：如果缺口来自技能根本没有定义，就由本次 workflow 规划明确要求；不继续为同一无信息问题反复付费。

模型任务入队条件可表达为：当前选中/引用 ∧ 缓存未命中或失效 ∧ 没有确定性答案 ∧ 分析可能改变当前决定 ∧ 有材料与预算。不存在的证据不满足这个条件。仅浏览全部已安装技能不默认触发模型解析；移除节点后可取消尚未执行的低优先级分析。

若当前规划模型已经读取了该 skill，可让同一次规划调用附带结构化候选和来源引用，避免再开启一次重复阅读。该候选仍要确定性校验，并保持 inferred/unknown 身份。

### 9.5 缓存、token 与时间预算

静态分析缓存键至少包括：规范化内容及实际读取的引用文件 digest、adapter/解析器版本、分析器/提示版本。项目与任务相关的条件解析单独缓存，并包含输入/项目事实指纹；不能把 workflow A 的交付约定复用成 workflow B 的原生能力。

初始目录扫描可用 stat/mtime 快速发现候选变化；选中或执行前对实际使用的内容做 digest 校验。未读取的动态引用不能假装已经包含在分析覆盖范围内。缓存还要保存 unresolved/partial 结果及原因，只有相关内容、任务条件或分析策略变化才重新分析。

相同 key 的并发请求合并成一个分析任务，其他 workflow 订阅其结果。每项任务设输入上限、输出上限、模型调用次数上限、截止时间；队列另设 provider 的并发、RPM/TPM 与总预算。内容截断须报告覆盖不足，不能把缺失区域判为没有条件。耗尽预算后返回 partial/unknown，不无限重试。

例子仅用于说明数量关系：机器上有 300 个技能，新 workflow 引用 8 个，其中 5 个命中缓存、2 个有明确契约，只有 1 个需要模型辅助，则新增分析只针对这 1 个。无信息可提取时，这 1 个也不应强行调用模型。

成本计算应使用所选模型的实际计费规则：新增成本是实际分析调用的输入/输出及缓存费用之和，另计确实发生的规划调用；没有部署与测量数据时，不承诺具体人民币或秒数。目录解析不产生模型 token，但宿主把技能目录/指令注入正常模型上下文仍有 token 成本，不能宣传总成本为零。

并发主要降低等待时间，不减少总 token；过高并发还可能增加限流和重试。需要记录缓存命中率、每次新增 workflow 的实际分析 token、队列等待、模型耗时 p50/p95、unknown 比例、契约纠正次数，据此调整预算。可从小并发队列开始试验，但本文没有基准数据支持某个固定并发数或超时值最优。

### 9.6 三种并行：分析、业务执行、审查

| 工作 | 允许并行的证据 | 必须排序/独占的情况 |
| --- | --- | --- |
| 多个 skill 的静态读取/模型分析 | 独立且不可变的文档快照，预算允许 | 同 key 合并请求；某分析依赖前一结果时按依赖执行；registry 发布以版本条件提交 |
| 真正执行 skill | 输入依赖满足，明确的只读或隔离能力，资源无冲突，宿主允许 | 上游输出依赖、同文件/目录写入、共享浏览器/数据库/部署目标、作用范围未知 |
| Validator / review | 检查同一固定版本，彼此独立，执行不修改共享目标 | 完整性检查是内容检查前提；build 后才能测构建产物；修复完成后才复审；全项结果齐全后才聚合 gate |

业务调度需要数据依赖图和资源冲突图。A 写某资源而 B 读/写同一资源时不能重叠；路径需要检查祖先/子路径、规范化与别名，不能仅比较两个字符串是否相等。副作用范围未知时，对共享作用域采用独占；若运行时提供覆盖全部相关副作用的强隔离，才可扩大并发。不同 worktree 并不自动隔离浏览器、外部 API 或同一个数据库。

模型从文字猜“应该可以并行”只可生成待确认的资源画像，不能成为唯一放行依据。I/O schema 也不足以判断副作用和可重入性；需要资源声明、可强制的宿主能力及运行时锁。每次实际 dispatch 前要重查依赖、身份和资源占用，因为队列等待期间可能变化。

DeepSeek Harness 在工具层提供了可核对的保守做法：isConcurrencySafe(args) 只有明确返回 true 才能进入并行池；未声明、异常或其他返回值都归 exclusive，池中调用开始前还会重新分类。这是工具级调度，不能直接推导多步骤 skill 的并行安全。[分类源码](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/index.ts#L1258-L1274)、[执行前重查](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/tool-calls.ts#L199-L210)

Tenon V2 已有 supports_parallel、resource_claims 和冲突建边入口，但本次所读 buildPlan 主要按资源 key 相等判断冲突，不能据此称为完整的目录重叠/动态资源分析。本节描述的是需补齐的调度依据。[现有资源建边](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/planner-v2.ts:332)、[并行声明校验](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/automation/src/orchestration/workflow-pipeline-v2.ts:175)

### 9.7 触发与等待策略

| 场景 | 立即执行 | 可异步处理 | 什么会等待 |
| --- | --- | --- | --- |
| 首次连接、安装/更新 | 来源索引、可用性、缓存失效 | 可选的廉价目录预热 | 不要求用户等待全量模型解析 |
| 新建/编辑 workflow 首次引用 | resolve、缓存、显式声明、unknown 槽位 | 仅选中缺口的有预算分析；结果推送更新 UI | 编辑器保持可用，保存为带诊断的草稿 |
| workflow 开始 | 固定已解析节点的版本及计划，检查图的可用性 | 不阻碍当前就绪节点的后续分析可继续 | 无法满足硬依赖的节点不调度；确定根本不可运行的图报告错误 |
| 某 skill 即将执行 | 实际版本再确认、本次契约/输入/资源检查 | 无关节点继续运行 | 只有该节点及依赖它的节点等待必要分析/约定 |
| 动态新增 skill | 在受管 dispatch 入口执行同一 resolve/ensure 流程 | 更新运行图和 UI | 新节点未完成必要前检前不做业务执行 |
| artifact 更新、进入审查 | 求值已有规则、绑定目标、失效旧证据 | 独立检查并行；语义审查仅按规则调用模型 | required checks 未齐不能通过 gate |

UI 对每个节点显示已知输入输出，以及 declared / inferred / task-bound / unknown 的来源状态；分析过程显示排队/分析中/预算不足。已绑定的候选结果必须校验 workflow draft revision，避免用户已经换掉 skill 后旧分析覆盖新节点。

当前 Tenon 确有 PreToolUse gate，能识别原生 Skill 调用和一部分受支持的文件读取命令；因此不能笼统声称只有 post-read 观察。它目前做 DAG/review 限制，还没有上述业务 I/O preflight，部分异常会 fail-open，Pi 配置也只有 SessionStart/PostToolUse。当前 custom step 会拒绝未声明 skill，所以允许动态新增还需要先生成计划 revision。强执行前保证必须在实际宿主验证覆盖与失败拒绝行为；本轮未做运行时复现。[前置 gate](/Users/a1234/Documents/code-manager/projects/tenon-local/hooks/gate.sh:342)、[异常处理边界](/Users/a1234/Documents/code-manager/projects/tenon-local/hooks/gate.sh:314)、[未声明 skill 规则](/Users/a1234/Documents/code-manager/projects/tenon-local/packages/cli/src/commands/internalSkillGate.ts:300)、[Pi hook 配置](/Users/a1234/Documents/code-manager/projects/tenon-local/adapters/pi/settings.json:4)

### 9.8 最小可验收场景

1. 安装 300 个技能只更新目录，没有 300 次模型分析；首次引用其中一个才进入按需流程。
2. 外部新装 skill 无安装回调时，首次引用依然能被 resolver 找到；文件在 cache 中但未启用不显示为可调用。
3. 同名不同来源分别解析；分析内容与实际执行内容哈希相同。
4. 没定义 I/O 的技能保持 unknown 或采用本次任务约定，不能制造“检测到原生输出”。
5. 多个 workflow 同时引用相同新内容，只产生一次必要分析；失败/无信息结果也有缓存。
6. 模型预算超限不阻塞整个编辑器，必要节点保持待解决，不降级成已验证。
7. 分析任务可并行，但两个会写相同目录的业务 skill 不并行；资源范围未知不会被当成零冲突。
8. 动态新增 skill 在其可拦截的执行入口补前检；没有该入口的宿主明确标注保证范围。
9. 契约缓存因引用文件变化而失效；历史输出观察不被自动推广为必需输出。
