# 完成决策控制与运行复盘

## Goal

在已完成的决策同步基础上，补齐安全门、Dashboard 控制面和运行复盘闭环，同时保持终端是唯一的大模型交互面。

## Scope

- 修复 server 的 `humanGateSatisfied` 硬编码，保证 CLI/server 的门禁语义一致。
- 在 pending review 期间检测 token 读取和 localhost 写接口访问，写入脱敏、可审计信号。
- Dashboard 增加 review 决策控制，只调用现有 review adapter，不调用模型、不回答 Skill 问题。
- 增加 Change 回放与产物版本 diff 的只读数据面；流程试运行和流程体检作为后续串行子任务。

## Acceptance Criteria

- 所有写入仍经过 Change lock、binding、revision 和幂等校验。
- Dashboard 无任何模型调用；HITL、AFK、terminal、dashboard 渠道可区分。
- token 和进程信息不进入日志明文；拒绝和异常路径 fail-closed。
- 每个子任务有独立测试、构建和架构检查证据。
