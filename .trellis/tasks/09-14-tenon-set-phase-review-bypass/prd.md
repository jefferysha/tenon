# 关闭通用字段写入口修改 phase 的 review 旁路

## Goal

禁止 `tenon set`、`tenon set-many` 和 `tenon cas` 通过通用字段写入口直接修改
`phase`。phase 是 workflow 状态机游标，必须由受保护的 `tenon transition` 用例更新，
以确保 transition guard、review receipt、revision 和 history 一起生效。

## Requirements

- 三个通用字段命令遇到 `phase` 都必须 fail closed，返回现有错误退出码 `1`，不写入 state，
  不追加 history。
- 拒绝逻辑与现有 review receipt 字段保护位于同一个 CLI adapter 边界；错误信息明确指出应使用
  `tenon transition`。
- 无 receipt、pending receipt 以及其他 phase 下都不能通过通用字段命令切换 phase；该保护不能依赖
  当前 review 状态或 phase 枚举。
- `tenon init --workflow` 等合法初始化路径继续通过 kernel 初始化事务设置首个 phase；transition、
  migration、legacy import 和测试 fixture 使用各自受控的 application/store 接口，不复用通用字段命令。
- 不修改 review receipt schema、Dashboard、LLM/Skill 交互、`humanGateSatisfied` 或 transition
  状态机语义。

## Acceptance Criteria

- [ ] `cmdSet`、`cmdSetMany`、`cmdCas` 对 phase（无 receipt 和 pending receipt）均返回 `1`，且
  state/history 无变化。
- [ ] 非 protected 字段的既有 set/set-many/cas 成功、CAS miss 和 review receipt 字段拒绝行为不回归。
- [ ] `tenon transition` 仍能完成合法 phase 变更；`tenon init --workflow` 仍能原子设置自定义
  workflow 首步。
- [ ] 源码中不存在任何通过 CLI 通用字段命令修改 phase 的生产调用方；合法的 kernel 初始化、
  migration/import 和测试 fixture 入口有明确记录。
- [ ] 相关 Vitest、`npm run build`、CLI/server dist freshness、架构检查和 hook smoke 通过。

## Rollback

若验证失败，整体回滚本任务提交并停止发布；不得恢复通用 `set phase` 参数传递作为回滚方案。

