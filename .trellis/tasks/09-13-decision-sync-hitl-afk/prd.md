# 决策同步与 HITL/AFK 收敛（父任务）

## Goal

协调三个可独立验收的交付物：关闭 review transition 自审批旁路、冻结决策同步契约、实现待决策投影与命令适配。产物 diff、决策台、Change 回放和流程体检另立后续任务。

## Scope

### Child A — close-review-bypass

移除 review-gated transition 对 `humanReviewApproved` 的无条件豁免，删除无合法调用方的字段与内核分支，补齐 binding、HTTP 映射和回归测试。A 是当前唯一先启动的实现子任务。

### Child B — decision-sync-contract

只做设计和 spec 更新，不实现 Dashboard projection、HTTP command adapter 或 UI。定义三类记录域、只读待决策投影、command mapping、同步/冲突语义、HITL/AFK 映射、AFK/source/channel 归因和安全边界，并冻结共享 acknowledge application 的抽取前提。

### Child C — pending-decision-adapter

实现只读待决策 projection 和按类型 command adapter。C 依赖 B 的冻结契约，暂不实现 diff、决策台、回放或流程体检 UI。

## Cross-child constraints

- Dashboard 永远不调用大模型、不生成 prompt、不启动 Skill；终端是唯一大模型交互面。
- 不新增第二套持久化决策真相；projection 只能读取并关联现有 receipt/events。
- review、Skill interaction、recommended-default、AFK 保留各自 canonical writer。
- 用户层使用 HITL/AFK 两种模式；内部保留 `interactive`/`recommended-defaults`/`afk`。
- `review_gate_status` 保持 `pending | approved`；superseded/迟到回答由追加事件和 projection 推导；expired 在契约任务中明确为 deferred，未定义前不进入实现。
- 同用户 token 不是人类身份认证；系统只承诺 fail-closed、revision/digest 绑定、渠道归因和异常发现。
- 模式切换必须产生可审计事件，不能把一次模式切换伪装成用户回答。门禁待批期间 hook 读取 token 或调用本地控制接口时，应记录脱敏告警；告警事件和责任在 B 冻结、C（或明确拆出的后续安全子任务）实现。

## Parent acceptance

- [ ] A、B、C 均有独立 PRD、验收标准和验证证据。
- [ ] A 关闭现存 review bypass 且不静默删除 transition API。
- [ ] B 冻结跨层契约并更新相关 spec。
- [ ] C 只实现 B 已冻结的 projection/adapter，不提前实现后续 UI。
- [ ] 父任务不包含产物 diff、决策台、Change 回放或流程体检实现。

## Branch strategy

- 父任务保留当前 checkout 作为协调和证据记录，不在当前工作区直接实现业务代码；启动时记录实际 HEAD、分支和 dirty inventory，不把历史数量写死在计划中。
- A 使用基于启动时冻结 HEAD 的独立 worktree/分支，避免与其他任务混提交；新 worktree 第一步运行 `npm ci`。
- B 在 A 的独立变更完成并通过检查后基于最新目标分支规划；C 等 B 设计评审通过后再启动。
