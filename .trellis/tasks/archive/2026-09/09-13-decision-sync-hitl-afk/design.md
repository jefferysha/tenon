# 父任务协调设计

父任务不定义新的跨层实现细节，只冻结子任务边界和依赖：

1. A 先关闭 `humanReviewApproved` 旁路，并删除字段、内核分支和误导性 Dashboard host-bound 注释；普通 transition route 保留。
2. B 负责把现有 review receipt、Skill interaction event、recommended-default 和 AFK invocation 组织成一份可实施的跨层契约。B 必须明确 review receipt 的渠道字段是否作为 canonical state 新增字段，以及 AFK decision 如何从 invocation 关联得到 source。
3. B 必须先定义并冻结共享 review-acknowledge application 层；C 负责把 CLI 现有编排迁移到该共享函数后，再由 server adapter 调用它。共享函数承载 receipt 写入、binding 校验、marker/interaction/history 副作用和 rejected acknowledgement 记录，CLI 只保留输出与进程退出适配，server 不得依赖 CLI 包。
4. C 只按 B 的契约实现 projection 和 command adapter。Dashboard review adapter 必须调用上述共享 application 函数，前提是已有 exact pending receipt；不能重新实现 transition bypass。
5. 产物 diff、决策台 UI、Change 回放和流程体检拆到后续任务。

A 的回滚策略是整个提交回滚并停止发布，不恢复安全旁路参数。A 的 HTTP 合同必须定义 `review-approval-required` 的状态码和稳定 JSON body。

review 的 `consumed` 不能只看清空后的 canonical receipt 字段；必须由匹配的 TransitionRecord（event/from、run/step anchor、状态 revision/hash）和成功 interaction 链共同推导，证据缺失时显示 unknown/incomplete。
