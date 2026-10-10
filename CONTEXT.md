# Domain Context

## Build revision trust

- **Trustworthy build revision**：由 Tenon 在 Build 出口读取当前真实 revision，并同时绑定当前
  repository、worktree 与 canonical Build→Verify transition provenance 的不可伪造候选；用户填写的
  SHA、ledger 行或 receipt 本身不构成该事实。
- **Build revision token**：保存在兼容字段 `build_sha` 中的 `build:v1` token。token 只包含带域分隔的
  revision、repository、worktree SHA-256，不暴露绝对路径、prompt、credential 或其他原始内容。
- **Revision provenance**：当前 canonical transition head 必须证明同一次进入当前 Verify visit 的
  transition 确实写入了该 token。普通 `tenon set`、backfill、producer 声明或无关 receipt 均不能建立
  provenance。
- **Fail-closed blocker**：无法完整求值、缺失或不可信时统一返回
  `verify-build-revision-untrusted`，并要求回到 Build 重新构建和捕获；不得补写历史证据。

## Host subagents and step progress

- **宿主子代理文件**：Tenon 按 agent 库中的定义为某个宿主渲染的 `tenon-<name>` 子代理定义文件。它只由用户在终端执行的
  安装写入用户级目录，会话里的任何 Tenon 命令都不写。
  _Avoid_：原生 agent 文件、生成的 agent
- **专属子代理 / 通用子代理**：派发时使用 `tenon-<name>` 类型即专属子代理，工具白名单与模型随定义生效；宿主默认的子代理类型
  （Claude `general-purpose`、Codex `default`）即通用子代理，只靠提示词约束。
- **退回原因**：派发返回通用子代理时记录的原因，取值为 `not-installed`、`definition-mismatch`、`shadowed`、`project-agent`
  之一。
- **用户级所有权清单**：记录 Tenon 写入用户级宿主子代理文件的路径与内容摘要；安装、卸载只动其中记着且未被用户改动的文件。
- **步骤清单**：按任务冻结的工作流步骤顺序，标出已过（✓）、当前（●）、未到（○）的一行终端提示；由 hook 在关键 Tenon 命令
  成功后打印，不依赖宿主的 Todo 工具。
  _Avoid_：进度条、Todo 列表

## Sessions and review gates

- **会话绑定**：一个宿主会话与一个 Change 的一对一关联，由入口技能激活任务时建立；一个 Change 同一时刻只属于一个会话。
  _Avoid_：会话指针、per-session 指针
- **本会话任务**：当前会话正在推进的 Change。有会话绑定时就是绑定的那个；宿主不提供会话标识时才按恢复候选推断。门禁、确认与
  技能证据都以它为准。
  _Avoid_：active change、当前任务（泛指时）
- **恢复候选**：按用户记录的、最近一次被显式选择的 Change，只在用户明确要求继续或恢复时用来接手任务；同一用户的所有会话共用一份。
  _Avoid_：活跃任务指针、per-session 指针
- **移交**：一个 Change 的会话绑定从旧会话转到新会话，旧会话随之不再拥有该 Change。
- **待处理标记**：评审门、交互门留在项目里的短时提示，表示某个决定正在等人；它只是投影，放行依据是评审回执。
  _Avoid_：锁文件
- **标记归属**：一条待处理标记属于哪个会话或哪个 Change；只有归属方会被它拦住，也只有归属方的确认能解除它。
- **评审回执**：某个 Change 在某一步、某条出边上的人工确认记录，依次处于待确认、已批准、已被流转消费三种状态。
  _Avoid_：审批记录
- **撤销回执**：把已批准但尚未被流转消费的评审回执退回待确认，并留下原因。
  _Avoid_：撤回审批、取消评审
- **放行语**：用户对待决事项的确认说法；只有整条短回复正好是其中一句时才算确认，夹在长文本、引用或粘贴内容里的不算。
  _Avoid_：确认词、解锁口令

## Verification rounds

- **验证轮次 / 上限**：验证轮次是带评审门和回退边的步骤（default 里是验证）自上次重新计数以来被进入的次数，含当前这次；任务落到早于该步所有
  回退目标的步骤（default 里经 `requirements-changed` 回到规格）时重新计数，删标记、重跑命令、换 agent 都不清零。上限是这一步最多验证几轮
  （1 到 20），来源依次是内置默认 2、工作流步骤的 `max_rounds`、任务字段 `max_rounds`，后者覆盖前者，随工作流计划冻结。用完后 Tenon 不再自动
  回退，调高上限是用户的决定。
  _Avoid_：评审次数、评审预算（`review_budget` 已删除）、attempt
- **剩余阻断**：上限用完后，在当前代码候选上仍不通过的必需评审者，连同它的阻断级发现（键 `reviewer:<agent>`）。评审请求把它们冻结并逐条列给用户，
  只有用户的人工确认能接受，接受绑定当时的代码候选与评审者那次运行，代码或运行变了即失效；委托确认与 AFK 不能接受。失败的必需测试不属于剩余阻断，
  仍走步骤测试豁免。
  _Avoid_：接受偏差、豁免（豁免只覆盖必需测试）
