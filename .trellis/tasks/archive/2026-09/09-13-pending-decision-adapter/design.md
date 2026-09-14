# C 设计边界

C 只能实现 B 已冻结的 projection 和 command adapter。投影应从现有 review receipt、interaction event、invocation/attempt 和 workflow run 数据构造；任何新增 canonical 字段或 event schema 必须回到 B 重新评审。Dashboard review command 只能调用 B 抽取的共享 review application function，不得复活 `humanReviewApproved` bypass。

C 负责把 CLI acknowledge 编排迁移到共享 application 后接入 server；共享层不得反向依赖 CLI。C 负责模式切换事件的写入/读取适配和 pending 期间 hook 的脱敏 token/local-API 告警，告警只能作为检测信号，不能作为人类身份证明。projection 对 review 的 consumed 必须使用 TransitionRecord + interaction 链，字段已清空但缺链时返回 unknown/incomplete。
