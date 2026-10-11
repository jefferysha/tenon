# Normal-chat workflow routing

## Purpose

定义正常对话如何区分讨论与执行、如何选择 Track/Workflow，以及如何在不复用旧 Change 或隐式默认项目的前提下创建受治理的流水线现场。
## Requirements
### Requirement: normal chat preserves effective Track workflow bindings

For every routable Workflow branch, the router's generated data contract SHALL carry the branch's
Workflow id, track id, label, priority, routing keywords, and exclusions. Routable branches SHALL be
collected from every available Workflow (project, global store, plugin template); a separate Track
registry or `.pipeline/tracks.yaml` SHALL NOT contribute rows.

#### Scenario: custom Track is routed

- **WHEN** the global store contains Workflow `catalog-flow` whose branch `catalog` declares routing keywords
- **AND WHEN** a new user prompt matches those keywords
- **THEN** the normal-chat dispatch exposes the pair `catalog-flow` / `catalog` as a candidate rather than
  substituting `default`.

### Requirement: custom choices require explicit selection before Change creation

For a new objective, the router SHALL mark its dispatch as selection-required and include the valid
candidate Workflow/track pairs when the highest score is tied between branches or when the
highest-scoring branch belongs to a Workflow other than the built-in `default` and `design-system`.

#### Scenario: user chooses between default and custom paths

- **WHEN** a prompt can be served by a custom Workflow branch and a built-in default branch
- **THEN** the root pipeline skill asks the user which pair to use before running `tenon init`
- **AND THEN** the new Change stores the selected pair through the canonical CLI/API path.

### Requirement: clean projects preserve default routing

A project whose routable branches all belong to the built-in `default` Workflow SHALL dispatch without a
selection question. A development request that carries a heavy signal SHALL dispatch the winning heavy
track directly; any other development request SHALL dispatch with an assessment requirement whose
candidates are the lite track and the winning domain track.

#### Scenario: built-in Track routes directly

- **GIVEN** a project only exposes the built-in default branches
- **WHEN** a new prompt asks for a database migration in the backend
- **THEN** the router selects the backend track with workflow `default`
- **AND** Change creation does not ask the user to choose an equivalent Track/workflow pair.

#### Scenario: an ordinary fix is assessed first

- **GIVEN** a project only exposes the built-in default branches
- **WHEN** a new prompt asks to fix a bug in one API handler
- **THEN** the dispatch requires an assessment with candidates `default/lite` and `default/backend`.

### Requirement: cache incompatibility fails closed

The hook SHALL reject a cache that lacks the workflow binding required by its current schema and
regenerate it on the cold path; it SHALL not guess or silently fall back to an old value.

#### Scenario: stale routing cache is regenerated

- **GIVEN** the cached Track payload predates the schema that requires a workflow binding
- **WHEN** the normal-chat hook reads that cache
- **THEN** the hook rejects the incompatible payload and regenerates it from canonical project data
- **AND** it does not substitute workflow `default` for the missing field.

### Requirement: Custom Workflow archive terminals SHALL close canonical state

A custom Workflow that reaches a terminal step named `archive` SHALL support
the reserved `archived` completion event after that step's guards, skill DAG,
and document evidence pass. Completion SHALL set `phase_status=done`,
`archived=true`, and `archived_at` without requiring a cyclic transition in
the user-authored Workflow graph.

#### Scenario: Terminal archive no longer remains active forever

- **WHEN** a custom Workflow reaches `archive` with `transitions: []`
- **AND** its declared archive skills, guards, and document reads are complete
- **THEN** `tenon transition <change> archived` completes the canonical run
- **AND** the Change is no longer returned as an active recovery candidate.

### Requirement: 正常开发对话 SHALL 分派到真实存在的产品根入口

Codex 的生成式 Agent managed block SHALL 从产品身份真相源确定根入口 Skill，且正常开发对话的
静态指令 SHALL 调用完整引用 `tenon:tenon`。仓库根 `AGENTS.md` 与静态 adapter SHALL 消费同一
生成模板；任何漂移 SHALL 在构建、adapter 测试和发布前失败。

#### Scenario: 普通开发请求触发 default workflow

- **WHEN** UserPromptSubmit 路由一个新的开发目标到 default workflow
- **THEN** Agent 规则要求先调用 `tenon:tenon`
- **AND** 根入口创建或恢复精确 Change 后再分派当前步骤
- **AND** Todo 一级项来自所选轨道的真实步骤图而不是脱离流程的通用列表。

