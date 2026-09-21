# Workflow Skill Enforcement Specification

## Purpose

定义 Workflow phase Skill、Track overlay 与显式 profile 的分层能力投影，以及 Hook、transition、AFK
准备和受控文档之间的一致性与失败关闭契约。

## Requirements

### Requirement: Effective resolver SHALL separate Workflow phase requirements from Track overlays

default Workflow 的 effective Skill capability SHALL 把当前 step 声明的 Skill 作为 Workflow-owned
phase requirements；该要求 SHALL 随 workflow plan snapshot 冻结，并且 SHALL NOT 因
`trackOverlay.matrix=false` 被删除。manifest profile 的 mandatory/recommended Skills SHALL 仅在
`matrix=true` 时作为自动 Track overlay 合并。合并 SHALL 保持 phase-first 顺序并稳定去重。

#### Scenario: Free/default 解析当前 phase

- **GIVEN** 一个 `track=free`、`workflow=default` 的 Change 位于 Build
- **AND** free Track 的 `matrix=false`
- **WHEN** resolver 解析 required 与 available slots
- **THEN** 两者均首先包含 default Workflow 在该 step 声明的技能（Build 为 `test-driven-development`）
- **AND** 不包含 PM/frontend/backend 的 Track overlay。

#### Scenario: Matrix-enabled Track 保留原 overlay

- **GIVEN** 一个 matrix-enabled backend/default Change 位于 Explore
- **WHEN** resolver 解析 required 与 available slots
- **THEN** default Workflow 在 Explore 声明的技能位于首个 phase slot
- **AND** 原 backend mandatory/recommended overlay 保持声明顺序且不重复。

#### Scenario: Custom Workflow 保持 step-declared 语义

- **GIVEN** custom Workflow 的当前 step 声明自己的 Skill DAG
- **WHEN** 同一 resolver 解析 required、available 或 bundle slots
- **THEN** 结果仅来自该冻结 step 声明
- **AND** default phase Skill 与 manifest Track overlay 均不注入。

### Requirement: Explicit profile authorization SHALL remain distinct from automatic overlay

resolver SHALL 提供具名的 explicit profile 投影，用于 artifact producer 与 AFK bundle 的显式选择。
该投影 SHALL 合并当前 Workflow phase requirement 与所选 profile 的 mandatory/recommended slots，
但 SHALL NOT 改变 Hook/transition 的 `matrix` 判定。现有 free profile SHALL 继续作为显式文档 producer
allowlist，而不是 free/default 的自动 exit requirements。

#### Scenario: Free Verify 报告 producer 保持兼容

- **GIVEN** free/default Verify 的 matrix 已关闭
- **WHEN** `verification-before-completion` 以 free profile 的显式 producer 身份登记报告
- **THEN** artifact registration 仍成功
- **AND** Hook/transition 不把该 profile 当作自动 overlay。

#### Scenario: Explicit AFK bundle 始终包含 phase slot

- **GIVEN** default execution preparation 选择一个合法 `skill_bundle_id`
- **WHEN** bundle resolver 物化显式 profile
- **THEN** snapshot slots 首先包含当前冻结 phase requirement
- **AND** 后续才包含所选 profile slots。

### Requirement: Hook and transitions SHALL reject a missing current-visit phase Skill

default Hook、CLI transition 与 HTTP transition SHALL 使用同一 effective required/available
projection。除精确根编排入口 `tenon` 外，当前 phase requirement 未完成时，Hook SHALL 拒绝 overlay
Skill 及未声明的可选 Skill；phase requirement 本身 SHALL 可作为首个调用。CLI 与 HTTP transition
SHALL 在缺少同 Change、同 phase、当前 step visit 的完成态 receipt 时以相同 incomplete-Skill reason
拒绝。

#### Scenario: Hook 负例不能由可选 Skill 绕过

- **GIVEN** free/default 当前 visit 尚无 `test-driven-development` receipt
- **WHEN** 调用任一非根入口 Skill
- **THEN** Hook 返回拒绝并指出缺少 `test-driven-development`
- **WHEN** 当前 visit 产生有效 `test-driven-development` receipt
- **THEN** 未受其他 DAG 约束的可选 Skill 可继续调用。

