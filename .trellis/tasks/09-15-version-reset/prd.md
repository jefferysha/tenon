# 版本号重置为 0.1.x

## Goal

Tenon 还不成熟，版本号改为从 0.1.x 开始；已发布的 1.x 版本与已经安装 1.x 的机器得到明确处理，升级、降级判断不出错。

## Background (confirmed)

- GitHub 上已发布 v1.0.x（至少 v1.0.6–v1.0.9）与 v1.1.0–v1.1.5，其中 v1.1.5 标记为 Latest。
- 更新流程比较稳定版版本号并拒绝降级（`packages/cli/src/commands/update-native.ts:19,104,197` 的 `compareStableVersions`；
  测试 `update.test.ts:655,687`「newer installed stable version rejects downgrade」）；0.1.0 小于 1.1.5，会被当成降级拒绝。
- CI 的兼容性门禁使用固定的上一版本 `tools/fixtures/n-minus-one-release.json`（v1.0.1）。
- 版本号分布在根 `package.json`、各 workspace、两个插件清单、marketplace、`install.sh`、`plugin-host.ts`、宿主计划常量、
  README 与安装文档固定链接、`package-lock.json`。

## Key Decisions

- 2026-09-15 用户要求：Tenon 版本从 0.1.x 开始，而不是 1.x。
- 2026-09-15 用户确认：已发布的全部 1.x 版本（v1.0.x–v1.1.5）的 GitHub Release 与标签全部删除（远端与本地）。
- 执行顺序：先发布并验收 v0.1.0，再删除 1.x，避免中间没有可安装的正式版本；兼容性门禁的「上一版本」对 v0.1.0 不存在，
  v0.1.0 这一次明确跳过该门禁并在发布说明注明，从 v0.1.1 起以 v0.1.0 为基线。

## Requirements

- R1 下一个发布版本号为 0.1.0，之后按 0.1.x / 0.x 递增；所有版本号位置一致。
- R2 v0.1.0 发布并通过公开安装验收后，删除全部 1.x 的 GitHub Release 与标签（远端与本地）；「Latest」指向 v0.1.0；
  仓库中指向 1.x 的安装链接全部改为 0.x。
- R3 已安装 1.x 的机器能迁移到 0.1.0：安装与更新不会把它当作降级拒绝，也不会静默保留 1.x。
- R4 版本比较在 0.x 线内正常工作（0.1.1 > 0.1.0，0.2.0 > 0.1.9），1.x 迁移只发生一次。
- R5 CI 兼容性门禁的上一版本基线：v0.1.0 发布时跳过并注明；之后以最近的 0.x 正式版本为基线，不再引用已删除的 1.x。
- R6 文档与发布说明说明版本号重置。

## Acceptance Criteria

- [ ] 发布流水线产出 v0.1.0，公开安装验收通过，GitHub Latest 指向 v0.1.0。
- [ ] GitHub 上不再存在任何 v1.x 的 Release 与标签（`gh release list`、`git ls-remote --tags` 均为空）。
- [ ] 一台已装 v1.1.5 的机器执行官方安装或 `tenon update` 后运行 v0.1.0，doctor 健康。
- [ ] 之后发布 v0.1.1 时，从 v0.1.0 更新正常；手动安装 v0.1.0 覆盖 v0.1.1 时按降级规则处理。
- [ ] 仓库中不再出现旧的 1.x 当前版本号（历史发布说明除外）。

## Out of Scope

- 重写历史发布说明内容。

