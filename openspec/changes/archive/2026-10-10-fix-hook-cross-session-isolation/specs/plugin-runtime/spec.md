# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Managed release source SHALL 绑定稳定标签版本

Native setup/update 发布的每个 managed runtime SHALL 记录来自已验证插件候选的稳定 SemVer 版本，并 SHALL 能与冻结的 target tag 和 target commit 对账。候选版本、插件 manifest、payload digest 或 target identity 不一致时 SHALL NOT 公开 selection。

上述约束只适用于正式安装与正式更新。`tenon setup --<host> --from-source <repo>` 产生的源码开发安装 SHALL 记录 `channel: dev`、仓库 commit、工作区是否有未提交改动、工作区摘要与技能索引摘要，MUST NOT 记录或冒充任何 stable target，也 MUST NOT 通过 stable target 的对账；正式安装与正式更新的行为 SHALL 保持不变。

#### Scenario: 版本化候选激活

- **WHEN** 宿主 inventory 证明 `v1.0.2` 插件根完整且 marketplace HEAD 等于 `v1.0.2` 的 peeled commit
- **THEN** managed release source 记录 `pluginVersion=1.0.2`
- **AND** stable launcher 原子切换到该 immutable payload

#### Scenario: 候选版本与目标标签不一致

- **WHEN** target tag 是 `v1.0.2`，但候选 manifest 或 inventory 报告其他版本
- **THEN** coordinator 拒绝 activation 和 ready evidence
- **AND** 旧 active runtime selection 保持可用

#### Scenario: 恢复 v1.0.1 旧 journal

- **WHEN** 旧 schema version 1 journal 的 Dashboard identity 没有 `serverVersion`
- **THEN** codec 保留可验证的恢复坐标而不是把整个 WAL 判为损坏
- **AND** coordinator 重新探测 Dashboard health 并只接受与目标 release 精确相等的 server version
- **AND** 缺失字段本身不构成 readiness 或完成证据

#### Scenario: v1.0.1 setup/update WAL 缺少 frozen stable target

- **WHEN** 版本化 installer 发现真实 v1.0.1 native `setup` 或 `update` WAL 处于 `preparing-host`、`candidate-resolved`、`activating-runtime`、`runtime-activated`、`starting-dashboard`、`dashboard-ready` 或 `evidence-committed`，且旧 schema 没有 `stableTarget` / `dashboardPort`
- **THEN** 磁盘 decoder 接受该精确旧形状，并保留原 operation、transaction id 与恢复坐标
- **AND** coordinator 在写 WAL、stop Dashboard、清 WAL 或执行任何新 mutation 前证明 successor `v1.0.2` tag/commit
- **AND** 证明成功后使用原 transaction id 将旧 WAL 一次原子转换为 `setup/preparing-host`、冻结目标与端口均完整的新事务
- **AND** `starting-dashboard` 的旧进程若在空探针之后迟到，只能由同一 successor transaction 按旧 release identity 精确 stop
- **AND** 缺目标的补偿 phase、operation/source 冲突或不可证明的 activation/Dashboard identity 均失败关闭，不改写旧 WAL
- **AND** successor tag 无法证明时旧 WAL 保持字节不变，旧 active runtime 与旧 Dashboard 保持可用

#### Scenario: 源码开发安装不冒充版本标签

- **WHEN** 用户在 Tenon 源码仓库执行 `tenon setup --claude --from-source .`
- **THEN** 新 managed release 记录 `channel: dev`、commit 与工作区、技能索引摘要
- **AND** release 中没有 stable target，正式版的标签对账不把它当作某个稳定版本

#### Scenario: 正式安装仍只认稳定标签

- **WHEN** 不带 `--from-source` 执行 `tenon setup --claude`
- **THEN** 行为与修改前一致，候选必须对得上冻结的稳定 tag 与 commit

## ADDED Requirements

### Requirement: 源码开发安装 SHALL 从仓库工作区整体构建并安装

`tenon setup --claude|--codex --from-source <repo>` SHALL 只在 `<repo>` 满足全部 Tenon 源码仓库判据时执行，判据为：
- 根 `package.json` 的 name 为 `tenon`；
- `.claude-plugin/marketplace.json` 的 name 为 `tenon` 且插件 source 为 `./`；
- 存在 `skills/sources.yaml`；
- 存在 `runtime/tenon-bootstrap.mjs`。

它 MUST 把宿主插件市场指向该仓库目录，并从仓库工作区构建托管运行时，沿用正式安装的事务、校验、原子切换与回滚。

上游技能正文与本机拉取索引 MUST NOT 提交进仓库。执行源码开发安装时，若 `skills/sources.yaml` 声明的上游技能缺失或本机拉取索引缺失，命令 SHALL 先按 `sources.yaml` 拉取并写入索引。任一技能拉取失败时，命令 MUST 在改动宿主与写入事务日志之前以失败退出。两次源码开发安装之间不得自动重拉。

