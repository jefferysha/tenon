import type { TestLevel } from '@tenon/kernel/workflow/test-level'

export type WbHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

export interface WbHookMeta {
  id: string
  event: WbHookEvent
  matcher: string
  script: string
  configurable: boolean
}

export interface WbHooksConfig {
  hooks: WbHookMeta[]
  matrix: Record<string, false>
  promptSkipKeyword: string
}

export interface ChangeHistoryEntry {
  ts: string
  kind: string
  field?: string
  from?: string
  to?: string
  /** Declared operator of a CLI/server write; host evidence rows carry none. */
  actor?: { id: string; name: string; trust: 'declared' }
  raw?: string
}

export interface WbSkillEntry {
  name: string
  installed: boolean
  source: 'local-plugin' | 'external-marketplace' | 'builtin' | 'user'
  description?: string
  tier?: 'mandatory' | 'recommended' | 'conditional' | 'optional'
  available?: boolean
  installCmd?: string
  version?: string
}

export interface WbFieldRef {
  field: string
  type: 'string' | 'file_path' | 'boolean'
}

export interface WbSkillRef {
  id: string
  depends_on?: string[]
}

export type WbAgentSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface WbExecutorRef {
  agent: string
  depends_on?: string[]
}

export interface WbReviewerRef {
  agent: string
  required: boolean
  block_at: WbAgentSeverity
  depends_on?: string[]
  reads_tests?: string[]
  /** 跨厂商评审：必须在哪个宿主上跑（codex | claude），any = 不限；缺省 = 不要求。 */
  host?: WbReviewerHost
}

export type WbReviewerHost = 'codex' | 'claude' | 'any'

/** 步骤 agent 块；两个列表都空时定义里没有这个键。 */
export interface WbStepAgents {
  executors: WbExecutorRef[]
  reviewers: WbReviewerRef[]
}

/** 某技能目录的文件清单（GET /api/skills/:name/files）。 */
export interface WbSkillFiles {
  name: string
  source: WbSkillEntry['source']
  origin: string
  files: Array<{ path: string; bytes: number }>
}

/** 技能目录内一个文本文件（GET /api/skills/:name/file?path=）。 */
export interface WbSkillFile {
  path: string
  text: string
}

export interface WbTrackPredicate {
  kind: 'track-in' | 'track-not-in'
  values: string[]
}

export type WbGuardConfig = (
  | { type: 'tasks-at-least'; n: number }
  | { type: 'nonempty-output' }
  | { type: 'field-nonempty'; field: string }
  | { type: 'file-exists'; path: { kind: 'field'; field: string } }
  | { type: 'field-equals'; field: string; value: string }
  | { type: 'field-in'; field: string; values: [string, ...string[]] }
  | { type: 'full-direct-override' }
  | { type: 'build-head-unchanged'; field: 'build_sha' }
  | { type: 'spec-migration-applied' }
  | { type: 'tasks-through-step' }
  | { type: 'not-afk-queued' }
  | { type: 'dependencies-ended' }
  | { type: 'required-output'; path: string }
) & { when?: WbTrackPredicate }

export type WbActionConfig =
  | { type: 'freeze-build-sha' }
  | { type: 'mark-verification-passed' }
  | { type: 'mark-verification-failed' }
  | { type: 'reset-pre-verify-review' }
  | { type: 'archive-run' }

export interface WbArtifactConfig {
  field: string
  type: 'file_path'
  producerPolicy: 'effective-step-skills' | 'effective-phase-skills'
  requiredWhen?: WbTrackPredicate
}

export interface WbTransition {
  event: string
  to: string
  guards?: WbGuardConfig[]
  actions?: WbActionConfig[]
}

export type WbTestOutputKind = 'report' | 'coverage' | 'metrics' | 'trace' | 'screenshot' | 'log' | 'other'

export type WbTestInput =
  | { kind: 'document'; ref: string }
  | { kind: 'file'; path: string }
  | { kind: 'env'; name: string }
  | { kind: 'service'; name: string; url?: string }

export interface WbTestOutput {
  path: string
  kind?: WbTestOutputKind
  required?: boolean
}

export interface WbTestMetric {
  name: string
  max?: number
  min?: number
  max_regression_pct?: number
  better?: 'lower' | 'higher'
}

/** 步骤测试项：与 kernel StepTestDef 同形（snake_case 上线），`direction` 只记来源方向 id。 */
export interface WbStepTest {
  id: string
  direction: string
  command: string
  cwd?: string
  label?: string
  timeout_s?: number
  required?: boolean
  keep_runs?: number
  scope?: 'full' | 'known'
  metrics_path?: string
  pass?: { exit_code?: number; metrics?: WbTestMetric[] }
  inputs?: WbTestInput[]
  outputs?: WbTestOutput[]
}

/** 覆盖率门槛的指标名（kernel COVERAGE_METRICS；snake_case 上线）。 */
export type WbCoverageMetric = 'lines' | 'branches' | 'functions' | 'statements' | 'changed_lines'

/**
 * 步骤测试策略：与 kernel StepTestPolicyDef 同形（snake_case 上线，只含声明过的键）。
 * 读回的定义原样带着它，保存时原样写回——页面上没有表单项的键也不能被丢掉。
 */
export interface WbStepTestPolicy {
  plan?: 'required' | 'optional'
  kinds?: string[]
  run?: string[]
  run_if_registered?: string[]
  scope?: 'changed' | 'full'
  files?: 'registered' | 'any'
  scenarios?: 'off' | 'required' | 'passing'
  /** 测试完整性：缺省（= notice）只提示，block 让信号挡住出口。 */
  integrity?: 'notice' | 'block'
  coverage?: Partial<Record<WbCoverageMetric, number>>
  flaky?: { max: number; fail_on_new?: boolean }
  benchmark?: { require_baseline: boolean }
  browsers?: string[]
}

