# Single Plugin Distribution Specification

## Purpose

Define a complete, immutable, host-selectable plugin release with one
canonical Skill content root and ownership-safe installation behavior.
## Requirements
### Requirement: One release contains the complete pipeline product

Every published Tenon plugin release SHALL contain its CLI, seven-phase workflow, OpenSpec
document contract, mandatory skills, hooks, dashboard, AFK/tap/channel subsystems, templates, and
registered adapters. Selecting a host SHALL select installation ownership and SHALL NOT remove
other packaged product capabilities.

#### Scenario: A clean Codex user installs the plugin

- **WHEN** the user installs the release and runs `tenon setup --codex`
- **THEN** the selected Codex installation exposes the complete default pipeline and bundled skills
- **AND** it does not require a separate workflow or mandatory-skill installation.

### Requirement: Setup and update require one explicit host

Setup and update SHALL require exactly one supported host selector. Native Codex and Claude
selectors SHALL use only that host's marketplace inventory. Registered non-native adapters SHALL
apply only the selected adapter and SHALL NOT claim native automatic-update ownership.

#### Scenario: Host selection is ambiguous

- **WHEN** setup receives zero selectors or more than one selector
- **THEN** it exits non-zero with examples such as `tenon setup --codex`
- **AND** it does not modify any host or active runtime selection.

#### Scenario: One native host is selected

- **WHEN** the user runs `tenon setup --codex`
- **THEN** setup resolves and activates only the Codex-reported package
- **AND** it does not configure Claude merely because Claude metadata is included in the release.

### Requirement: Native hosts activate a verified immutable runtime

A native host checkout SHALL be treated as a candidate rather than an executable trust root.
Setup/update SHALL reject incomplete or symlinked payloads, validate the CLI, hooks, manifests, and
skills, publish a content-addressed immutable release, and atomically select active and previous
verified releases before installing stable launchers.

#### Scenario: Candidate verification fails

- **WHEN** a selected host reports a missing, malformed, symlinked, or smoke-test-failing candidate
- **THEN** publication exits non-zero and preserves the active release and launchers
- **AND** runtime diagnostics identify the rejection.

#### Scenario: Active payload changes after publication

- **WHEN** the selected active payload digest no longer matches its manifest
- **THEN** normal execution is refused and status reports the active release invalid
- **AND** only exact stable rollback to a verified previous release remains authorized.

### Requirement: Releases support bounded host-owned updates

Native releases SHALL support `tenon update --codex` and `tenon update --claude`. Automatic
update SHALL be explicit opt-in, scoped to the selected host, bounded to once daily, executed
through the stable launcher, and visible through durable diagnostics. A successful update SHALL be
observed by a new host session.

#### Scenario: Automatic update fails

- **WHEN** host refresh or candidate validation fails during an opted-in automatic update
- **THEN** the active managed release remains selected
- **AND** an `update-rejected` event is visible through runtime status or doctor.

### Requirement: Mandatory workflow skills are bundled

Every skill token required by the default workflow SHALL resolve to a concrete first-party
`SKILL.md` in the same plugin release. External tools and third-party skills MAY be optional
extensions but SHALL NOT block creating, advancing, verifying, or archiving a default Change.

#### Scenario: Package verification finds a missing skill

- **WHEN** a mandatory registry token has no packaged skill directory or resolves externally
- **THEN** package verification fails before the release is activated.

### Requirement: One plugin release SHALL expose one canonical Skill root

The repository `skills/<id>/SKILL.md` tree SHALL be the only maintained source
of first-party Skill content. Packaging SHALL copy that tree once into the
immutable plugin payload, and a running native installation SHALL expose
exactly one Selected Skill Root for that release. Manifests, registries,
workflows, tests, and documentation SHALL reference canonical Skill IDs rather
than duplicate Skill content.

#### Scenario: Native Codex setup is repeated

- **WHEN** `tenon setup --codex` or its idempotent update path is run more
  than once
- **THEN** exactly one immutable selected payload Skill root is discoverable
- **AND** no same-name project or user projection is added.

#### Scenario: Package verification finds duplicate Skill content

- **WHEN** two maintained payload paths claim the same canonical Skill ID
- **THEN** release verification fails before activation
- **AND** identifies both paths.

### Requirement: Native and static Skill projections SHALL be mutually exclusive

The Codex compatibility adapter MAY create project `.agents/skills` links only
for a host that cannot discover the native tenon plugin. When a verified
native Selected Skill Root exists, the adapter SHALL skip project Skill
projection. Switching modes SHALL not leave both roots discoverable.

#### Scenario: Adapter detects a native installation

- **GIVEN** a verified native tenon Selected Skill Root
- **WHEN** the compatibility adapter runs for the project
- **THEN** it installs no tenon project Skill links
- **AND** diagnostics report the native selected root as authoritative.

#### Scenario: Static-only host needs compatibility discovery

- **GIVEN** no native tenon plugin capability or selected root exists
- **WHEN** static adapter installation is explicitly selected
- **THEN** the project projection is the sole tenon discovery root
- **AND** rerunning installation remains idempotent.

### Requirement: Legacy duplicate migration SHALL be ownership-safe

A migration from static projection to native discovery SHALL remove only
tenon-owned symlinks whose lexical target and resolved target match the
adapter's expected source Skill. It SHALL never delete a real directory, a user
file, or a foreign symlink. Ambiguous ownership SHALL fail closed with an
actionable diagnostic.

#### Scenario: Owned legacy links are removed during native migration

- **GIVEN** a project Skill link is a symlink created by the compatibility
  adapter and still resolves to its exact expected source
- **WHEN** native discovery becomes authoritative
- **THEN** the migration may remove that link
- **AND** records the selected native root.

#### Scenario: User-owned content has the same Skill ID

- **GIVEN** the project path is a real directory or points outside the expected
  adapter source
- **WHEN** migration encounters the same canonical Skill ID
- **THEN** the path is preserved
- **AND** setup reports a shadow conflict instead of overwriting or deleting it.

### Requirement: Skill diagnostics SHALL distinguish duplicate projection and shadow conflict

Doctor and installation checks SHALL enumerate all relevant discovery roots,
compute canonical content digests, and report the Selected Skill Root. Multiple
roots with the same ID and digest SHALL be reported as
`duplicate-projection`; the same ID with different digests SHALL be reported as
`shadow-conflict` and SHALL fail closed for execution. Historical cache roots
SHALL not be silently added to the active candidate set.

#### Scenario: Same content appears in two discovery roots

