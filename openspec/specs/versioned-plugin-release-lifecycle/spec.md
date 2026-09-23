# versioned-plugin-release-lifecycle Specification

## Purpose
TBD - created by archiving change versioned-release-install-lifecycle-20260808. Update Purpose after archive.
## Requirements
### Requirement: 稳定 SemVer Release SHALL 是唯一用户交付身份

Tenon SHALL 只把官方仓库中不可变、完整、稳定的 `vX.Y.Z` Release 用作公开安装、更新、回滚识别和运行时完成证据。`main` 或其他移动分支可以用于合并和候选资格验证，但 SHALL NOT 作为 Marketplace ref、公开安装 URL、update target 或 ready evidence。

#### Scenario: 新用户复制官方安装命令

- **WHEN** 用户从 README 或正式安装文档复制 Codex 一行安装命令
- **THEN** 脚本 URL 和 Codex Marketplace ref 都绑定同一个完整稳定 `vX.Y.Z`
- **AND** 安装结果的插件版本、managed runtime source 和 Dashboard health 版本与该标签一致
- **AND** 安装过程不读取 `main` 或本地开发 checkout

#### Scenario: 发布工作流验证已合并候选

- **WHEN** release candidate workflow 验证候选是当前默认分支的精确已合并提交且 canonical CI 成功
- **THEN** workflow 可以把该提交创建为新的不可变稳定 SemVer 标签
- **AND** 标签创建后用户交付身份只引用该标签，不把默认分支描述为发布通道

### Requirement: 一键更新 SHALL 在 mutation 前冻结 latest stable Release

从 v1.0.2 起，`tenon update --codex` SHALL 从官方 GitHub Releases 元数据解析 latest stable，并在任何宿主或 runtime mutation 前冻结目标版本、标签和 peeled commit。解析 SHALL 拒绝 draft、prerelease、非完整稳定 SemVer、仓库身份不匹配、标签证明失败、超时、网络失败和 schema 异常，且 SHALL NOT 回退到移动分支或移动标签。

#### Scenario: latest stable 解析成功

- **WHEN** 官方 Releases 元数据返回非 draft、非 prerelease 的 `v1.0.2` 且标签 peel 到可验证提交
- **THEN** 本次 update 冻结 `targetVersion=1.0.2`、`targetTag=v1.0.2` 和精确 target commit
- **AND** 后续所有宿主 desired-state 与候选校验消费同一个冻结目标

#### Scenario: Release 元数据不可证明

- **WHEN** Release 响应超时、损坏、属于 prerelease/draft、标签不满足稳定 SemVer 或无法证明提交
- **THEN** update 失败并输出可操作诊断
- **AND** 不执行 plugin、marketplace、managed runtime 或 Dashboard mutation

#### Scenario: 已退役 1.x 用户迁移到 0.x 版本化通道

- **WHEN** 用户当前 launcher/runtime 是无法追溯修改的已退役 1.x（v1.0.0–v1.1.5）
- **THEN** 文档要求为每个宿主执行一次固定到当前正式版本 `install.sh` 的官方迁移命令
- **AND** 安装器在同一调用中把 plugin、marketplace、runtime 与 Dashboard 收敛到该正式版本
- **AND** 不宣称旧 1.x `tenon update` 能同进程运行尚未激活的新版 updater，它只报告降级且不做任何改动
- **AND** v0.1.0 起的后续升级只需单条 `tenon update --codex`

#### Scenario: v1.0.1 收敛 receipt 遇到已经重绑的 v1.0.2 宿主

- **WHEN** 公开 installer 已把宿主精确绑定到 `v1.0.2`，但本机仍保留 active v1.0.1 runtime 和旧 cleanup-pending receipt
- **THEN** 同一次 installer 调用先验证并发布 v1.0.2 runtime 与 Dashboard，而不是按旧 receipt 删除或拒绝新宿主
- **AND** ready evidence 后把旧 receipt 原子升级为绑定 v1.0.2 release、stable target 与新 transaction 的 v4 receipt
- **AND** 即使存在旧 release 的有效 SessionStart proof，本次调用也不按它提前删除旧插件入口

### Requirement: 版本化宿主重绑定 SHALL 可对账恢复

跨版本 Codex 更新 SHALL 只通过 Codex 公开 CLI 执行 plugin remove、marketplace remove、目标标签 marketplace add、plugin add 和 inventory。每个 mutation SHALL 在现有 managed-release WAL 中记录精确 desired-state，恢复时 SHALL 观察真实宿主状态并只在等价目标上继续。

#### Scenario: 重绑定在 marketplace 删除后中断

- **WHEN** plugin 和旧 marketplace 已由 Codex CLI 删除，但进程在目标标签 marketplace add 前中断
- **THEN** 已激活的 stable Tenon launcher 和旧 managed runtime 保持可用
- **AND** 用户重跑同一 `tenon update --codex` 后从 WAL 的下一安全步骤恢复
- **AND** Tenon 不直接编辑或伪装回滚 Codex 私有 cache

#### Scenario: 恢复时观察到第三状态

- **WHEN** WAL 目标是 `v1.0.2`，但宿主 marketplace 已被外部操作改为其他来源、标签或根
- **THEN** update 进入不可证明状态并停止
- **AND** 不把第三状态当成命令幂等成功

### Requirement: 版本收敛 SHALL 以 inventory 和运行时证据判定

更新成功 SHALL 同时证明 marketplace HEAD 等于目标标签提交、插件 inventory 版本等于目标版本、插件根可验证、打包资产完整、managed runtime source 版本一致且 Dashboard readiness 属于该 release。命令退出码或文本 SHALL NOT 单独构成成功。

#### Scenario: 宿主命令成功但插件仍是旧版本

- **WHEN** Codex 命令返回成功，但 inventory 仍报告旧版本或旧根
- **THEN** 候选 SHALL NOT 激活
- **AND** update 输出版本收敛失败并保留恢复证据

#### Scenario: 当前版本已是 latest stable

- **WHEN** 当前已验证插件、marketplace tag 和 managed runtime 已全部等于 latest stable
- **THEN** update 幂等成功且不重复重绑 marketplace 或创建重复 managed release

#### Scenario: latest stable 低于当前版本

- **WHEN** resolver 返回的稳定版本低于当前已验证版本
- **THEN** 常规 update 拒绝隐式降级
- **AND** 只允许现有显式 runtime repair 在本机已验证 release 间回滚

#### Scenario: candidate-resolved 后宿主或候选漂移

- **WHEN** journal 已记录 candidate-resolved，但 activation 前 marketplace ref/HEAD/clean、plugin root 或候选 payload 被外部修改
- **THEN** coordinator 重新观察 frozen target 与候选完整性并拒绝第三状态
- **AND** journal 中旧 inventory/evidence 不单独构成 activation 证明

#### Scenario: cleanup receipt 完成旧插件清理

- **WHEN** 新宿主会话提供晚于 cleanup-pending receipt 且绑定同一 release/root 的 proof
- **THEN** coordinator 在同一个 managed transaction 内依次重新证明 stable tag、宿主 ref/HEAD/clean/root/version、payload digest、active runtime 与 Dashboard
- **AND** 旧 v2/v3 receipt 在任何 remove 前持久化升级为带 `stableTarget` 的 pending v4
- **AND** 官方 remove 后再次证明完整 identity，最后才写 completed v4
- **AND** 任一证明失败时不执行后续清理，也不把未复证的清理写成 completed
