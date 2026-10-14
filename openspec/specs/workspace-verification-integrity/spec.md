# Workspace Verification Integrity

## Purpose

Define which implementation content belongs in a frozen verification baseline and which owned
control or verifier paths are excluded, preserving drift detection without invalidating valid receipts.
## Requirements
### Requirement: In-place baselines SHALL exclude workflow control state

An in-place Build baseline SHALL fingerprint implementation content and SHALL
exclude the project-local `.pipeline/` control plane. This exclusion includes
registries, generated caches, session projections, hook configuration,
receipts, and future control records below that directory.

#### Scenario: Verify receipt does not invalidate Build

- **GIVEN** an in-place Build freezes a valid workspace baseline
- **WHEN** Verify appends required skill evidence under `.pipeline/`
- **THEN** the current workspace fingerprint remains equal to the frozen
  baseline.

#### Scenario: Implementation changes still invalidate Build

- **GIVEN** an in-place Build freezes a workspace baseline
- **WHEN** source, executable mode, directory structure, or a tracked symlink
  target changes outside excluded control/evidence/cache paths
- **THEN** the current fingerprint differs from the frozen baseline.

### Requirement: Control and verifier exclusion SHALL follow ownership

The baseline policy SHALL exclude the `.pipeline/` directory as a boundary. It
SHALL also exclude project-owned, ignored verifier and agent runtime roots,
including `.playwright-tmp/`, `.playwright-mcp/`, `.superpowers/`,
`.worktrees/`, `.agents/`, `.codex/`, `.impeccable/`, and `.github/hooks/`.
Bounded root-level browser QA snapshots declared by the project SHALL be
excluded without excluding shipped screenshots below product directories.
The policy SHALL NOT rely on an allowlist of current receipt or log filenames.

#### Scenario: A new control record is introduced

- **WHEN** a future runtime version writes a new file below `.pipeline/`
- **THEN** that write does not require a fingerprint-code change
- **AND** canonical Track, Workflow, state, and revision validators remain
  responsible for the integrity of that control record.

#### Scenario: Browser verification writes temporary evidence

- **GIVEN** an in-place Build has frozen its implementation baseline
- **WHEN** Playwright updates a script, log, screenshot, or browser state below
  a project-owned verifier root
- **THEN** the implementation fingerprint remains unchanged.

#### Scenario: A shipped screenshot changes

- **WHEN** an image below a shipped product directory such as
  `design-demos/shots/` changes
- **THEN** the implementation fingerprint changes.

### Requirement: Fingerprint capture SHALL remain deterministic and fail loud

The existing content-addressed encoding, source/config inclusion, symlink
non-following behavior, race detection, and unsupported-entry rejection SHALL
remain unchanged.

#### Scenario: A file races with capture

- **WHEN** an included file changes while its fingerprint record is being read
- **THEN** capture fails with a diagnostic naming the relative path
- **AND** no baseline is returned.

### Requirement: 未跟踪的测试证据文件 SHALL 不计入候选指纹

工作区指纹（完整值与可移植值）SHALL 排除同时满足以下三条的文件，不要求测试目录逐个声明：

- 位于名为 `test-results`、`playwright-report` 或 `coverage` 的目录之下（任意深度）；
- git 没有跟踪它（既未提交也未暂存）；
- 扩展名属于证据格式：log、txt、xml、md、csv、png、jpg、jpeg、gif、webp、webm、mp4、lcov、info。

其他约定：

- 已跟踪的文件、扩展名不在上面名单里的文件 MUST 照旧计入，不能借这些目录名藏源码或会被加载的内容。包括：
  - js、ts、mjs、sh、py 等源码与脚本；
  - 代码或浏览器能直接加载、解包的格式：json、html、htm、zip、gz、har；
  - 没有扩展名的文件。
- 测试运行确实要写出上述可加载格式的产物时（报告 JSON、HTML 报告、trace 压缩包），由测试目录或冻结工作流声明为输出，按声明排除。
- 读取跟踪状态时 MUST 失败关闭：git 不可用、超时或出错时，这些目录下的文件一律计入。
- 测试目录或冻结工作流声明的输出 SHALL 照旧按声明排除。
- 只为这些目录读取跟踪状态，其他路径的指纹规则不变。

#### Scenario: e2e 被测服务的日志不让候选失效

- **GIVEN** 实现步已冻结候选，测试目录没有声明 `test-results/dashboard-e2e-server/`
- **WHEN** 验证步运行 e2e，被测服务写出 `test-results/dashboard-e2e-server/serve.log` 与 `dashboard.log`（未跟踪）
- **THEN** 当前指纹与冻结的候选相同

#### Scenario: 测试输出目录里的源码仍计入

- **WHEN** 有人新增未跟踪的 `coverage/hook.js`，或修改已跟踪的 `test-results/fixture.json`
- **THEN** 指纹发生变化

#### Scenario: 可被加载的数据与页面仍计入

- **WHEN** 测试目录没有声明它们，有人新增或修改未跟踪的 `coverage/x/fixture.json`、`playwright-report/index.html`、`test-results/trace.zip` 或 `test-results/net.har`
- **THEN** 指纹发生变化

#### Scenario: 没有扩展名的文件仍计入

- **WHEN** `playwright-report/run` 是一个没有扩展名的未跟踪文件
- **THEN** 它计入指纹

#### Scenario: git 不可用时失败关闭

- **WHEN** 读取 `test-results/` 的跟踪状态时 git 报错
- **THEN** 该目录下的文件全部计入指纹