#### Scenario: 仓库规则被手工改坏

- **WHEN** `AGENTS.md` managed block 与生成模板不一致
- **THEN** 产品身份 freshness 检查失败并指出漂移
- **AND** 候选不得打包或发布。

#### Scenario: 静态 adapter 安装规则

- **WHEN** 无原生插件能力的 Codex 目标运行静态 adapter
- **THEN** adapter 读取同一生成模板写入 managed block
- **AND** 哨兵外用户内容保持不变
- **AND** 规则不引用不存在的 Skill 或已废弃 CLI。

### Requirement: 持续执行授权 SHALL 绑定精确 Change

正常对话 SHALL 只把共享 prompt classifier 识别出的显式持续执行意图写为 canonical authority。
authority SHALL 绑定精确 Change 与 host session、可撤销且不得跨 Change 继承。拒绝或修改意图
SHALL 优先于批准短语。持续授权 SHALL NOT 跳过 Skill、OpenSpec 文档读写收据、guard、
verification 或 exact phase/event review request；只有这些证据完整后，系统 MAY 为同一 Change
写入带授权来源和时间的 delegated review receipt。

#### Scenario: 用户授权当前 Change 自主完成

- **WHEN** 用户明确要求当前 Change 后续无需例行询问并执行完成
- **THEN** session activation 写入只属于该 Change 的版本化 authority
- **AND** 每个 review phase 仍先生成精确 event 的 request 与完整证据
- **AND** delegated acknowledgement 可引用该 authority 后推进。

#### Scenario: 新目标不继承旧授权

- **GIVEN** Change A 具有有效持续授权
- **WHEN** 用户提出独立目标并创建 Change B
- **THEN** Change B 使用普通交互模式
- **AND** A 的 authority 不能确认 B 的任何 review event。

#### Scenario: 用户撤销持续授权

- **WHEN** 用户要求恢复逐步确认或撤回自主执行
- **THEN** 当前 Change 的 authority 被规范化撤销
- **AND** 后续 review 恢复人工确认门。

### Requirement: Branches without route SHALL never win by score

The router's versioned data contract SHALL carry whether a Workflow branch is eligible for content
scoring; a branch is routable only when it declares `route`. A non-routable branch MAY be used when the
user names it, but SHALL never enter the score loop or win by score.

A user naming a track (`用 X 轨道`, `--track X`) or a Workflow (`用 X 工作流`, `X:轨道`) SHALL be treated as
a direct user choice rather than as a routing score. If the named pair is not a valid Workflow branch,
the root pipeline skill SHALL obtain a legal pair before Change creation.

#### Scenario: A branch without route is visible but never auto-selected

- **GIVEN** a Workflow branch declares no `route`
- **WHEN** routing scores the available branches for a prompt
- **THEN** that branch has no score and cannot win
- **AND** the applicable routable branch remains the recommendation.

#### Scenario: Naming a Workflow selects it directly

- **WHEN** a user says to use the `design-system` Workflow for a new objective
- **THEN** the dispatch recommends `design-system` with its single implicit track
- **AND** no assessment is required.

### Requirement: Router cache SHALL regenerate when its schema or Workflow sources change

A cache created before the current row schema SHALL be rejected and regenerated. A change to the content
of any Workflow file in the project, global store, or plugin templates SHALL also regenerate it.
Project-controlled cache bytes SHALL remain bounded, data-only, and never be sourced or evaluated as shell.

#### Scenario: An old cache is regenerated

- **WHEN** the hook reads a cache whose schema predates Workflow-derived rows
- **THEN** it discards the cache and regenerates the current schema
- **AND** it does not infer any missing field.

#### Scenario: A Workflow file changes

- **WHEN** a Workflow file in the project, global store, or plugin templates changes content
- **THEN** the next cache load detects the change by content and regenerates the routing data
- **AND** the change takes effect for the next prompt.

### Requirement: Discussion SHALL not create a Change

A request to explain, discuss, or review without changing files SHALL NOT create a Change, and the
router SHALL NOT emit a new-Change dispatch for it.

#### Scenario: An explanation remains ordinary chat

- **WHEN** a user asks why a pipeline gate exists
- **THEN** the hook suppresses workflow execution
- **AND** no Change is created.