- **WHEN** the same canonical Skill ID and digest are discoverable from native
  and project roots
- **THEN** doctor reports `duplicate-projection`
- **AND** selects only the native canonical root
- **AND** recommends or performs only ownership-safe convergence.

#### Scenario: Different content shadows a canonical Skill

- **WHEN** one Skill ID resolves to different digests in discoverable roots
- **THEN** doctor reports `shadow-conflict` with both sources
- **AND** evidence and execution fail closed until the conflict is resolved.

### Requirement: Default workflow evidence remains generated and consumed

Packaging and updates SHALL preserve the digest-bound default workflow document contract:
proposal/design/tasks at Open; Superpowers design and ADR at Explore; delta spec and plan at Spec;
verification report at Verify; applied main spec receipt at Ship; and complete read receipts before
review transitions and Archive.

#### Scenario: A later phase has not read a changed document

- **WHEN** a required document is missing, stale, or lacks the current phase's read receipt
- **THEN** the phase guard rejects transition even if the file exists on disk.

### Requirement: Dashboard health identifies the active release

Native setup and successful update SHALL run or hand off the dashboard from the active immutable
release. The default dashboard port SHALL remain `18765`, and `/api/health` SHALL expose the exact
active release identifier.

#### Scenario: A new release takes dashboard ownership

- **WHEN** a verified release becomes active and setup completes
- **THEN** the dashboard responds on the configured port
- **AND** the health release ID equals runtime status's active release ID.

### Requirement: Dashboard health identifies the active machine-state scope

受管 Dashboard 单例 SHALL 同时标识当前不可变 release 与项目注册表、token、密钥和 pidfile
共同使用的机器状态作用域。进程装配层 SHALL 只调用一次产品路径解析器，并把同一个不可变
`ServerPaths` 值对象作为必填依赖注入 Server；Server SHALL NOT 从宿主 home 或进程环境再次推导
产品状态路径。
健康响应 SHALL 暴露不透明且确定性的 `stateScopeId`，并 SHALL NOT 暴露机器状态目录。
该标识只用于身份比较，SHALL NOT 被接受为授权凭据。

#### Scenario: Same release starts for a different state Home

- **GIVEN** a healthy Dashboard is listening on the configured port for state scope A
- **WHEN** the same immutable release is explicitly started with state scope B
- **THEN** the existing process is not reused
- **AND** takeover may proceed only after the reported PID is verified as the real loopback
  listener owner
- **AND** the new health response carries state scope B's identifier.

#### Scenario: Same release starts for the same state Home

- **GIVEN** a healthy Dashboard is listening for the requested state scope and release
- **WHEN** the managed launcher starts again
- **THEN** it reuses the existing process
- **AND** does not replace or duplicate the singleton.

#### Scenario: Legacy health has no state-scope identity

- **GIVEN** a prior Dashboard health response has no `stateScopeId`
- **WHEN** a scope-aware managed Dashboard starts
- **THEN** the legacy process is treated as a one-time migration takeover candidate
- **AND** listener ownership verification remains mandatory before signalling it.

#### Scenario: Managed startup waits for the exact intended process

- **WHEN** setup or update starts a Dashboard from an immutable release
- **THEN** readiness succeeds only when both `releaseId` and `stateScopeId` match the launcher
  expectation
- **AND** a browser is not opened for a process with a mismatched state scope.

#### Scenario: 生产入口装配 Dashboard

- **WHEN** Dashboard 进程使用当前环境与宿主 home 启动
- **THEN** 入口只解析一次完整 `ServerPaths`
- **AND** 注册表、密钥、token、pidfile 与 `stateScopeId` 全部消费该同一快照
- **AND** Server 内部不再次读取进程环境以重建产品路径。

#### Scenario: 显式路径与共享环境并存

- **GIVEN** 调用方提供一组显式 `ServerPaths`
- **AND** 进程环境同时包含指向另一个运行目录的 `TENON_RUNTIME_HOME` 或 XDG 根
- **WHEN** Server 启动并读写机器状态
- **THEN** 它只使用显式注入的路径
- **AND** 不读写共享环境所指向的目录。

#### Scenario: 宿主发现目录与产品状态目录不同

- **GIVEN** 调用方提供的 `hostHome` 与 `ServerPaths.homeDir` 不同
- **WHEN** Server 检查 skills、runner 资产、默认 Codex 凭证或 mem session
- **THEN** `.claude`、`.codex`、宿主会话与其他宿主资产只从 `hostHome` 派生
- **AND** 注册表、密钥、token、pidfile 与状态作用域仍只使用 `ServerPaths`
- **AND** Server 不读取 OS 全局 home 作为第三个隐式来源。

#### Scenario: Server 调用方省略路径依赖

- **WHEN** 代码尝试在未提供 `ServerPaths` 的情况下创建 Dashboard Server
- **THEN** TypeScript 契约在编译期拒绝该调用
- **AND** Server 不提供读取 `process.env` 的隐式 fallback。

#### Scenario: 路径解析失败

- **WHEN** 进程装配层收到损坏或不可接受的运行目录契约
- **THEN** 启动在绑定端口之前 fail-closed
- **AND** 不创建部分注册表、密钥或 pidfile 状态。

### Requirement: Machine-state scope identity is canonical and path-private

The state-scope identifier SHALL be derived by one shared first-party primitive from a namespaced
canonical absolute state-Home path. Equivalent relative/trailing-slash inputs SHALL produce the
same identity. The health response, server log and pidfile SHALL NOT contain the state-Home path.

#### Scenario: Lexically equivalent state roots

- **WHEN** two inputs resolve to the same absolute path
- **THEN** they produce the same full-length versioned state-scope identifier.

### Requirement: 新用户 SHALL 无需 clone 一步安装完整插件

Tenon SHALL 提供一行 Marketplace bootstrap，用户只选择一个宿主。bootstrap SHALL 注册
`jefferysha/tenon` Marketplace、安装 `tenon@tenon`、从宿主 inventory 解析真实安装根、
验证完整 payload，再调用包内 `tenon setup --<host>`。用户不得被要求手动 clone、安装 monorepo
依赖、运行 build 或拼装 Skills。

#### Scenario: Codex 新用户执行一行安装

- **WHEN** 用户执行官方 bootstrap 并选择 `--codex`
- **THEN** Codex Marketplace 安装一个完整 Tenon 插件
- **AND** CLI、七阶段 workflow、OpenSpec、Skills、hooks、Dashboard 与 adapters 均可从同一 payload 使用
- **AND** 安装后提示真实的一次性 hook 信任与新会话生效边界。

