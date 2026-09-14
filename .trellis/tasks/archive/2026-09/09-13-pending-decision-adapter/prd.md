# 实现待决策投影与命令适配

## Goal

按 B 冻结的契约，实现只读 PendingDecisionView 和 review/Skill/AFK command adapter，不新增第二套持久化状态。

## Dependencies

- 必须等待 A 完成并通过检查。
- 必须等待 B 设计/spec 评审通过。
- 必须先完成 B 定义的共享 review acknowledge application 抽取：CLI 改为调用共享层，server 复用同一实现，不复制编排。
- 不实现产物 diff、决策台 UI、Change 回放或流程体检。

## Acceptance Criteria

- [ ] review、Skill、AFK 三类 canonical writer 保持不变。
- [ ] projection 能带出 decision ref、类型、anchor、revision、evidence、source/channel 和 command kind。
- [ ] review adapter 只能消费 exact pending receipt，并调用与 CLI review acknowledge 相同的 application function。
- [ ] expected revision、幂等、重复提交、迟到回答和 stream refresh 有定向测试。
- [ ] AFK source 通过 decision→invocation join 正确投影。
- [ ] Dashboard 不包含模型调用、prompt 生成或 Skill 启动代码。
- [ ] 实现 B 冻结的模式切换事件和 token 自审批告警信号；若告警实现被拆出，C 的验收必须链接到该独立任务而不得标记父任务完成。