/** 步骤的测试档位（kernel TEST_LEVELS）：不要求 / 写计划 / 跑改动 / 全量；档位含义在项目测试目录的 levels。 */
export type WbTestLevel = TestLevel

export interface WbStepDef {
  id: string
  label: string
  gate: 'review' | 'auto' | null
  prompt?: string
  /** 验证轮次上限（1–20）；读写原样保留，没有编辑控件。 */
  maxRounds?: number
  skills: WbSkillRef[]
  inputs: WbFieldRef[]
  outputs: WbFieldRef[]
  artifacts?: WbArtifactConfig[]
  tests?: WbStepTest[]
  /** 测试档位；与旧 `test_policy` 互斥（同一步只会有其一）。 */
  test?: WbTestLevel
  /** 旧逐字段策略：只读保留，选了档位就被替换。 */
  test_policy?: WbStepTestPolicy
  agents?: WbStepAgents
  guards: WbGuardConfig[]
  transitions: WbTransition[]
}

export type WbDecompositionMode = 'off' | 'suggest' | 'auto-safe' | 'require-review'
export type WbDecompositionTarget = 'work-items' | 'child-pipelines'
export type WbDecompositionStrategy = 'balanced' | 'breadth-first' | 'depth-first'
export type WbDecompositionAutoWhen =
  | 'independent-work-items'
  | 'cross-component-boundary'
  | 'context-budget-risk'
export type WbDecompositionAskWhen =
  | 'ambiguous-requirements'
  | 'hard-boundary'
  | 'missing-authorization'
  | 'limit-exceeded'

export interface WbDecompositionPolicy {
  version: 'v1'
  mode: WbDecompositionMode
  target: WbDecompositionTarget
  strategy: WbDecompositionStrategy
  max_items: number
  max_depth: number
  auto_when: WbDecompositionAutoWhen[]
  ask_when: WbDecompositionAskWhen[]
}

export type WbInteractionMode = 'interactive' | 'recommended-defaults' | 'afk'

export interface WbInteractionPolicy {
  version: 'v1'
  mode: WbInteractionMode
}

export const DEFAULT_WB_DECOMPOSITION_POLICY: WbDecompositionPolicy = {
  version: 'v1',
  mode: 'off',
  target: 'work-items',
  strategy: 'balanced',
  max_items: 16,
  max_depth: 2,
  auto_when: [],
  ask_when: [],
}

export const DEFAULT_WB_INTERACTION_POLICY: WbInteractionPolicy = {
  version: 'v1',
  mode: 'interactive',
}

/**
 * 任务编排里一步的一个真实输入 / 输出文件（`stepIo`）。观察模式（新任务）取离开步骤时记下的产出，
 * 契约模式（升级前创建的任务）把旧账本映射成同一形状——后者没有 `change`。
 */
export interface WbStepIoFile {
  /** 相对项目根。 */
  path: string
  /** 输出：本步对它做了什么；契约模式没有。 */
  change?: 'added' | 'modified' | 'deleted'
  /** 来源技能；推断不出来是 null。 */
  skill: string | null
  /** 输入：它由哪一步产出。 */
  fromStep?: string
  /** 输入：本步是否读过。 */
  read?: boolean
}

export interface WbStepIoEntry {
  inputs: WbStepIoFile[]
  outputs: WbStepIoFile[]
  /** 本步的必须产出（`required-output` 守卫）；契约模式恒为空。 */
  required: Array<{ path: string; produced: boolean }>
}

/** builtin = 内建模板；global = 用户级全局存储；project = 项目目录里的遗留覆盖文件。 */
export type WbWorkflowSource = 'builtin' | 'project' | 'global'

export interface WbWorkflowDef {
  name: string
  /** 读接口附带：内建模板 / 项目文件（default 有覆盖文件时为 project）。写回前剔除。 */
  source?: WbWorkflowSource
  /** OpenSpec 开关；default 恒为 true。 */
  openspec?: boolean
  /** Omitted only by pre-policy in-memory fixtures; HTTP decoding always projects safe v1 defaults. */
  decomposition?: WbDecompositionPolicy
  /** Omitted only by pre-policy in-memory fixtures; HTTP decoding always projects safe v1 defaults. */
  interaction?: WbInteractionPolicy
  /** 通用分支：track 未命中任何 tracks.<id> 时使用的 pipeline。 */
  steps: WbStepDef[]
  /** track 分支：每条 track 自己的完整 pipeline。 */
  tracks?: Record<string, WbTrackBranch>
  /** 读接口附带：每条分支（`_base` = 通用）的名称。写回前剔除。 */
  branches?: Record<string, WbBranchProjection>
}

/** 分支是否走 OpenSpec；不写时继承工作流顶层 `openspec`。 */
export type WbTrackSpec = 'openspec' | 'none'

/** 分支参与自动路由的打分数据；不写 `route` 的分支只能点名使用。 */
export interface WbTrackRoute {
  keywords: string[]
  exclude: string[]
  priority: number
  fallback: boolean
}

export interface WbTrackAutomation {
  eligible: boolean
  enqueueAfterSpec: boolean
}

export interface WbTrackBranch {
  label?: string
  /** 只在分支声明了 `spec` 时出现；解码不凭空补键，写回保持原样。 */
  spec?: WbTrackSpec
  route?: WbTrackRoute
  automation?: WbTrackAutomation
  steps: WbStepDef[]
}

export interface WbBranchProjection {
  label?: string
}