#### Scenario: Marketplace candidate 不完整

- **WHEN** inventory 返回的候选缺少任一受管资产、包含非法 symlink 或 smoke 失败
- **THEN** bootstrap 非零退出且不选择该候选
- **AND** 既有 active release 与 launcher 保持不变。

### Requirement: Marketplace 与 npx SHALL 复用同一安装事务

Marketplace SHALL 是首选宿主分发入口。公开 npm 包 MAY 提供
`npx --yes @<publisher>/tenon setup --codex`，但它 SHALL 是薄 bootstrap，并复用同一产品身份、
release manifest、候选验证、content-addressed publication、active/previous 选择和更新诊断。
两种入口不得创建第二 runtime、第二 Skill root 或第二 update 状态。

#### Scenario: 本地验证 npx tarball

- **WHEN** CI 对待发布 npm tarball 在隔离 HOME 执行 npx 首装
- **THEN** 它安装/激活与 Marketplace 相同 digest 的 payload
- **AND** tarball 不包含设计 demo、截图、内部研究、测试运行态或 monorepo 开发依赖。

#### Scenario: npm 尚未完成首次发布

- **WHEN** publisher scope 或发布凭据不可用
- **THEN** 文档继续提供真实可用的 Marketplace bootstrap
- **AND** 不把 npx 命令或 npm 包描述为已公开发布。

### Requirement: 跨品牌更新 SHALL 使用有期限的旧通道迁移桥

既有旧 identity 无法通过同名 update 自动发现新的插件/package identity。旧分发通道 SHALL 发布
一个所有权安全、可审计、失败可回滚的 migration bridge：验证 Tenon 候选、原子激活新 release、
验证新 launcher 和新宿主登记后，才移除旧登记。Tenon 本体 SHALL 不提供旧命令兼容。

#### Scenario: 旧用户完成迁移

- **WHEN** 旧自动更新通道获得 migration release 且 Tenon 候选验证通过
- **THEN** active/previous 记录原子切换到 Tenon
- **AND** 新会话只发现 Tenon Skill root、插件身份与 launcher
- **AND** 旧 launcher 和登记仅在新入口验证后删除。

#### Scenario: 迁移候选验证失败

- **WHEN** 下载、manifest、Skill、hook、Dashboard 或 CLI smoke 任一失败
- **THEN** 旧 active release 保持可用
- **AND** 失败原因进入持久诊断
- **AND** 不产生半迁移的 Tenon active 状态。

### Requirement: Tenon 更新 SHALL 只有一个整包事务

Tenon SHALL 使用 `tenon update --<native-host>` 更新唯一的完整插件，不得再把 CLI/runtime
拆成第二套 `--self-update` 通道。手动更新与用户明确启用的定时更新 SHALL 调用同一个事务协调器；
Skills、hooks、CLI、Dashboard、workflow 与 adapters SHALL 来自同一候选 payload 和 release digest。

宿主 Marketplace/plugin manager SHALL 是宿主插件登记与 cache 的唯一写入者；Tenon 不得直接改写、
备份或恢复宿主私有 cache 目录。Tenon SHALL 在自己的所有权边界内对 content-addressed runtime、
active/previous selection、当前 hardened stable bootstrap、stable launchers 与 Dashboard 服务执行可审计事务，
并明确报告宿主提交与 Tenon 提交两个边界，不得把只回滚 managed selection 描述成“整个宿主插件已恢复”。
已验证 previous payload 的 rollback/补偿 SHALL 只切换 selection 并恢复精确 launcher/Dashboard 状态；
它 SHALL NOT 用 previous payload 的旧 bootstrap 替换当前兼容 bootstrap。

项目 canonical Change、OpenSpec 与任务文件不属于插件更新事务。更新 SHALL 只读取机器级项目注册表，
报告需要显式 `tenon sync` 的项目，不得在后台或 `--auto` 模式中静默修改工作区。

#### Scenario: 用户更新完整 Codex 插件

- **WHEN** 用户运行 `tenon update --codex`
- **THEN** 只有 Codex Marketplace/plugin manager 更新 `tenon@tenon`
- **AND** 宿主 inventory 返回的候选先完成 payload、CLI、workflow、hook、Skill 与 Dashboard smoke
- **AND** Tenon 再把同一 digest 发布为 content-addressed managed release
- **AND** active selection、当前 hardened bootstrap、两个 stable launchers 与 18765 Dashboard 共同提交。

#### Scenario: 自动更新已明确启用

- **WHEN** `tenon setup --codex --auto-update` 已写入用户偏好且每日检查到期
- **THEN** 后台任务调用与手动更新相同的 `tenon update --codex --auto`
- **AND** 不存在第二套下载器、selection、Skill root、CLI 自更新或项目写入逻辑。

#### Scenario: launcher 或 Dashboard 提交失败

- **WHEN** managed release 已验证，但任一 launcher 写入或新 Dashboard readiness 失败
- **THEN** Tenon SHALL 以 activation 前快照精确恢复 selection、launcher 的存在性/内容/mode 与 Dashboard
- **AND** 当前 hardened bootstrap 保持不降级，不复制 previous payload 的旧 bootstrap
- **AND** 终止本次候选 Dashboard child，并重新验证或恢复 previous release 的 18765 服务
- **AND** 持久诊断分别说明宿主提交状态与 Tenon managed transaction 的补偿结果。

#### Scenario: 已登记项目需要新投影

- **WHEN** 更新后的 runtime 扫描机器级项目注册表并发现某项目版本落后
- **THEN** 更新结果列出项目及显式 `tenon sync` 命令
- **AND** 自动更新不得写该项目的 OpenSpec、Change、rules 或 owned manifest。

### Requirement: Tenon 产品机器状态 SHALL 只有一个路径所有者

Tenon 自有的 release、staging、selection、audit、项目注册表、凭证、Dashboard token 与 pid
SHALL 全部由 kernel 的单一平台路径解析器定位。macOS SHALL 使用
`~/Library/Application Support/tenon`，Linux SHALL 使用带 `tenon` 命名空间的 XDG
data/state/config roots，Windows SHALL 将本机 data/state 与 roaming config 分开。
Tenon 不得借用 `.claude`、`.codex` 或其他宿主目录保存产品状态。

`TENON_RUNTIME_HOME` SHALL 是测试与运维隔离的唯一用户覆盖。安装器 SHALL 只解析一次实际 roots，
并通过版本化 `TENON_RUNTIME_ROOTS` 契约把精确 root 元组传给 stable launcher、bootstrap、CLI 与
Dashboard；bootstrap、server 和各领域 store 不得各自复制平台路径算法。单 root 环境变量 MAY
作为冻结 N−1 bootstrap 与 shell hook 的只读投影，但当前路径解析器不得把它们作为第二输入源。

