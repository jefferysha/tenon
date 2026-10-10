# Managed Plugin Runtime Specification

## Purpose

Define the contract that turns a native Tenon plugin installation or update into one
immutable, recoverable managed runtime with stable launchers, hooks, Dashboard ownership,
safe Change routing, and an evidence-bound Build-to-Verify handoff.
## Requirements
### Requirement: Native installation activates a verified managed release

For `tenon setup --codex` and `tenon setup --claude`, the system SHALL treat the native
host's reported plugin root as a candidate. It SHALL stage and verify that candidate before
publishing a managed runtime release, and it SHALL install only the selected native-host adapter.
All default-workflow skills distributed in the plugin SHALL remain available from the selected
release without a second workflow package or external skill install.

#### Scenario: First native installation succeeds

- **WHEN** a user runs `tenon setup --codex` and the host reports a complete plugin root
- **THEN** the system validates the candidate, publishes one managed release, writes stable
  `tenon` and `tenon-hook` launchers, and reports the required Codex hook-trust step
- **AND** it does not create the removed `pipeline` launcher or modify Claude configuration.

#### Scenario: Candidate validation fails during setup

- **WHEN** the host reports a candidate with a missing bundle, malformed hook, invalid manifest,
  symlinked payload entry, or failed CLI smoke check
- **THEN** setup exits non-zero and does not change active release selection or either stable launcher
- **AND** it reports the specific verification failure.

### Requirement: Active runtime selection is atomic and recoverable

The system SHALL store releases in immutable content-addressed directories and SHALL atomically
replace a selection record containing an active release and optional previous verified release.
Selection and the `tenon`/`tenon-hook` launcher pair SHALL form one recoverable transaction: after
any per-file rename or chmod interruption, exact old/new partial states SHALL converge to the
committed selection, while any third-party byte or mode state SHALL fail closed. All setup, update,
rollback, and retention mutations SHALL run under a cross-process lock and append an audit record.
The active and previous release SHALL never be pruned.

#### Scenario: Candidate update activates atomically

- **WHEN** `tenon update --claude` obtains and verifies a new candidate
- **THEN** the candidate is fully published before the active selection points to it
- **AND** the former active release becomes the previous verified release
- **AND** both stable launchers are exact for the committed selection before success is reported.

#### Scenario: Update is interrupted before selection publication

- **WHEN** staging or validation fails, or the process stops before selection publication
- **THEN** the previously active release remains selected and executable
- **AND** incomplete staging is not considered a managed release.

#### Scenario: Update is interrupted during launcher publication

- **WHEN** selection is committed and the process stops after either launcher rename or chmod
- **THEN** retry recognizes only an exact installer-owned old/new partial pair and completes both launchers
- **AND** an externally modified launcher remains indeterminate and is not overwritten.

### Requirement: Host hooks use a stable bootstrap ABI

The distributed native host hook manifest SHALL invoke the stable `tenon-hook` launcher and
SHALL NOT execute a hook directly from `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}`. The bootstrap
SHALL set the selected release root when invoking its payload hook so child hooks cannot
accidentally resolve assets from the mutable marketplace checkout.

#### Scenario: Marketplace checkout changes after activation

- **WHEN** a host marketplace cache is refreshed or replaced after a release is active
- **THEN** an existing host hook dispatches through the managed active release
- **AND** it does not execute a hook from the changed cache path.

### Requirement: Runtime corruption has recovery-only authority

If the bootstrap cannot validate or load the active release, it SHALL distinguish that condition
from a valid payload policy denial. It SHALL deny normal write-capable project operations and
accept only the exact local command `tenon runtime repair --rollback`. That recovery operation
SHALL validate and select only the persisted previous verified release; it SHALL retain the current
hardened, backward-compatible bootstrap instead of copying the previous payload's bootstrap, and
it SHALL not accept a path, download arbitrary code, delete project markers, or modify OpenSpec
workflow state.

#### Scenario: Previous release repairs an invalid active release

- **WHEN** active release integrity validation fails and a valid previous release exists
- **THEN** `tenon runtime repair --rollback` atomically selects the previous release
- **AND** the current hardened bootstrap remains byte-identical and can execute the verified v1 payload
- **AND** records a rollback audit event only after selection commit
- **AND** normal policy enforcement resumes from that release without PATH-resolved shell execution.

