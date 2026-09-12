# 运行时产物血缘与完整 Workflow 接线修复

## Goal
修复真实 workflow 执行中产物“能存但无法可靠解释、传递和展示”的问题。用户在 UI 编排阶段仍不需要预先填写每个 skill 的文件输入输出；执行器必须在阶段边界登记真实观察结果，并为下游提供有作用域、带版本、可读取、可追踪消费关系的产物目录。

## Background / confirmed facts
- 2026-09-12 的真实七阶段验证使用了 7 个真实 `codex exec` 子进程和结构化 JSON 输出，但提交 `dcd76d8` 只包含 `.trellis/` 证据，没有生产代码改动。
- 验证驱动器在阶段结束前手动调用 `StageArtifactRuntime.reconcile()`，因此绕过了生产 `ExecutionRuntimeV2` 的接线缺口。
- `packages/automation/src/artifact-runtime/stage-runtime.ts:68` 将文件观察写成 `origin: 'unknown'`，导致生产者为空；服务层可见性过滤无法按依赖阶段工作。
- 驱动器只校验 `outputs`，丢弃 skill 返回的 `consumed`，也没有调用 `ArtifactService.read()`；因此 `consumed`、`affected` 和版本影响均无法形成。
- `packages/automation/src/artifacts/service.ts:87` 只允许本 attempt 观察过当前版本后发布，阶段无法发布内容未变但已存在的既有版本。
- `ExecutionRuntimeV2` 使用 `item.work_item_id` 作为 artifact `stageId`；Dashboard 使用 workflow step id 查找 `artifactAttempts`，且 `packages/server/src/snapshot.ts` 当前没有填充 `artifactAttempts`。
- `ExecutionRuntimeV2` 会把 `StageArtifactRuntime` 传给 executor，但没有把 executor 返回的消费声明映射为 `service.read()`，也没有提供受预算约束的产物目录/摘要/按版本读取接口给下一阶段。
- Artifact Service 的事件和状态已具备文件持久化、幂等键和锁，但没有完成 runtime 重启/事件游标/阶段 attempt 投影的端到端验证。

## Requirements

### R1. 生产者与观察边界
- `StageArtifactRuntime` 对阶段内发现/写入的文件登记真实 producer（workflow run、stage attempt、可选 skill/actor），同时保留观察来源和无法归属时的 `unknown` 标记。
- 终态 `end()` 必须执行一次可等待的 reconcile；显式 publish 仍是交付动作，观察不自动等同 deliverable。
- 受管写入、shell 写入和阶段前后扫描的覆盖范围必须在事件/诊断中可区分，不能声称 watcher 覆盖所有写入。

### R2. 既有版本发布与候选/交付状态
- 阶段可以在本 attempt 中通过作用域合法性校验后重新发布已存在且内容未变化的版本；不得重复创建版本。
- 发布前必须确保版本存在、来源在可见依赖范围内，且发布者与生产者分离记录。
- candidate、intermediate、deliverable 的筛选默认只向下游展示 deliverable；候选和中间文件在显式 include 时才进入详情目录。

### R3. 消费回执与影响计算
- executor/skill 的结构化结果可以声明 `consumed`，声明必须经过真实 artifact identity/version 校验。
- 对每个有效消费调用 `ArtifactService.read()` 或等价的 execution receipt API，绑定 stage attempt、artifact、version、representation 和字节预算。
- catalog 的 `consumed` 与 `affected` 基于持久化 read receipt 和后续新版本计算；未能解析的声明记录诊断而不是伪造成功。
- 下游阶段必须读取固定版本；新版本只产生通知/affected 标记，不自动改变正在运行的输入。

### R4. V2 runtime 和 stage identity 接线
- `ExecutionRuntimeV2` 使用稳定的 workflow pipeline stage id 作为 artifact stage identity，同时保留 work item id 作为 ledger identity。
- runtime snapshot、artifact attempts、server snapshot 和 Dashboard 查询使用同一映射；旧数据可通过兼容映射读取。
- `artifactAttempts` 必须从持久 Artifact Service 投影到 `/api/snapshot`，并能被 UI 根据所选 workflow step 定位最新 attempt。
- production executor 必须在阶段开始、执行中和终态使用同一 StageArtifactRuntime；验证驱动器不得承担生产接线职责。

### R5. 渐进式产物披露
- 提供固定的 list/catalog、inspect/summary、read(version)、events(after) 接口，不为每个新文件动态注册工具 schema。
- 目录返回受 scope、dependencyStages、disposition、quality、version、digest、size、media type、availableFromStage、consumed、affected 约束的有界元数据。
- 下一阶段开始前刷新目录和输入 manifest；模型/skill 默认只获得摘要和定位符，正文按需按版本读取，并受 max entries/max bytes 限制。
- 目录变更通知与正文消费分离；UI 读取不得生成 execution receipt。

### R6. 持久化、恢复和幂等
- 事件、attempt、版本、blob、read receipt、catalog revision 在进程重启后可恢复；重复事件和重复观察不生成重复版本/回执。
- 提供 after 游标读取和重连去重测试；并发 attempt 不得覆盖更新版本或伪造 producer。
- 损坏/不完整状态必须显式报错或降级为 unavailable，不能静默显示为空。

### R7. 动态检查与 UI
- 检查器、schema adapter、summary provider 根据真实 artifact metadata/version 动态选择；检查结果绑定 exact version/rule version。
- UI 显示真实目录、版本、候选/交付状态、摘要/预览、消费和 affected 状态；编排 UI 不要求用户预测文件清单。
- 保持现有 governed workflow、transition、send-back 和文档证据语义不变。

## Acceptance criteria
1. 新增一个没有 I/O 元数据的 skill 到新 workflow，UI/保存不触发模型解析或缺输出警告；真实 V2 executor 执行后能登记未声明文件。
2. 真实多阶段执行中，producer stage、stage attempt、dependency visibility、catalog availableFromStage 和 downstream read receipt 均有正确值；无关阶段看不到 deliverable。
3. 同一路径 v1→v2 时，旧 v1 可读取；读取 v1 的已完成消费者标为 affected，未读取/无关消费者不标记；相同字节跨 attempt 不产生新版本但允许合法重新发布。
4. executor 返回 consumed 声明后，service.events() 出现幂等 `artifact.consumed`，catalog 正确显示 consumed/affected；非法声明被拒绝并留下诊断。
5. `artifactAttempts` 出现在 server snapshot，Dashboard 选中对应 step 能获得正确 stage attempt；work item id 与 workflow stage id 不混用。
6. 目录分页/预算、inspect/read(version)、after 游标和 UI read 不生成 execution receipt 均有自动化测试。
7. 关闭并重新打开 Artifact Service 与 runtime 后，attempt、版本、事件和 receipt 可恢复；重复 replay 不重复写入。
8. 真实完整 workflow 不再依赖验证驱动器手动补 reconcile/consume；production runtime 直接产生可审计的 artifact events/catalog。
9. 目标包的定向测试、类型检查、构建、架构检查和真实 backend workflow E2E 通过；任何预先存在的失败单独记录。

## Out of scope
- 不要求 workflow 编辑器为任意 skill 预填精确文件清单。
- 不安装外部云服务、不购买模型、不部署生产环境。
- 不重写无关的 dashboard、adapter 或 governed document 逻辑。
- 不把普通文件路径或模型声称的 JSON 直接当成已验收产物；所有交付仍以真实观察、版本和检查为准。

## Open questions
无。用户已明确要求全部修复并真实重跑验证；兼容旧数据、候选默认隐藏、正文按需读取和父阶段保持真实执行边界均按上述要求实施。