#### Scenario: 新安装在不同平台解析产品状态

- **WHEN** Tenon 在 macOS、Linux 或 Windows 上首次安装
- **THEN** kernel 返回该平台标准目录下、带 `tenon` 命名空间的 data/state/config roots
- **AND** release、selection、registry、secrets、Dashboard token 与 pid 均位于约定的产品域
- **AND** `.claude` 与 `.codex` 只用于宿主资产发现，不成为 Tenon 产品状态根。

#### Scenario: launcher 启动不同进程

- **WHEN** stable launcher 启动当前 bootstrap、冻结 N−1 bootstrap、CLI 或 Dashboard
- **THEN** 所有进程消费同一个带版本的 `TENON_RUNTIME_ROOTS` 元组
- **AND** current runtime 不会因单 root 投影变量或 Dashboard 专属 Home 得到第二套状态目录
- **AND** Dashboard 单例 scope 绑定 canonical `stateRoot`。

#### Scenario: 运维隔离运行时

- **WHEN** 测试或运维显式设置 `TENON_RUNTIME_HOME`
- **THEN** kernel 在该根下确定性派生 data/state/config
- **AND** 子进程接收相同 root contract
- **AND** 未设置该变量时不会从任一旧产品或宿主目录隐式回退。

### Requirement: Tenon 命令 SHALL 共享单一产品身份与作用域快照

当前 runtime、hooks、CLI、Dashboard 和诊断命令 SHALL 只发现并调用 Tenon 稳定启动器，不得用
已废弃产品命令的存在性决定当前功能是否可用。一次 CLI 命令需要多个运行时探针时，adapter SHALL
只解析一份不可变 runtime scope，并把该快照注入全部探针；子探针 SHALL NOT 再读取实时 home 或环境。
旧用户迁移只由独立、有期限且所有权安全的 migration bridge 承担，不进入当前命令兼容面。

#### Scenario: 新用户确认 review

- **GIVEN** 新用户环境只安装当前 `tenon` 稳定启动器
- **WHEN** review hook 处理普通确认或已授权的 delegated confirmation
- **THEN** hook 使用同一个 `tenon` 启动器完成可用性检查和 `review acknowledge`
- **AND** 不要求任何已废弃 CLI 命令存在。

#### Scenario: doctor 环境在探针之间变化

- **GIVEN** `tenon doctor` 已在 adapter 边界解析 runtime scope
- **WHEN** native runtime 与 AFK readiness 探针依次执行且实时环境在中途变化
- **THEN** 两个探针仍消费命令开始时的同一不可变作用域快照
- **AND** provider 读取次数不会随子探针数量增加。

### Requirement: 原生安装 SHALL 暴露唯一且可调用的根入口 Skill

每个原生 Tenon 候选 SHALL 从产品身份真相源读取根入口 Skill id，并在激活前证明
`skills/<entrySkill>/SKILL.md` 存在、frontmatter 名称匹配且完整 Codex 引用等于
`<plugin>:<entrySkill>`。Doctor、安装器、静态 adapter 和发布检查 SHALL 消费同一身份投影，
不得各自维护入口字符串。

#### Scenario: 新用户完成 Codex 安装

- **WHEN** `tenon setup --codex` 激活一个已验证候选
- **THEN** Selected Skill Root 包含产品身份声明的根入口
- **AND** `tenon doctor` 不报告入口缺失
- **AND** 项目目录不创建第二份同名 Skill 投影。

#### Scenario: 候选缺少根入口

- **WHEN** 候选缺失根入口文件或 frontmatter 名称与产品身份不一致
- **THEN** 候选验证和发布检查失败
- **AND** 既有 active release、launcher 与 Dashboard 保持不变。

### Requirement: 宿主插件登记 SHALL 在 Skill 执行前收敛为唯一工作流身份

原生 setup/update SHALL 以宿主插件 inventory 为登记权威。若宿主仍启用一个会与 Tenon 注册同类
Skill/hook 的冲突工作流插件，诊断 SHALL fail closed，并只通过宿主官方插件管理器完成卸载或
禁用；Tenon SHALL NOT 直接删除或改写宿主私有 cache。收敛完成后必须要求新宿主会话加载新的
Skill/hook 集合。

#### Scenario: 已卸载插件的 hook 仍会参与新会话

- **GIVEN** 宿主 inventory 或配置仍启用一个冲突工作流插件身份
- **WHEN** 用户运行 setup 或 doctor
- **THEN** 结果明确指出冲突的宿主登记而不是把它误报为 Tenon Skill 缺失
- **AND** 修复动作使用宿主插件管理命令
- **AND** 不直接操作 cache 内容。

#### Scenario: 宿主 inventory 已唯一

- **WHEN** 只有 `tenon@tenon` 负责 Tenon 的 Skill 与 hook
- **THEN** setup 可继续验证并发布 managed runtime
- **AND** 新会话只加载当前 Tenon 的入口和阶段 Skill。

### Requirement: 宿主 mutation SHALL 通过期望状态对账恢复

原生 setup/update 的每个宿主 mutation 步骤 SHALL 在执行外部命令前，向 durable WAL 写入规范化
before inventory、desired postcondition 与 replay policy。恢复 SHALL 先读取宿主权威 inventory：
已满足 desired 时 SHALL 只补提交步骤；仍精确等于 before 时 MAY 执行命令；任何第三状态 SHALL
fail closed。系统 MUST NOT 仅因步骤处于 `started` 就盲目重放非幂等命令。

#### Scenario: 命令成功后 completed journal 写入失败

- **GIVEN** 宿主命令已经把 inventory 变成 desired state
- **AND** 进程在持久化 completed checkpoint 前终止
- **WHEN** 相同 setup/update 事务恢复
- **THEN** 系统重新观察 inventory 并直接提交该步骤
- **AND** 不再次调用宿主 mutation 命令。

#### Scenario: 恢复时观察到第三状态

- **GIVEN** WAL 记录 before A 与 desired B
- **WHEN** 权威 inventory 为既非 A 也不满足 B 的状态 C
- **THEN** 事务返回 indeterminate 并保留诊断证据
- **AND** 不执行 mutation、runtime 激活或补偿猜测。

### Requirement: Requirements-changed SHALL 允许 Spec 诚实更新 ADR

