# C 实施计划

1. 读取 A/B 的冻结契约和相关 spec。
2. 先将 CLI acknowledge 编排迁移到共享 application，保留 CLI 输出/退出码适配，并用 characterization tests 证明 receipt、binding、marker、interaction、history 和 rejected acknowledgement 语义不变。
3. 实现只读 projection 与稳定 decision ref；review consumed 只使用 TransitionRecord + interaction 链。
4. 实现 review、Skill、AFK command adapter，统一 expected revision、幂等和冲突结果；server 调用共享 application，不导入 CLI。
5. 接入 `/api/stream` 或既有读取刷新，不承诺阻塞终端问答强唤醒；实现模式切换事件和 B 冻结的脱敏自审批告警，或链接已拆出的安全子任务。
6. 增加跨域 fixture 和 server/kernel/dashboard API 测试。
7. 运行 kernel/server/CLI bundle/web/hook 相关验证；UI 决策台另立任务。