源码开发安装 SHALL 写入本机安装通道标记并关闭自动更新。在开发安装状态下，`tenon update` MUST 默认拒绝，并提示用 `--from-source` 重新同步或用 `--to-stable` 切回正式安装。

命令行为的补充约定：

- `--dry-run` SHALL 只打印将要执行的计划，不拉取、不构建、不改宿主、不写运行时。计划包括仓库路径、当前身份、构建命令、宿主命令，以及写标记、关自动更新这两步。
- `--skip-build` SHALL 跳过构建步骤，直接使用工作区现有的构建产物。
- 宿主上还有未完成的旧插件迁移收敛回执（`cleanup-pending`）时，命令 MUST 拒绝，并提示先完成正式 setup。
- 安装成功后，托管 Dashboard 的 `/api/health` SHALL 报告 `channel: dev`、短 commit 与展示版本 `<version>+dev.<sha7>`，`version` 仍是插件版本。`tenon doctor` 的 `identity:release` SHALL 对开发安装给出黄色提示，说明它不是正式发布。

已知风险（用户确认接受）：`--from-source` 会执行所给仓库的构建，并把它的 hooks 与技能长期装进宿主。仓库判据全由仓库内容自己决定，agent 发起时也没有额外确认。它与 agent 能执行的任意命令同级，是开发者显式命令；文档 SHALL 写明这一点，不另加限制。

#### Scenario: 缺技能时先拉取再安装

- **GIVEN** 仓库工作区缺少 `sources.yaml` 声明的上游技能
- **WHEN** 执行源码开发安装
- **THEN** 先拉取缺失技能并写入本机索引，再完成安装

#### Scenario: 拉取失败不装半套

- **WHEN** 任一上游技能拉取失败
- **THEN** 命令失败退出，宿主插件与托管运行时都保持原样

#### Scenario: 非 Tenon 源码仓库

- **WHEN** 对不满足判据的目录执行 `--from-source`
- **THEN** 命令拒绝且不改任何状态

#### Scenario: 只看计划不改动

- **WHEN** 执行 `tenon setup --claude --from-source . --dry-run`
- **THEN** 打印计划并退出 0，宿主插件、托管运行时与本机标记都不变

#### Scenario: 开发安装下的更新

- **GIVEN** 当前是源码开发安装
- **WHEN** 执行 `tenon update --claude`
- **THEN** 命令拒绝并给出 `--from-source` 与 `--to-stable` 两条出路
- **AND** 执行 `tenon update --claude --to-stable` 时切回正式安装并清除开发通道标记

### Requirement: Tenon 源码仓库内 SHALL 检查已装版本与工作区是否一致

当前项目满足 Tenon 源码仓库判据时，会话开始 SHALL 比较已装的开发安装同仓库工作区是否一致。

- 判据只有两项：工作区摘要（安装内容路径集合的内容摘要）与技能索引摘要。
- commit 与工作区是否有未提交改动只用于展示，不是判据。只提交、不改安装内容（例如文档提交）MUST NOT 触发提示。

不一致时，会话上下文 SHALL 给出原因与同步命令 `tenon setup --<host> --from-source <仓库>`。命令里的仓库路径 SHALL 转义，使含空格的路径可以直接复制执行；仓库路径含控制字符时 MUST NOT 输出提示。已装的是正式安装时，同样提示切到源码开发安装。

检查 MUST fail-open，任何读取失败都不得阻断会话，也不得输出错误内容。完整比较 SHALL 由 `tenon doctor` 的 `source:drift` 检查执行，口径与会话开始时相同。

#### Scenario: 安装内容变了提示同步

- **GIVEN** 已装的源码开发安装之后，仓库里的 hook、技能或 CLI 源码有改动
- **WHEN** 在该仓库开始会话
- **THEN** 会话上下文提示「已装与源码不一致」并给出同步命令

#### Scenario: 只有提交不提示

- **GIVEN** 安装之后只提交了文档，安装内容与技能索引都没变，commit 从 A 变为 B
- **WHEN** 在该仓库开始会话
- **THEN** 不出现漂移提示

#### Scenario: 一致时不提示

- **WHEN** 已装记录与工作区的工作区摘要、技能索引摘要都一致
- **THEN** 会话上下文不出现漂移提示

#### Scenario: 仓库路径含控制字符

- **WHEN** 仓库所在路径含换行等控制字符
- **THEN** 不输出任何提示

#### Scenario: 非源码仓库不检查

- **WHEN** 当前项目不满足 Tenon 源码仓库判据
- **THEN** 不做比较、不输出任何提示

#### Scenario: 源码仓库里装的是正式版

- **WHEN** 已装的是正式安装，当前项目是 Tenon 源码仓库
- **THEN** 会话上下文提示改用源码开发安装并给出命令