当 Build 或 Verify 发现已批准的架构语义需要变化并通过 `requirements-changed` 回到 Spec 时，
document contract SHALL 允许 `tenon` 在实际 Skill 证据下重新登记 proposal、OpenSpec
design、tasks、Superpowers design 与 ADR 的新 digest。旧 producer 与旧 read receipt SHALL 保留
在 append-only history，但 MUST NOT 被当作新 digest 的证据。更新后所有后续 phase SHALL 重新读取
精确版本。

#### Scenario: Verify 发现新的事务不变量

- **GIVEN** Change 已有 Explore 阶段登记的 ADR
- **WHEN** `requirements-changed` 回到 Spec 并修订 ADR
- **THEN** `tenon` 可用当前 step 访问的真实 Skill evidence 重登记该 ADR
- **AND** 旧摘要的 read receipts 不再满足后续 phase
- **AND** 未加载 `tenon`、使用 `--backfill` 或手改 ledger 均被拒绝。

### Requirement: 公开 Codex 首装 SHALL 通过真实干净宿主验收

Tenon SHALL 提供一个可重复、失败关闭的真实 Codex 首装验收。验收 SHALL 把 `HOME`、
`CODEX_HOME`、`TENON_RUNTIME_HOME` 与 Dashboard 端口限制在本轮唯一临时作用域，通过真实
Codex Marketplace 安装当前候选或已发布的精确 `vX.Y.Z/install.sh`，并验证 stable launcher、managed
runtime、doctor、Dashboard 产品身份以及新 Codex 进程发现的插件、入口 Skill 与 hooks。

验收 SHALL 不读取或复制真实用户凭据，不修改真实宿主或 Tenon 状态，不信任 hook，不停止未知
进程。相同候选的重复安装 SHALL 复用同一 content-addressed release；同 release 的健康 managed
Dashboard MAY 作为经过精确身份复核的 `preexisting` 服务保留，但新 transaction MUST NOT adopt
或 stop 它。changed-release transaction SHALL 在 activation 前将 current active previous
Dashboard 的完整 identity 或空端口事实持久化到 WAL；只有随后观察到的 listener 与该 previous
identity 逐字段一致时，transaction MAY 精确 adopt 并 stop 它以启动候选。未冻结、探针之间新出现、
身份漂移或并非 previous active release 的 listener MUST NOT 被 adopt、stop 或覆盖。

进入 `runtime-activated` 前没有冻结 `dashboardBefore`/`dashboardBeforeAbsent` 或
`dashboardPort` 的旧 WAL MUST fail closed；实现 MUST NOT 以 activation 后的 probe 或当前 retry
环境补造 pre-activation 证据。

候选 readiness 或 ready evidence 失败时，transaction SHALL 在每项副作用前持久化补偿 phase，
依次精确停止自己启动的候选、补偿 activation、恢复 previous Dashboard，并在精确恢复证明持久化
后才清除 WAL。进程在任一补偿 phase 崩溃后 SHALL 先证明已完成的副作用或幂等续跑，不能把
`dashboard-ready` 当作可直接清除的失败终态。下一次 fresh retry SHALL 能重新冻结、精确替换
恢复的 previous Dashboard 并完成发布，不得永久停在 indeterminate。

持有私有 child handle 的 starter/spawn 层 SHALL 在返回 ready 前验证 release、port、child PID
与 health PID、canonical state scope 与 transaction，并自行终止由它启动但身份不匹配的 child。
previous restore SHALL 使用本次补偿唯一 identity 防止并发 listener 冒充恢复结果。
coordinator/restore 边界收到身份不匹配的 session 时 MUST NOT 调用该不可信 session 的 stop；
它 SHALL 保留 WAL 并失败关闭。缺少真实 Codex CLI、Marketplace 失败、身份不匹配或清理所有权
不明 SHALL 使强制验收失败，不得以 fixture、文件存在或静默 skip 冒充通过。

#### Scenario: CI 验收当前 checkout

- **GIVEN** CI 安装了受支持的真实 Codex CLI
- **WHEN** 验收器在隔离临时作用域登记当前 checkout 的 Marketplace 并安装 `tenon@tenon`
- **THEN** packaged setup 发布一个已验证 managed runtime，stable launcher 的 doctor/runtime
  检查通过
- **AND** 唯一临时端口的 Dashboard health 与 HTML 均证明 Tenon 产品及 active release 身份
- **AND** 真实用户 HOME、Codex 配置、Tenon runtime 与 18765 listener 保持不变。

#### Scenario: 新 Codex 进程发现插件能力

- **WHEN** 首装完成后在隔离 `CODEX_HOME` 启动一个新的 Codex app-server 进程
- **THEN** `plugin/installed` 返回已安装且启用的 `tenon@tenon`
- **AND** `skills/list` 返回启用的 `tenon:tenon`
- **AND** `hooks/list` 返回 Tenon 的 `sessionStart`、`userPromptSubmit`、`preToolUse` 与
  `postToolUse` hooks
- **AND** hook 的未信任状态被报告为人工安全门，而不是由验收器绕过。

#### Scenario: 相同候选重复安装

- **GIVEN** 首次安装的 release 与 managed Dashboard 已健康提交
- **WHEN** 在同一隔离作用域再次执行相同安装
- **THEN** active content-addressed release 保持一致且不产生第二个 listener
- **AND** 新 transaction 精确证明同 release Dashboard 为 `preexisting`
- **AND** 新 transaction 不 adopt、不停止也不覆盖该 listener。

#### Scenario: changed release 替换 activation 前冻结的 previous Dashboard

- **GIVEN** transaction 在 activation 前已把 current active previous release 的完整 Dashboard
  identity 写入 WAL
- **WHEN** candidate runtime 激活后，同一端口仍返回逐字段一致的 previous listener
- **THEN** transaction 精确 adopt 并停止该 previous listener，再启动带当前 transaction identity
  的 candidate Dashboard
- **AND** 若 listener 未冻结、在空端口证明后才出现或任一 identity 字段漂移，则 transaction
  保留 WAL 并失败关闭，不发送停止信号。

#### Scenario: evidence 失败后恢复并 fresh retry

- **GIVEN** changed-release candidate Dashboard 已健康，但 ready evidence 提交失败
- **WHEN** transaction 精确停止 candidate、补偿 activation 并恢复 previous Dashboard
- **THEN** 本次结果如实报告 restored
- **AND** candidate stop、activation revert、previous restore 与恢复完成证明均在动作前后由
  durable WAL phase 约束，任一 phase 崩溃后可证明或幂等续跑
