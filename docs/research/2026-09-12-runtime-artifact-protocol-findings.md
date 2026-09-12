# Runtime artifact 协议：外部一手源码核对

日期：2026-09-12。范围：Koishi/Cordis 生命周期与动态注册、DeepSeek Harness hooks/文件观察/交付/上下文更新、OpenLineage 运行时输入输出与 schema。本文是研究记录，不是已实施功能。

## 结论

用户的新边界成立：workflow 编辑器不需要调用模型来推断任意 skill 的输入输出文件。可以让编辑器只定义阶段、依赖、技能和上下游资源可见性；真实文件由运行过程登记。已有明确声明可以作为可选说明，历史运行产物可以作为历史示例，均不可冒充这次运行的实际清单。

最有价值的组合不是“每个新文件动态生成一份 tool schema”，而是：固定的资源描述和查询协议、运行时变化的资源实例目录、阶段/尝试作用域、稳定版本、变更通知，以及模型下一步开始前的目录更新。下列项目分别提供其中某些机制，没有哪个在核对范围内自动完成“任意 Markdown skill → 可靠业务产物契约”。

## 版本与核对方式

- DeepSeek Harness：本地 sparse checkout `/tmp/tenon-deepseek-harness-research-20260911` 的 HEAD 已核实为 `c291e7961a515f6d7af9304e7fd1d257929aef26`；缺少的目录用 `git show HEAD:<path>` 读取同一快照，没有切换分支或安装依赖。
- Cordis：沿用固定提交 `f8ea3cd50f1a5724e8e715995bcde131c9c12b2c`，本轮打开官方源码核对。
- Koishi：官方配置、生命周期、服务文档于本轮读取；此前源码快照为 `5525cfd06e0e48be0d65fa31a0ce46d0dc65ffde`。Koishi 当时依赖 Cordis 3.x，不把 Cordis 新主干同名方法的语义套回 Koishi。
- OpenLineage：本轮官方文档显示版本 1.53.0；另核对不可变协议地址 `https://openlineage.io/spec/2-0-2/OpenLineage.json`。

## 1. DeepSeek Harness：已经存在的三个分离机制

### 1.1 工具执行 hooks：拦截与观察具有不同保证