#### Scenario: No verified recovery release exists

- **WHEN** active release validation fails and there is no valid previous release
- **THEN** the recovery command exits non-zero with a reinstall instruction
- **AND** the bootstrap does not silently allow ordinary mutation.

### Requirement: Auto-update preserves the active runtime

The opt-in SessionStart auto-update path SHALL call the stable launcher, not a bundle located by
the host plugin root. A failed host refresh or candidate validation SHALL retain the active managed
release and write a diagnostic/audit record. A successful update SHALL affect a new host session
only.

#### Scenario: Auto-update candidate fails verification

- **WHEN** an opted-in automatic update downloads an incomplete candidate
- **THEN** the current active release and stable launcher remain unchanged
- **AND** the failure is visible through runtime status or doctor diagnostics.

### Requirement: Workflow routing never revives an unrelated change

The router SHALL assign exactly one explicit workflow owner to a request. A new objective SHALL
produce a new change even when a per-user `active-change` pointer or multiple unarchived changes exist. Only an
explicit resume request may bind to an eligible named or uniquely selectable change; modification
time SHALL NOT be used to bind a new request.

#### Scenario: New objective with stale active pointer

- **WHEN** an old active pointer exists and the user submits a new development objective
- **THEN** the router emits new-change intent and clears the old binding
- **AND** the pipeline creates a fresh change rather than reusing old tasks or phase state.

### Requirement: Managed release SHALL 以可对账 WAL 串联宿主与 runtime

setup/update SHALL 在同一逐 scope 跨进程锁和 durable WAL 内串联宿主 mutation、候选解析、
runtime 激活、Dashboard readiness 与 convergence evidence。宿主步骤的恢复 SHALL 依据 before
inventory 与 desired postcondition 对账，而不是依据外部命令是否曾返回。旧版 pending WAL 若缺少
足以证明 before/desired 的数据，SHALL 返回 indeterminate，MUST NOT 自动重放。native host
desired 中用于证明 marketplace identity 的字段 SHALL 只包含稳定身份语义；若历史 desired 仅在
嵌套 marketplace HEAD observation 上与重试 desired 不同，而 marketplace
root/source/sourceType 及真正目标 HEAD、plugin root、plugin version 全部相同，系统 SHALL 将
二者视为同一目标。任何非法 schema、未知键或真正身份/目标字段变化 SHALL 继续 fail closed。

#### Scenario: 进程在宿主 mutation 返回后崩溃

- **GIVEN** WAL 已持久化步骤的 before inventory 与 desired postcondition
- **WHEN** 恢复观察到 desired state 已成立
- **THEN** 步骤被补记为 completed
- **AND** 后续候选解析从当前权威 inventory 继续
- **AND** 宿主 mutation 命令不再执行。

#### Scenario: 旧 WAL 无法证明安全重试

- **WHEN** pending host step 只有 `started` 而没有 before/desired 对账数据
- **THEN** runtime 返回可诊断的 indeterminate
- **AND** 不改变宿主 inventory、active release、launcher 或 Dashboard。

#### Scenario: Marketplace 已达到旧 WAL 的同一目标

- **GIVEN** pending WAL 记录 marketplace identity 的旧 observation HEAD 和目标 HEAD B
- **AND** 重试 desired 的目标仍为 B，root/source/sourceType 均未变化
- **WHEN** 权威 inventory 已位于 B
- **THEN** 系统补记该宿主步骤 completed
- **AND** 不再次执行 marketplace mutation。

#### Scenario: 真正目标或身份发生变化

- **GIVEN** pending WAL 与重试 desired 的目标 HEAD、plugin version、plugin root、marketplace root/source/sourceType 任一不同
- **WHEN** 系统尝试恢复事务
- **THEN** 返回 indeterminate 并保留 WAL
- **AND** 不执行宿主 mutation 或 runtime 激活。

#### Scenario: 嵌套 marketplace HEAD 非 canonical

- **GIVEN** pending 或 completed WAL 的嵌套 marketplace HEAD 既不是 `null`，也不是 40 位小写 Git OID
- **WHEN** 系统解析 native desired identity
- **THEN** 将该 desired 判为非法且不等价
- **AND** 不执行宿主 mutation 或 runtime 激活。

#### Scenario: 真实 native 接线跨进程恢复