- **AND** 下一次 fresh retry 重新冻结恢复后的 previous identity，精确停止它并成功启动 candidate
- **AND** restore 或 start 返回的 ready ownership 与预期 release、port、PID、state scope 或
  transaction 不一致时，只有持有私有 child handle 的 spawn 层可以清理自己启动的 child；
  coordinator/restore 必须不发送信号、保留 WAL 并失败关闭。

#### Scenario: Release 验收公开一步安装

- **GIVEN** release workflow 已 checkout 一个待发布的不可变 Git ref/commit
- **WHEN** public 轨从该精确 ref/commit 对应的 raw URL 下载 `install.sh` 并执行 `--codex`
- **THEN** 它执行与 CI 候选轨相同的 runtime、doctor、Dashboard、新 Codex 进程和重复安装断言
- **AND** 下载 ref 与当前 checkout 一致，移动的 `main` 不得代替待发布候选
- **AND** 任一 Marketplace、安装、身份或清理断言失败都会使 release 验收非零退出。

#### Scenario: 严格保留锁与 HTTP 诊断

- **WHEN** runtime 读取 lock owner PID 或等待 Dashboard health
- **THEN** PID 只有在完整值为安全的十进制正整数时才可参与存活判断
- **AND** 带数字后缀、前缀或其他字符的 PID 被视为无效而不是被 `parseInt` 截断
- **AND** 非 2xx health 响应先以 HTTP status 归因，即使 body 不是 JSON，也不得被 JSON
  解析错误覆盖。

#### Scenario: 清理时无法证明 Dashboard 所有权

- **WHEN** 验收结束时端口上的 pid、release id、state scope 或 transaction id 不再等于本轮记录
- **THEN** 验收器不向该进程发送终止信号
- **AND** 以清理所有权不明失败并保留脱敏诊断。

### Requirement: Codex 插件生命周期 SHALL 提供宿主认证状态与双路径获取引导

Tenon SHALL 在 Codex 首次安装、重复 setup、成功的前台 update 和 doctor 中，通过同一只读、
有超时的宿主认证探针运行 `codex login status`。公开认证状态 SHALL 仅为
`authenticated`、`unauthenticated` 或 `unavailable`，不得由 `OPENAI_API_KEY`、
`CODEX_HOME` 或 `auth.json` 存在性推断本地 Codex 登录成功。

退出码 `0` SHALL 表示 `authenticated`。由于当前 Codex CLI 对未登录和认证存储读取错误均可能
使用退出码 `1`，只有退出码 `1` 且有界 stderr 去除首尾空白后精确等于官方
`Not logged in` 哨兵时 SHALL 表示 `unauthenticated`；其他退出码 `1`、其他非零退出码或超出
哨兵采集上限的输出 SHALL 保守表示 `unavailable`。未认证或无法确认时，Tenon SHALL 同时提供
以下官方、安全且可复制的后续路径：

- 若用户的 ChatGPT 方案包含 Codex，运行 `codex login`；
- 远程或无浏览器环境运行 `codex login --device-auth`；
- 在 `https://platform.openai.com/api-keys` 创建 Platform API Key，并通过
  `printenv OPENAI_API_KEY | codex login --with-api-key` 从 stdin 登录；
- 运行 `codex login status` 验证结果。

文案 SHALL 明确 Platform API Key 为按用量计费，不得推断用户具体 ChatGPT 套餐、账号、邮箱、
凭证类型或权益。探测 SHALL 忽略 stdin，不得自动启动登录、浏览器或 device flow，不得读取
`auth.json` 或 API Key 值。探测 MAY 仅在有界内存中比较 stderr 是否精确等于上述固定哨兵；
捕获内容 SHALL 在分类后立即丢弃，且不得把原始 stdout/stderr、token、Key 或宿主路径写入人读
输出、JSON、日志、文档、异常或状态。

#### Scenario: ChatGPT 订阅账号已经登录

- **GIVEN** 用户通过 ChatGPT 登录 Codex
- **WHEN** `codex login status` 在 setup、update 或 doctor 中退出 `0`
- **THEN** Tenon 报告 Codex 已认证
- **AND** 不要求设置 `OPENAI_API_KEY`
- **AND** 不推断或显示订阅层级、账号或认证输出。

#### Scenario: Codex 未登录

- **WHEN** Codex CLI 存在、`codex login status` 以退出码 `1` 退出且有界 stderr 精确等于
  `Not logged in`
- **THEN** Tenon 把状态报告为 `unauthenticated`
- **AND** 同时展示 ChatGPT browser login、headless device auth、Platform API Key stdin login
  和 `codex login status` 复验命令
- **AND** 插件与 managed runtime 已验证成功时，认证缺失只产生可见警告，不回滚安装事务。

#### Scenario: API Key 用户获取并登录

- **WHEN** 用户选择 Platform API Key 路径
- **THEN** 引导指向 `https://platform.openai.com/api-keys`
- **AND** 登录命令从 stdin 读取 `OPENAI_API_KEY`
- **AND** 文案说明 Platform 使用按用量计费
- **AND** 不建议把 Key 字面值放入 argv、shell history、日志或 Tenon 配置。

#### Scenario: 远程或无浏览器安装

- **GIVEN** 安装运行于 SSH、CI、非 TTY 或 stdin 管道
- **WHEN** Codex 尚未认证
- **THEN** Tenon 输出 `codex login --device-auth` 和其他后续命令
- **AND** 不等待输入、不打开浏览器、不执行任何登录命令
- **AND** 安装结果不因非交互环境而悬挂。

#### Scenario: Codex CLI 缺失

- **WHEN** `install.sh --codex` 在 Marketplace mutation 前找不到 `codex`
- **THEN** bootstrap 非零退出并引导 `npm install -g @openai/codex`
- **AND** 提示用 `codex --version` 验证
- **AND** 不调用 Marketplace、plugin install 或 packaged setup。

#### Scenario: dry-run 环境缺少 Codex CLI

- **GIVEN** `codex` 不在 PATH
- **WHEN** 用户运行 `install.sh --codex --dry-run`
- **THEN** bootstrap 仍以零退出打印完整计划
- **AND** 计划包含将执行的 CLI/auth 检查
- **AND** 不调用宿主、不运行 auth probe、不写用户或项目状态。

#### Scenario: 状态命令不可用、超时或启动失败

- **WHEN** Codex CLI 版本不支持 `login status`、探针超时、收到 signal 或无法启动
- **THEN** Tenon 报告 `unavailable`，不得猜测已登录或未登录
- **AND** 输出固定的 CLI 更新、登录和状态复验引导
- **AND** 不透传原始 stdout/stderr。

