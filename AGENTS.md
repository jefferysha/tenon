# Agent Rules

<!-- create-rule:start -->
本文件是 agent 规则入口和决策层。具体约束放在 `.agent-rules/`，本文件只负责选择本次任务需要读取哪些规则以及处理当前请求与长期规则之间的关系。

Claude Code 使用本文件时，不得用未转义的 `@path` 导入规则文件；必须按任务范围手动读取，避免启动时加载全部规则。

## 规则目录

- 通用规则：`.agent-rules/COMMON.md`
- 前端规则：`.agent-rules/FRONTEND.md`
- 后端规则：`.agent-rules/BACKEND.md`

## 本次任务规则选择

| 任务范围 | 必须读取 | 非必要时不读取 |
| --- | --- | --- |
| 仅前端 | `.agent-rules/COMMON.md` + `.agent-rules/FRONTEND.md` | `.agent-rules/BACKEND.md` |
| 仅后端 | `.agent-rules/COMMON.md` + `.agent-rules/BACKEND.md` | `.agent-rules/FRONTEND.md` |
| 前后端或共享契约 | `.agent-rules/COMMON.md` + `.agent-rules/FRONTEND.md` + `.agent-rules/BACKEND.md` | 无 |
| 通用文档、工具或流程 | `.agent-rules/COMMON.md` | 与任务无关的领域规则 |

如果范围不确定，先根据用户目标、涉及文件、调用链和风险边界判断；只有不同选择会实质改变结果时才询问用户。

## 当前请求与长期规则

- 用户当前清晰、明确的要求可以在本次任务中覆盖长期偏好；只要没有超出授权范围或安全边界，说明偏离后直接执行，不要求先修改长期规则。
- 只有当覆盖要求可能反复出现、用户重复纠正，或不持久化会让未来 agent 持续犯错时，才询问是否写入长期规则。
- 请求含糊、实质扩大范围、意外改变公共契约或安全边界，或会造成不可逆的外部/生产影响时，先澄清再执行。
- 持久化规则时，通用流程、安全、验证、交付和项目结构写入 `.agent-rules/COMMON.md`。
- 前端技术栈、组件、状态、样式、可访问性和前端架构规则写入 `.agent-rules/FRONTEND.md`。
- 后端技术栈、服务分层、API、数据库、迁移和后端架构规则写入 `.agent-rules/BACKEND.md`。

## 执行纪律

- 修改前读取相关实现、调用方、测试和已选规则，不得只根据文件名猜测行为。
- 用户请求已经授权且操作可合理回退时，可以直接完成正常的代码、测试、依赖、schema、配置、CI 和文件变更，不得仅因操作类别重复请求确认。
- 操作超出请求、难以回退，或在授权不清晰时改变外部/生产状态、发布或发送内容、产生费用、访问 secrets、影响真实用户/数据，必须先确认。
- 不得伪造验证结果；未运行的验证必须说明原因和剩余风险。
- 不得提交 secrets、真实用户数据、私钥或 tokens，不得执行未经授权的破坏性操作。
- 最终回复遵循 `.agent-rules/COMMON.md` 的交付要求。
<!-- create-rule:end -->

## 子代理调度

以下原则适用于 `luna_worker` 以及其他自定义 subagents；主 Agent 始终负责拆解任务、维护主任务目标、整合结果并完成最终验收：

- 主线程独占任务拆解、复杂性判断、风险分级、代码 review、问题定级、验收标准判定以及结果接收或拒绝；不得将这些职责委派给 `luna_worker` 或其他自定义 subagent，也不得采用 worker 的自审结论代替主线程 review。
- `luna_worker` 以及其他自定义 subagents 只负责实施主线程下发的独立子任务。worker 不得自行进入 review、替主线程给出 review verdict、决定验收通过、调整主任务目标或扩大任务范围；实施完成后应停止并回传变更范围、实现结果和验证证据，等待主线程亲自检查。
- 对体量较大、边界清晰且相互独立的子任务，优先派发给多个 `luna_worker` 并行处理；后续需要调用子代理时，默认优先选择 `luna_worker`。几分钟内能够完成的轻量任务直接留在主线程，避免不必要的调度开销。
- 每个 worker 的委派描述必须上下文完整，至少明确目标、相关仓库或 worktree、允许修改的文件范围、任务边界与非目标、预期输出和可执行的验收标准。worker 只执行被委派任务，不得修改主任务目标或自行扩大范围。
- 只读任务可以并行。涉及文件写入的任务必须为每个 worker 使用独立 worktree；若无法隔离写入环境，则改为串行执行，不得让多个 worker 并发修改同一 checkout。
- worker 完成后，主线程必须逐项按照委派时的验收标准检查结果。未达标时应结合实际缺口补全上下文并重新派发，不得直接把未验收结果视为完成。
- 如果多个 worker 无法并行，先检查用户级 `~/.codex/config.toml` 中的 `agents.max_concurrent_threads_per_session` 是否被显式设置为 `1`，再排查其他并发限制；检查配置时不得覆盖或删除无关内容。

<!-- PIPELINE:CODEX:START -->
## Tenon Workflow（Codex 静态层）

正常开发对话先调用 `tenon:tenon`：它创建或恢复 Change，按任务冻结的工作流逐步执行——每一步做什么
只看 `tenon status <change> --json` 的 `step.next`，没有另外的阶段技能要分派。
Todo 用 `tenon workflow plan <change> --json` 的步骤标签建立，当前项取 `current_step`；
不得先生成脱离工作流步骤的通用 Todo。

状态操作一律走 `tenon status` / `tenon get` / `tenon set` /
`tenon transition` / `tenon check`，勿手改 canonical state 或 `.pipeline.yaml` 投影。
已登记的规格文档需求语义变了，走 `requirements-changed` 回到规格步重新登记，不在实现步覆盖。

评审门（`gate: review`）离开前须对确切 transition event 取得人类显式确认：先运行
`tenon review request <change> --event <event>`；用户明确回复「确认继续」「继续执行」等放行语后
由 hook 写入回执，再照 `step.next` 执行。不能删除 marker 绕过 review-gate；verify-fail 与
verify-pass 的确认不可互用。
<!-- PIPELINE:CODEX:END -->