- **GIVEN** durable WAL 保存旧 observation HEAD，重启后的 native desired 保持同一目标与稳定身份
- **AND** 当前权威 inventory 已满足目标
- **WHEN** `desiredNativeHostPostcondition` 经 `runManagedHostCommand` 注入通用 managed host runner 并恢复事务
- **THEN** pending 与 completed 两种 checkpoint 都完成且 mutation 执行次数为零
- **AND** 移除 comparator forwarding 时该回归测试失败。

### Requirement: Dashboard 事务所有权 SHALL 使用 transaction id

release transaction 启动 Dashboard 时 SHALL 生成并传递当前 transaction id。Server 健康响应、
pidfile、WAL 与 managed Dashboard identity SHALL 保持该 id。inspect/adopt/stop SHALL 要求
`releaseId`、`stateScopeId`、`port`、`pid` 与 transaction id 全部精确匹配。普通 Dashboard
启动 SHALL 不携带 transaction id，且 MUST NOT 被 release transaction 收养或停止。

#### Scenario: 同 release 的普通 Dashboard 在两次探测间启动

- **GIVEN** release transaction 的 before probe 观察到端口为空
- **AND** 普通 Dashboard 在事务 start 前启动并报告相同 release/state scope
- **WHEN** 事务再次 inspect
- **THEN** 缺少当前 transaction id 的进程保持 preexisting
- **AND**事务不得 adopt 或 stop 该进程。

#### Scenario: 本事务进程在 journal 提交前已就绪

- **GIVEN** Dashboard 健康响应携带当前 transaction id
- **AND** 进程在 `dashboard-ready` WAL 写入前终止 coordinator
- **WHEN** 同一事务恢复
- **THEN** coordinator 通过精确 transaction id 收养真实 listener
- **AND** 后续失败时只停止该精确进程。

#### Scenario: 另一个事务启动同 release Dashboard

- **WHEN** 健康服务的 transaction id 与当前 WAL 不同
- **THEN** 当前事务返回 indeterminate 或 preexisting 诊断
- **AND** 不收养、不停止也不覆盖该服务。

### Requirement: Build→Verify SHALL 先全量收敛再独立复核

default workflow 的 Build SHALL 在冻结候选前完成一次覆盖完整 diff、全部受影响 capability、
失败路径和发行门禁的 pre-Verify convergence review，并以 canonical
`pre_verify_review_result=pass` 留下机器可检查结果。`build-complete` SHALL 在该结果缺失、pending
或 fail 时拒绝。`spec-complete`、`requirements-changed` 和 `verify-fail` 进入新的实现 visit 时
SHALL 把结果重置为 pending，MUST NOT 继承旧候选的 pass。

Verify SHALL 保持独立冻结基线审查。Reviewer brief SHALL 覆盖完整 frozen diff 和所有已登记
capability，不得只审上一轮 findings；所有适用并行轨 SHALL 全部完成后，主流程才 MAY 汇总一次
severity findings 并选择 `verify-pass` 或 `verify-fail`。重试 SHALL 同时回归已知 findings 和
重新审查完整 diff。Build convergence 与 Verify 的代码、E2E、视觉轨都 SHALL 以
Critical/High/Medium 全部清零且证据完整为 pass 门槛，MUST NOT 以偏差批准把已知 Medium 带入
Verify 或 Ship。

对 in-place Change，Build SHALL 在冻结前完成所有会重写 tracked implementation、configuration、
generated artifact 或 release asset 的命令，并确认没有存活 writer。Verify SHALL 对真实工作区
执行 repo-zero-output：会产生仓库写入的复验只能在保留权限与 symlink 的隔离副本运行，截图、
snapshot、trace、coverage、各轨原始审查产物与日志 SHALL 写到仓库外。所有轨完成并一次性聚合
后，canonical `verification_report` SHALL 作为唯一例外写入 workflow 声明的仓库内治理路径并
登记 digest-bound 证据；它不得被某一轨边跑边写。每条适用验证轨 SHALL 在开始和结束时计算同一
workspace fingerprint；任一瞬时漂移 SHALL 使该轨失败，MUST NOT 通过删除或还原产物伪造稳定
结论。

#### Scenario: Build 只完成聚焦测试但未做全量收敛审查