#### Scenario: 认证存储损坏但状态命令退出 1

- **GIVEN** Codex CLI 可启动但认证存储损坏或不可读取
- **WHEN** `codex login status` 以退出码 `1` 退出且 stderr 不精确等于 `Not logged in`
- **THEN** Tenon 报告 `unavailable`，不得误报为 `unauthenticated`
- **AND** 仍输出固定获取与复验引导，但不透传错误、宿主路径或认证存储内容。

#### Scenario: 相同候选重复安装

- **GIVEN** Tenon 插件与 managed runtime 已安装
- **WHEN** 用户再次执行相同 Codex bootstrap 或 `tenon setup --codex`
- **THEN** 相同只读 auth probe 与引导再次确定性运行
- **AND** 不创建、覆盖、复制或修改 Codex 凭证
- **AND** content-addressed release 与 Dashboard 幂等契约保持不变。

#### Scenario: Codex 前台更新成功

- **WHEN** `tenon update --codex` 已完成宿主与 managed runtime 提交
- **THEN** Tenon 运行共享认证探针并输出完整前台引导或就绪结果
- **AND** auth 缺失不回滚已经提交的有效更新
- **AND** update 候选失败时不追加 auth 教程掩盖主要错误。

#### Scenario: Codex 自动更新

- **WHEN** `tenon update --codex --auto` 在后台完成
- **THEN** 不启动交互登录或浏览器
- **AND** 最多输出固定的简短复验提示
- **AND** 用户可通过 `tenon doctor` 获得完整认证状态与获取引导。

#### Scenario: Doctor 独立报告宿主登录与 AFK 凭证

- **WHEN** 用户运行 `tenon doctor`
- **THEN** `auth:codex` 使用共享 host auth probe
- **AND** `afk:credential-codex` 继续只报告容器凭证转发就绪
- **AND** 两个检查可以分别为已就绪或未就绪，不得互相冒充。

#### Scenario: 显式 CODEX_HOME 是空目录

- **GIVEN** `CODEX_HOME` 非空但目录中没有可读 `auth.json`
- **WHEN** Tenon 计算 AFK Codex 凭证转发就绪
- **THEN** 不得仅因环境变量非空就报告就绪
- **AND** 本地 Codex 登录事实仍只由 `codex login status` 决定。

#### Scenario: 干净安装不复制真实凭证

- **GIVEN** clean-install acceptance 使用唯一临时 `HOME`、`CODEX_HOME` 和 `TENON_RUNTIME_HOME`
- **WHEN** 它在 `CI=1`、非交互且未登录的环境连续安装两次
- **THEN** 两次安装均成功并出现确定性三路径引导和复验命令
- **AND** 验收不读取或复制真实用户凭证、不创建登录态、不信任 hook
- **AND** 插件、Skill、hook、runtime、Dashboard 和重复安装身份断言继续完整执行。

### Requirement: 公开安装 SHALL 从版本标签提供完整预构建产品

官方安装命令 SHALL 从不可变稳定 SemVer 标签读取 `install.sh`。该脚本 SHALL 安装同标签的完整 Codex 插件并运行打包 CLI；用户机器 SHALL NOT 需要 clone 仓库、安装 workspace 依赖、调用构建命令或从源码入口启动 Tenon。

#### Scenario: 干净 Codex 用户安装正式版本

- **WHEN** 用户执行固定到 `vX.Y.Z/install.sh` 的官方一行命令
- **THEN** installer 只调用受信任 PATH 中的 Codex CLI、Node 和标签内已发布 bundle
- **AND** 安装后的插件包含 CLI、server、Dashboard、Skills、hooks 和 manifests
- **AND** 命令历史不包含 `npm install`、`npm run build` 或本地源码路径
- **AND** installer 与生成的稳定 launcher 执行冻结的绝对 Node/Bash/host CLI 路径，不重新从 cwd 或相对 PATH 解析程序

#### Scenario: 标签内版本身份漂移

- **WHEN** install 脚本默认 ref、根 package、Codex/Claude plugin manifest 或 workspace package 版本与标签不一致
- **THEN** release/identity 门禁失败
- **AND** 该候选不得成为正式安装命令

#### Scenario: 同版本插件登记存在但被禁用

- **WHEN** 预检发现 Tenon plugin/marketplace 版本与目标一致但 plugin registration 被禁用
- **THEN** installer 把它视为可修复状态并通过公开 remove/add 收敛
- **AND** 不在任何 mutation 前错误拒绝本次安装

#### Scenario: 公开 bootstrap 在 packaged CLI 可用前中断

- **WHEN** 一行安装器必须先通过宿主 CLI 重绑定 Marketplace/plugin，且在任一 remove/add 后中断
- **THEN** 它已在 Tenon machine state 中持久化 target tag/commit、原 inventory、transaction 与下一 phase
- **AND** 同一宿主的并发 installer 由存活 owner lease 串行化
- **AND** 重跑只接纳 journal 记录的 before 状态或已证明的目标 postcondition，并从原 phase 幂等继续
- **AND** 任一并发第三状态保持不变并失败关闭，不被无条件 remove

### Requirement: 正式新用户验收 SHALL 使用宿主级卸载与版本化重装

稳定 Release 发布后 SHALL 在真实用户路径验证：通过宿主 CLI 删除现有 Tenon plugin 和 Tenon marketplace，执行公开版本化一行安装，重复安装，并执行 `tenon update --codex`。该验收 SHALL 保留项目 Change/OpenSpec、用户规则、截图和可恢复 managed runtime。

#### Scenario: 维护者验收公众安装命令

- **WHEN** 新稳定 Release 已发布且维护者开始最终安装验收
- **THEN** 维护者先记录当前 plugin、marketplace、launcher、runtime 和 Dashboard 身份
- **AND** 仅通过 Codex 公开 CLI 删除 Tenon plugin/marketplace
- **AND** 从 GitHub 已发布标签执行 README 中完全相同的一行命令
- **AND** 最终 inventory 不指向本地 marketplace、开发 worktree 或 `main`

#### Scenario: 重装失败

- **WHEN** 宿主 plugin 已删除但正式安装在网络或候选校验阶段失败
- **THEN** 项目数据和旧 managed runtime 保持不变
- **AND** 稳定 launcher 提供重试或 runtime 诊断路径

### Requirement: 可执行工具冻结 SHALL 绑定文件身份与可信路径链