#### Scenario: CLI 与 HTTP transition 同时失败关闭

- **GIVEN** free/default 当前 phase 的 documents、review 与其他 guards 已满足
- **BUT** 当前 visit 缺少 phase Skill receipt
- **WHEN** CLI 或 HTTP 请求离开该 phase
- **THEN** 两条路径均拒绝且不写 canonical state
- **AND** 旧 visit、其他 phase 或其他 Change 的 receipt 均不能满足要求。

### Requirement: AFK preparation SHALL fail closed when phase Skill content is unavailable

default AFK coordinate SHALL capture the frozen effective Skill capability and bind workflow, manifest,
and track inputs to the existing TOCTOU digest. Preparation SHALL use the unified explicit profile
projection. A missing, invalid, or changed phase Skill SHALL produce the existing structured failure
reason, SHALL NOT create a sandbox, activate a run, or charge execution, and SHALL NOT be reclassified
as an empty queue.

The CLI round SHALL validate active-loop wiring before scanning the queue. When wiring is valid and the
fresh ready scan is empty, the round SHALL return `status=empty`; `tenon afk run` SHALL exit `0`, print
the empty-queue message, and make no Docker call. A Docker-unavailable candidate SHALL return
`status=docker-unavailable` and exit `1`; policy, capability, or Skill wiring failure SHALL return
`status=configuration-error` (or its existing structured fail-closed classification) and exit non-zero.

#### Scenario: Profile 存在但 phase Skill 缺失

- **GIVEN** default AFK admission 的 profile 合法且 profile Skills 均可定位
- **BUT** 当前 frozen phase requirement 的 Skill 内容不可定位
- **WHEN** execution preparation 构造 bundle
- **THEN** preparation 以 `skill-bundle-skill-not-found` 拒绝
- **AND** 不发布一个缺少 phase slot 的空或部分 snapshot。

#### Scenario: Empty queue succeeds after hermetic wiring

- **GIVEN** active-loop wiring and the frozen phase Skill content are valid
- **AND** the fresh ready scan contains no `phase=build` and `automation=queued` candidate
- **WHEN** an operator invokes `tenon afk run`
- **THEN** the CLI returns exit `0`
- **AND** prints the empty-ready-queue message
- **AND** does not call Docker or create a sandbox/run record

#### Scenario: Candidate with Docker unavailable remains a failure

- **GIVEN** active-loop wiring is valid
- **AND** the fresh ready scan contains at least one ready candidate
- **AND** Docker is unavailable
- **WHEN** an operator invokes `tenon afk run`
- **THEN** the CLI returns exit `1`
- **AND** exposes `status=docker-unavailable` (including the ready candidates)
- **AND** does not print a successful empty-queue result

#### Scenario: Missing phase Skill remains fail-closed

- **GIVEN** an active loop requires a frozen phase Skill that cannot be located
- **WHEN** an operator invokes `tenon afk run`
- **THEN** the CLI returns a non-zero configuration/wiring failure
- **AND** does not classify the round as `empty`
- **AND** does not create a sandbox, charge execution, or weaken phase Skill enforcement

### Requirement: Runtime, doctor, Skills, and documentation SHALL share one checked contract

default workflow source、受控生成 runtime、doctor、manifest comments、打包 `skills/tenon` 与英文/
中文用户文档 SHALL 描述同一分层合同。doctor SHALL 分别说明 Workflow phase requirements、自动 Track
overlays 与显式 profile allowlists，并验证其中 mandatory phase Skills 可发现。CI SHALL 在 source、
generated runtime 或受控文档合同发生漂移时失败。

#### Scenario: Default phase map 漂移

- **WHEN** default workflow step Skill、生成 runtime、doctor 派生或受控文档中的 phase map 不一致
- **THEN** freshness/contract check 以非零状态失败
- **AND** release bundle 不得被视为可发布。