工具注册器区分 `tools/pre-execute`、`tools/execute`、`tools/post-execute` 和最终 `tools/result`。前几者是决策或环绕执行边界；`tools/result` 是观察已冻结最终结果的通知。观察器抛错或 Promise 拒绝会被记录，不会回滚工具结果；Promise 不构成工具完成的等待屏障。[事件声明](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/index.ts#L135-L199)、[最终通知实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/tools/src/index.ts#L1647-L1667)

推论：异步产物写入若仅挂在普通通知 hook 上，可能晚于阶段完成或失败而不被阻止。产物可靠接纳需要执行器等待的提交/结算边界，或阶段结束前的持久化检查；通知用于刷新 UI 和缓存。

现有 Codex hook 桥支持 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop，并将额外上下文送入后续模型请求，但只是兼容子集：非 shell 参数被压成 `tool_input: { command }`，配置失败和多数执行失败不阻止 agent，`updatedInput` 不生效。自定义产物协议应优先接原生 typed hook，不能把兼容桥当成通用、完整、可靠的记录器。[桥接能力与限制](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/hooks/hooks-codex/README.md)、[共享 hook 限制](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/hooks/hook-protocol/README.md)

### 1.2 文件观察：实际路径与版本，但不是产物登记

`fs/observed` 携带目标、present+version 或 absent、以及不透明 actor。它是同步记录通知，返回的 Promise 不被等待。基础文件服务的写入支持可选版本条件，未提供条件则可以无条件写入；观察策略插件将先前读取版本变成写入检查条件。[文件事件源码](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/fs/fs/src/index.ts#L49-L76)、[观察策略](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/fs/fs-observation-policy/README.md)

`workspace-files` 把观察转换成 `{ absolutePath, version }` 或消失通知。客户端先等 ready、再 stat、对齐期间排队的变化，重复版本忽略，内容另行分页读取。这是“元数据先到、正文按需取”的明确实现。[文件 API 与客户端行为](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/workspace-files/README.md#L28-L83)、[变更流实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/workspace-files/src/changes.ts#L19-L80)

其文档明确列出边界：

- 只转发受管文件操作的观察，不监听 OS；shell、子进程、用户编辑可能没有帧。
- 文件预览本身不向模型注入上下文，不登记 session event。
- 先 stat 后读取并非事务读；并发修改可能让返回版本与正文不一致。
- 变更流的一代队列是内存结构；关闭会丢弃剩余队列，不能当成持久日志。

以上分别由[已知限制](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/workspace-files/README.md#L124-L147)和[队列关闭实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/workspace-files/src/changes.ts#L82-L130)支持。

推论：Tenon 需要组合受管工具 hook、对无法观测操作的阶段前后核对，以及生产者提交。文件变化只能产生“候选/修订”记录，不能自动等同最终交付、语义正确或由当前 skill 生产。没有覆盖的来源应标为观察不完整，不能声称精确全量 I/O。

### 1.3 `present`：统一交付接口，无需逐 skill 定义产物 schema

已有固定工具 `present(files: [{ path, description? }])`。它要求文件已存在，通过会话文件系统检查 regular-file 元数据，不把文件正文送给模型；成功的最终工具结果会追加 `deliverables/presented`，事件携带 turn、callId 和文件声明。[完整实现](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/fs/tool-present/src/index.ts#L33-L107)、[事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/fs/tool-present/src/types.ts#L4-L16)

这是“预先固定登记协议，执行中登记实际文件”的直接参考；它不需要在 workflow 编辑器预测文件清单，也不需要为每个文件新增工具定义。

必须保留的反例：

- 它仍需 agent/执行者调用 `present`；文档中的要求不是强制保证每次最终响应都已调用。
- 子 agent 的交付归其会话，父会话需要自己声明；不能自动把所有子任务文件认作父交付。
- 内层 present 成功后，外层程序随后失败不会撤销声明。因此“登记过”不等于整个阶段成功。
- 只保存源路径及描述，没有冻结字节或持久产物版本。源文件修改后打开的是新内容；删除后声明不能恢复文件。文档明确版本存储和 copy-on-write 尚未实现。

这些边界见[用法、实现与限制](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/fs/tool-present/README.md)。因此下一阶段可靠消费，需要在此模式上增加不可变内容版本、状态及消费记录，不能直接拿 mutable path 作为已验收输入。

## 2. DeepSeek Harness：如何让模型渐进知道动态目录

`tool-skill` 本身提供了很适合迁移的目录模式：

1. `agent/pre-step` 在下一模型步骤开始前取得当前 agent 作用域、cwd 对应的技能 snapshot；不完整 snapshot 不发布。
2. 把可调用技能投影为 name+description 条目；摘要长度受限。
3. 对有序条目的规范表示计算 SHA-256；与当前可见目录一致时不重复注入。
4. 首次发布摘要目录；变化时发布完整替代目录，包含 `update: true`；清空目录也明确宣告旧目录不再可用。
5. 目录只负责发现；完整正文经 `skill` 工具按需读取。

依据：[pre-step 和去重](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L213-L250)、[摘要、替代目录](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L254-L309)、[digest](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L323-L334)、[实际加载](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L81-L155)。

“替代目录”指有效目录语义，不表示删除持久历史。实现可以追加一条 replacement 消息；它在本次待提交消息中有已有 catalog 时才替换该候选。不要将其描述为旧消息字节全部从历史消失，或天然不增加 token。

目录消息同时带结构化 `source.entries`。非模型消费者读这些条目，无需解析模型看到的 XML 文本。这是 UI 与模型可以使用同一事实源、分别投影的证据。[结构化目录源码](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/tool-skill/src/index.ts#L28-L56)

注册器允许全局/作用域 provider、按需 list/get、注册生命周期清理和 `skills/change` 失效通知。通知表达“目录可能变化”，消费者重新按自己的 scope 查询，不把收到广播当作获得新访问权限。[provider 与通知](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/skill/src/index.ts#L248-L296)、[注册作用域及卸载](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/skill/skill/src/index.ts#L346-L425)

对产物的设计推论：固定 `list/describe/read/changes` 接口；实例目录按 stage/run/attempt/可见性筛选；变更后在下一步骤注入有预算的索引或变化摘要；正文、diff、schema 均按需读取。无需每个产物重新注册工具 schema。当前已核对的是技能目录实现，这个产物目录属于 Tenon 的设计迁移，不是对上游已有能力的描述。

大结果已有 spill-policy：只保留有界预览与全文定位符，完整格式化结果另存，通过分页 read/grep 获取；它不改 canonical tool value。文档指出文本 notice 可被工具仿造，因此 notice 文本不能作为产物真实存在的凭证。[spill-policy](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/spill/spill-policy/README.md)

## 3. Koishi/Cordis：借鉴能力作用域，不能借来业务持久化保证

Koishi 的配置 Schema 校验插件配置并支持控制台配置表单；它能让 UI 操作固定配置，不意味着每次运行的业务输入输出已知。[配置构型](https://koishi.chat/zh-CN/guide/plugin/schema)

Koishi 的 `inject` 让依赖服务出现后启动插件，服务变化时回滚对应副作用再重新加载，`dispose` 回收监听器、命令和相关资源。可以用于产物 provider、类型检查器、UI 扩展的动态挂载与卸载。[服务依赖](https://koishi.chat/zh-CN/guide/plugin/service)、[生命周期](https://koishi.chat/zh-CN/guide/plugin/lifecycle)

Cordis 固定源码中的 listener 注册挂在 fiber effect 上，卸载时自动解除。事件分发直接调用 callback；TypeScript 声明合并提供类型，没有为每个业务 payload 自动运行 JSON Schema 验证。`emit` 不等待 Promise；当前 `parallel` 等待所有回调并汇总异常；`serial` 在返回非 null/false/undefined 时短路；`waterfall` 是 next 环绕调用。[事件核心](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/packages/core/src/events.ts#L6-L171)

推论：不要把一个普通产物文件注册成“服务”并通过热重载重启消费者阶段。服务是能力，产物是有版本的数据。借鉴作用域和 provider 生命周期即可；下游阶段已运行时如何处理新版输入，应由工作流策略决定，不能由 Cordis 自动回滚副作用的语义替代。

## 4. OpenLineage：运行时逐步知道 I/O 是正式模型

OpenLineage 分开设计态 JobEvent/DatasetEvent 与运行态 RunEvent。Job 是定义，Run 是一次执行，Dataset 是数据身份；后续 RunEvent 可以逐步补充此前尚未知的输入输出。运行周期文档直接举例：动态/参数化作业无法预先固定输出，需合并该 run 多次事件才能得到完整信息。[对象模型](https://openlineage.io/docs/spec/object-model/)、[事件完整性](https://openlineage.io/docs/spec/run-cycle/#event-completeness)

在不可变 OpenLineage 2-0-2 schema 中，RunEvent/JobEvent 的 inputs、outputs 都不是 required 字段。协议允许先有活动事实，再补具体数据关系；这为 workflow 定义时不必展示虚构文件清单提供了直接依据。[RunEvent/JobEvent Schema](https://openlineage.io/spec/2-0-2/OpenLineage.json)

需要分开三种 schema：

- **事件 schema**：校验 eventTime、run、job、inputs/outputs 等消息结构。
- **元数据扩展 schema**：facet 的 `_schemaURL` 固定扩展结构；官方要求版本 URI 不可变，不能指向可变分支。
- **数据自身结构**：SchemaDatasetFacet 描述字段名称、类型、嵌套关系等；不等于校验任意 PDF、Markdown 或业务内容正确。

依据：[事件 Schema 说明](https://openlineage.io/docs/spec/schemas/)、[facet 扩展与不可变 URI](https://openlineage.io/docs/spec/facets/)、[Dataset schema](https://openlineage.io/docs/spec/facets/dataset-facets/schema/)。

同一实体同名 facet 的后续记录整体替代原 facet；这与 run 输入输出的累积信息不是同一合并规则。产物协议需要明确全量快照、增量和 tombstone 的区别，不能笼统“后来的 JSON 合进去”。[facet 合并语义](https://openlineage.io/docs/spec/facets/)

VersionDatasetFacet 记录存储系统提供的数据版本；它没有替任意文件系统生成、保存可恢复版本。OpenLineage 是观测协议，不负责运行任务、冻结字节、自动唤醒消费者或执行验收。[Version facet](https://openlineage.io/docs/spec/facets/dataset-facets/version_facet/)、[对象模型版本定义](https://openlineage.io/docs/spec/object-model/)

## 5. 对本轮最佳方案的约束

以下为结合源码提出的设计建议，不是上游现成功能：

| 需要的行为 | 机制 | 必须避免的误解 |
|---|---|---|
| UI 配置 workflow | 阶段依赖、skill、上游可见范围、完成/变更处理策略；固定 schema 的普通表单 | 不把历史产物或推测文件冒充本次 I/O |
| 实时发现写入 | 受管写入 hook，补充 watcher/阶段核对，记录观察覆盖范围 | watcher 只能发现文件变化，不能认证生产者或语义交付 |
| 登记业务交付 | 类似 present 的固定提交接口，加可等待的验收边界 | 单个工具成功不等于父阶段成功 |
| 变更可追踪 | artifact 身份与不可变 revision 分开，变化事件引用精确 revision | 路径相同不等于内容相同；FS freshness token 不等于可恢复快照 |
| 下游发现 | 固定查询接口、作用域目录、变化通知、下一模型步骤刷新 | 通知本身不代表正文已读、不代表自动改变正在执行的输入 |
| 渐进披露 | 元数据索引 → 描述/检查状态 → 指定版本正文或 diff | 把所有全文或大量动态 tool schema 每次重发会增加 token 与上下文负担 |
| 变更后的审查 | 对新 revision 计算适用检查，检查结果绑定 revision 和规则版本 | metadata schema 通过不等于内容验收通过；旧版本通过不能沿用为新版本通过 |
| 崩溃与重连 | 单独持久化事件/版本及可补读游标，通知只是投影 | Cordis emit、工具结果 observer 和内存 change feed 都不是持久提交屏障 |

## 6. 需要在主方案明确的失败情形

1. shell 在不可观察位置写文件：只能标记覆盖不足；要求显式提交或可读取的输出目录，不能宣称自动发现所有产物。
2. 同一路径被多阶段写入：不能按 mtime 归属，需 writer/attempt 关联或隔离；无法归属时保留不确定。
3. 下一阶段读到 r1 后出现 r2：目录可通知 r2 可用，但执行仍绑定已读版本；等待、重新运行或明确刷新由策略决定。
4. 事件登记成功但版本字节未持久化：不能发布“可接纳”状态；否则消费历史时读到别的内容或文件消失。
5. 生产者只写了中间文件：候选变化与正式交付需要不同状态；缓存、日志、渲染临时图不应自动全部传到后续阶段。
6. 模型生成了看似合法的资源 JSON：宿主必须验证真实资源、身份和版本；不能把 schema 合法当成事实真实。
7. 多次修订未产生可见目录变化：技能目录目前 digest 只含名称与摘要；产物目录必须至少包含 revision 和状态，否则同名内容更新可能不会触发披露。

本轮仅新增本文，没有改动运行时代码、工作流定义或现有任务。