安装器与 native lifecycle 在首个 mutation 前 SHALL 把 host CLI、Node、Bash 和 Git 解析为
普通文件的 realpath，冻结 device/inode/mode/owner、size/change identity 以及父目录身份。它 SHALL
拒绝 executable 自身的 group/world write 位或非 root/当前用户 owner，也 SHALL 拒绝非 sticky 的
world-writable 父目录，也 SHALL 拒绝由不同 owner 控制的 group-writable 父目录；由同一冻结 owner
控制的 package-manager 根（例如 Homebrew `0775` Cellar）和 sticky 系统临时根 MAY 使用，但同样
必须冻结完整父目录身份。每次 spawn 前 SHALL 重验原始路径仍解析到同一普通文件、物理文件及父目录
身份均未变化，且可执行文件未被同 inode 原地改写；仅保存绝对 pathname 不构成信任证据。runtime
repair、候选/已存 payload 校验和 installer decoder SHALL 使用同一冻结证明，不得回退到
`process.execPath`、裸 PATH 或未绑定 pathname。

POSIX SHALL 应用 owner 与 group/world-write 约束；Windows SHALL 以 realpath/file identity/change
identity 复验替代无意义的 POSIX uid/mode 判定。Windows `.cmd`/`.bat` 宿主还 SHALL 同时冻结并在每次
spawn 前复验其绝对 `ComSpec`/`cmd.exe` 物理身份。正式 CI SHALL 在真实 Windows runner 运行该链路。

当可信 Bash 将冻结的 Node 交给 provenance verifier 时，调用方 MUST 将其建模为同一个复合 spawn binding，并在 Bash spawn 前立即、同步地依次重放 Bash 与 Node 的物理绑定。传给 verifier 的 `--node` MUST 与刚复验的 Node executable 完全相同。两次 proof 与 spawn 之间 MUST NOT 出现 `await`、另一个 child process、host mutation、release activation、Dashboard 启动、ready evidence 或成功状态写入。

package、update-candidate、release-store、standalone/full setup 与 doctor 的所有 provenance spawn MUST 使用这一复合边界。历史 pathname-only seam MAY 继续作为旧数据读取输入，但 MUST NOT 被提升为新的可信执行证据。

#### Scenario: 冻结后 symlink 或 executable 被换位

- **WHEN** 预检后某个工具的 realpath、inode、owner、mode、父目录身份或上述 owner/write 约束发生变化
- **THEN** 安装/update 在调用该工具前失败关闭
- **AND** 不执行被换位的程序或任何后续宿主 mutation

#### Scenario: executable 在原 inode 上被改写

- **WHEN** 预检后工具内容、size 或 change identity 在原 inode 上变化
- **THEN** 下一次 spawn 前的物理重验失败
- **AND** runtime selection、宿主 plugin 与 marketplace 保持 mutation 前状态

#### Scenario: Windows batch interpreter 漂移

- **WHEN** 已冻结的 host shim 仍不变，但其绝对 `cmd.exe` 物理身份在 batch spawn 前变化
- **THEN** native setup/update/doctor 不执行 shim
- **AND** 不回退到 PATH、cwd 或只保存 pathname 的 interpreter

#### Scenario: provenance Bash 委托冻结 Node

- **WHEN** verifier 由可信 Bash 启动并接收 `--node <frozen-node>`
- **THEN** 每次 spawn 的可观察顺序 MUST 为 `bash-proof → node-proof → verifier-spawn`
- **AND** 每一次 spawn MUST 独立重放两份 proof，且 argv 中的 Node MUST 等于刚复验的 frozen Node executable

#### Scenario: Node 在复合 proof 前漂移

- **WHEN** Bash 保持可信但 frozen Node 在 provenance spawn 前漂移
- **THEN** Node replay MUST 在 Bash runner 与任何 child process 之前失败
- **AND** 不得出现 host mutation、selection/launcher 变更、activation、Dashboard/ready evidence 或成功审计

#### Scenario: standalone setup skills 与 doctor 复用完整 verifier

- **WHEN** standalone `setup skills` 或 doctor 执行 provenance 验证
- **THEN** 它们 MUST 通过冻结 Bash 启动完整 `tools/verify-skills.sh`，并对委托 Node 执行复合 pre-spawn replay
- **AND** 它们 MUST NOT 直接信任 `process.execPath`、裸 PATH 结果或未绑定的 pathname

#### Scenario: 兼容已发布 provenance 数据

- **WHEN** 系统读取 v1.0.1 或 v1.0.2 provenance/selection/launcher 数据
- **THEN** 本变更 MUST NOT 重写 registry schema、release manifest、selection、launcher 或审计格式
- **AND** 已完整通过 provenance 验证的 previous release MUST 继续可作为 rollback 目标

### Requirement: Release 门禁 SHALL 使用精确公开 N-1 产物

每个稳定 Release 候选 SHALL 以固定版本、commit 和 digest 的完整公开 N-1 payload
执行兼容测试。缺少 N-1、使用任意本机 previous release、fixture 版本不匹配，或
N-1 `status`/`set`/bundle contract 无法读写当前候选 Change 时 SHALL 阻止发布。
版本号重置后的首个发行版 v0.1.0 没有更早的 0.x 正式版本：只有 fixture 以 `status: none`
明确点名当前候选版本时，gate SHALL 以专用退出码报告一次显式跳过；此后每个候选 SHALL 固定
低于当前版本的最近非退役正式版本，已退役的 1.0.0–1.1.5 版本 SHALL NOT 作为基线。

#### Scenario: v1.0.2 验证真实 v1.0.1

- **WHEN** release candidate 运行 N-1 compatibility gate
- **THEN** gate 校验完整 v1.0.1 payload 的固定 commit 与 CLI SHA-256
- **AND** v1.0.1 的 `status`、`set` 与 bundle 兼容断言全部通过
- **AND** 不得在 N-1 缺失时静默 skip 并报告成功

#### Scenario: v0.1.0 没有更早的 0.x 正式版本

- **WHEN** N-1 fixture 为 `status: none` 且 `release` 等于候选版本 `v0.1.0`
- **THEN** gate 以退出码 78 报告 `N-1 skipped` 与原因，CI 与 release candidate 只把该退出码当作跳过
- **AND** bundle smoke 打印 `[HONEST SKIP]`，不计为通过
- **AND** `release` 与候选版本不一致时 gate 失败，v0.1.1 及以后的候选 MUST 固定最近的非退役正式版本
- **AND** 候选版本不属于退役版本线时，固定基线是退役版本或不是最近的非退役正式 tag 都使 gate 失败
