# OpenSpec 增量规格

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Every Workflow SHALL have a neutral executable entry

**Reason**: Tracks are branches of their Workflow; a Workflow without branches is itself a single track, so a neutral `free` Track that binds any Workflow is no longer needed.
**Migration**: Run `tenon init <c> --workflow <w>` without `--track` for a flat Workflow, or name one of its branches; in-flight `free` Changes finish on their frozen snapshots.

### Requirement: Discussion and free execution SHALL remain distinct

**Reason**: The `chat` and `free` tracks are removed; the remaining rule (discussion never creates a Change) is restated without them.
**Migration**: See the added requirement "Discussion SHALL not create a Change".

### Requirement: Manual candidates SHALL be independent from routable scorers

**Reason**: Its scenarios are defined around the retired `free` Track and explicit free mode.
**Migration**: See the added requirement "Branches without route SHALL never win by score".

### Requirement: Router schema migration SHALL fail closed

**Reason**: Its scenarios depend on the retired `free` routability flag and `.pipeline/tracks.yaml`.
**Migration**: See the added requirement "Router cache SHALL regenerate when its schema or Workflow sources change".

## ADDED Requirements

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