- **GIVEN** 当前实现的聚焦测试通过
- **AND** `pre_verify_review_result` 不是 `pass`
- **WHEN** 尝试执行 `build-complete`
- **THEN** guard 拒绝冻结 `build_sha`
- **AND** Change 保持在 Build。

#### Scenario: Verify 某一轨提前发现 High

- **GIVEN** Reviewer、E2E 与 Codex 轨并行审查同一冻结基线
- **WHEN** Reviewer 先返回一个 High finding
- **THEN** 主流程继续等待其他适用轨完成
- **AND** verification report 一次性包含全部轨的 findings
- **AND** 之后才请求 exact `verify-fail` review。

#### Scenario: Verify-fail 修复后重试

- **WHEN** Change 因 findings 回到 Build
- **THEN** `pre_verify_review_result` 重置为 pending
- **AND** Build 修复全部已知 findings 后重新执行完整 convergence review
- **AND** 下一轮 Verify Reviewer 同时回归旧 findings 并审完整 frozen diff。

#### Scenario: 收敛审查仍有 Medium

- **GIVEN** 全量 Build reviewer 已聚合全部适用检查
- **AND** 仍存在一个 Medium finding
- **WHEN** 尝试把 `pre_verify_review_result` 置为 pass
- **THEN** Build 协议拒绝通过并先修复该 finding
- **AND** 不得以批准偏差把该 Medium 交给 Verify。

#### Scenario: Verify 命令会重写 tracked 生成物

- **GIVEN** in-place Change 已冻结 workspace fingerprint
- **WHEN** 某 Verify 轨需要运行会重写 tracked 生成物的命令
- **THEN** 该命令只在保留权限与 symlink 的隔离副本运行
- **AND** 日志与各轨原始 QA 产物写到仓库外
- **AND** 全部轨结束后才在治理路径写入并登记 canonical 聚合 `verification_report`
- **AND** 真实工作区在该轨前后的 fingerprint 精确一致。

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

### Requirement: Dashboard 发布 SHALL 区分启动 readiness 与浏览器打开策略

Setup/update SHALL 始终从新 active managed payload 启动或收养 Dashboard 并证明 readiness。浏览器打开 SHALL 只发生在交互式首次 setup；curl 管道、CI、手动 update 和后台 auto-update SHALL NOT 自动打开，但 SHALL 输出健康 URL 和 `tenon dashboard --open`。浏览器打开失败 SHALL NOT 回滚已经健康的 runtime。

#### Scenario: 交互式首次 setup

- **WHEN** setup 在交互终端开始时没有有效 managed runtime，并完成 Dashboard readiness
- **THEN** Tenon 尝试打开已验证 URL
- **AND** 打开失败时保持成功安装并输出手动 URL
- **AND** 宿主候选此前是否已验证不改变首次 setup 判定

#### Scenario: 非交互安装或更新

- **WHEN** setup 来自 curl 管道/CI，或操作是手动 update/后台 auto-update
- **THEN** Dashboard 仍完成版本切换与健康检查
- **AND** 不调用 OS browser opener
- **AND** 输出已验证 URL 和 `tenon dashboard --open`（后台模式写入可审计日志）

#### Scenario: Dashboard 端口属于非受管进程

- **WHEN** 目标端口存在无法证明属于当前或前一 managed transaction 的 listener
- **THEN** coordinator 不 stop、adopt 或覆盖该进程
- **AND** 保留 journal 并返回不可证明诊断

### Requirement: Runtime audit SHALL 只把已提交状态报告为成功

Activation 和 rollback SHALL 先持久化 prepared 事件，完成 selection 原子提交后才 SHALL
追加 terminal success 事件。尾部任一非空 audit 记录损坏、截断或无法读取时，runtime
status 与 doctor SHALL 报告 `auditCorrupt`/degraded，不得把更早记录冒充为 latest。

#### Scenario: 进程在 selection 提交前崩溃

- **WHEN** activation 或 rollback 已写 prepared audit，但 selection 尚未提交
- **THEN** runtime status 不报告 activation/rollback 成功
- **AND** 重试只在确认 selection 后追加 terminal success

#### Scenario: audit 尾行被截断

- **WHEN** audit 最后一条非空记录不能完整解码
- **THEN** CLI 与 stable bootstrap 都报告 audit 已损坏
- **AND** 不返回更早记录作为 `lastAudit`

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

