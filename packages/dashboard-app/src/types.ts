/**
 * 前端契约类型 —— 逐字镜像 packages/server GET /api/snapshot 的响应体（server/src/types.ts）。
 * server 是消费源，前端只读这些形状；改 server 契约须同步改此处（无 npm 依赖跨包，手抄以保零耦合）。
 */

/** snapshot 里单个 change 的投影（.pipeline.yaml 全字段 + 常读字段提升到顶层）。 */
/** Declared user reference projected by the server (`Name <id>` fields); legacy values are null. */
export interface UserRefView {
  id: string
  name: string
  slug: string
}

export interface ChangeSnapshot {
  name: string
  path: string
  phase: string
  phase_status: string
  track: string
  preset: string
  archived: string
  updated_at: string
  fields: Record<string, string | string[]>
  owner: UserRefView | null
  creator: UserRefView | null
  workflowPlanFingerprint: string
  workflowRules: WorkflowRulesSnapshot
  workflowExecution: WorkflowExecutionSnapshot
  /** Optional only while a newer Dashboard can still be served by an older runtime. */
  reviewHandshake?: ReviewHandshakeSnapshot
  /** OpenSpec tasks.md projected by the server onto ordered workflow phases. */
  todo?: PipelineTodoProjection
  /** Server-evaluated OpenSpec document contract evidence. */
  documents?: DocumentEvidenceSnapshot
  /** Per-step skill execution state derived by the server from the history log; absent on older servers. */
  skillRuns?: SkillRunsSnapshot
  /** 每步 agent 的执行态与结论；步骤一个 agent 都没声明时整个字段缺席。 */
  agentRuns?: AgentRunsSnapshot
  /** Per-step declared tests with the acting user's latest run; absent when the branch declares none. */
  tests?: TestStepSnapshot[]
  /** Corrupt test record file names of the acting user. */
  testDiagnostics?: string[]
  /** Fresh, explicitly bound native terminal heartbeat; never a workflow-state field. */
  terminalActivity?: TerminalActivitySnapshot
}

export type TestItemStatus = 'passed' | 'failed' | 'stale' | 'missing' | 'running'

export interface TestRunSummary {
  runId: string
  user: string
  actor: { id: string; name: string }
  result: 'pass' | 'fail'
  exitCode: number | null
  durationMs: number
  finishedAt: string
  reasons: string[]
}

export interface TestItemSnapshot {
  id: string
  label?: string
  direction: string
  required: boolean
  status: TestItemStatus
  run?: TestRunSummary
}

export interface TestStepSnapshot {
  stepId: string
  items: TestItemSnapshot[]
}

export type SkillRunStatus = 'idle' | 'running' | 'done'

export type SkillRunsSnapshot = ReadonlyArray<{
  readonly stepId: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly status: SkillRunStatus; readonly wave: number }>
}>

export type AgentRunState = 'idle' | 'running' | 'done' | 'stale'
export type AgentRole = 'executor' | 'reviewer'
export type AgentSeverityView = 'critical' | 'high' | 'medium' | 'low'

export interface AgentRunView {
  readonly agent: string
  readonly role: AgentRole
  readonly required: boolean
  readonly blockAt?: AgentSeverityView
  readonly dependsOn: readonly string[]
  readonly readsTests: readonly string[]
  readonly state: AgentRunState
  readonly result: 'pass' | 'fail' | 'done' | 'failed' | null
  readonly findings: number
  readonly blocking: number
  readonly runId: string | null
  readonly reportPath: string | null
  readonly actor: { readonly id: string; readonly name: string } | null
  readonly finishedAt: string | null
}

export type AgentRunsSnapshot = ReadonlyArray<{
  readonly stepId: string
  readonly agents: readonly AgentRunView[]
}>

export type ReviewHandshakeSnapshot =
  | { status: 'not-requested' }
  | { status: 'pending'; event: string; requestedAt: string }
  | {
      status: 'approved'
      event: string
      requestedAt: string
      acknowledgedAt: string
    }

export interface TerminalActivitySnapshot {
  sessionId: string
  heartbeatAt: string
  expiresAt: string
  turnId?: string
}

/** 过期原因：内容变了 / 产出技能不符 / 登记未原子完成 / 旧 delta 路径。 */
export type DocumentStaleReason = 'changed' | 'producer' | 'invocation' | 'legacy-path'

export interface DocumentEvidenceSnapshot {
  governed: boolean
  phase?: string
  ledgerPresent?: boolean
  pass?: boolean
  blockers: string[]
  items: Array<{
    kind: string
    status: 'recorded' | 'missing' | 'stale' | 'unread'
    /** Only when status is stale. */
    reason?: DocumentStaleReason
    requiredRead: boolean
    paths: string[]
    producers: string[]
    timeline?: Array<{ producer: string; recordedAt: string; readAt?: string; actor?: { id: string; name: string } }>
  }>
}

export interface PipelineTodoItem {
  text: string
  completed: boolean
}

export interface PipelineTodoStage {
  id: string
  label: string
  status: 'done' | 'current' | 'pending'
  tasks: PipelineTodoItem[]
}

export interface PipelineTodoProjection {
  hasTaskSource: boolean
  stages: PipelineTodoStage[]
}

export interface WorkflowRulesSnapshot {
  executionModel: 'phase-manifest' | 'step-graph'
  steps: string[]
  transitions: Record<string, Array<{ event: string; to: string }>>
  gateByStep: Record<string, 'review' | 'auto' | null>
  labelByStep: Record<string, string>
  outputsByStep: Record<string, string[]>
  /** Present on policy-aware servers; omitted only during the rolling compatibility window. */
  policy?: WorkflowPolicyRulesSnapshot
}

export type WorkflowPolicyAction =
  | 'suggest-decomposition' | 'materialize-work-items' | 'create-child-pipeline'
  | 'apply-recommended-default' | 'enter-afk' | 'write-filesystem' | 'create-branch'
  | 'create-pull-request' | 'merge-pull-request' | 'call-external-api' | 'publish-external'
  | 'operate-production' | 'incur-cost' | 'access-credentials' | 'perform-irreversible-action'

export interface WorkflowPolicyRulesSnapshot {
  schema: 'workflow-policy/v1'
  configured:
    | {
        status: 'available'
        workflowFingerprint: string
        decomposition: WorkflowDecompositionPolicySnapshot
        interaction: WorkflowInteractionPolicySnapshot
      }
    | { status: 'missing' | 'invalid' | 'unavailable' }
  frozen: {
    workflowFingerprint: string
    decomposition: WorkflowDecompositionPolicySnapshot
    interaction: WorkflowInteractionPolicySnapshot
    workflowCeiling: { status: 'valid'; grants: WorkflowPolicyAction[] }
  }
  effective:
    | { status: 'unavailable'; reason: 'authority-input-unavailable' }
    | {
        status: 'available'
        grants: WorkflowPolicyAction[]
        denials: Array<{ action: WorkflowPolicyAction; layer?: string; code: string; remediation: string }>
      }
  drift: {
    status: 'current' | 'changed' | 'missing' | 'invalid' | 'unavailable'
    fingerprintChanged: boolean | null
    policyChanged: boolean | null
  }
}

export interface WorkflowDecompositionPolicySnapshot {
  version: 'v1'
  mode: 'off' | 'suggest' | 'auto-safe' | 'require-review'
  target: 'work-items' | 'child-pipelines'
  strategy: 'balanced' | 'breadth-first' | 'depth-first'
  max_items: number
  max_depth: number
  auto_when: Array<'independent-work-items' | 'cross-component-boundary' | 'context-budget-risk'>
  ask_when: Array<'ambiguous-requirements' | 'hard-boundary' | 'missing-authorization' | 'limit-exceeded'>
}

export interface WorkflowInteractionPolicySnapshot {
  version: 'v1'
  mode: 'interactive' | 'recommended-defaults' | 'afk'
}

export interface WorkflowExecutionSnapshot {
  readinessByTransition: Record<string, Record<string, TransitionReadinessSnapshot>>
}

export interface TransitionReadinessSnapshot {
  ready: boolean
  blockers: TransitionReadinessBlockerSnapshot[]
}

export type TransitionReadinessBlockerSnapshot =
  | {
      kind: 'verify-build-revision-untrusted'
      code: 'verify-build-revision-untrusted'
      reason:
        | 'missing' | 'null' | 'ambiguous' | 'malformed' | 'isolation-mismatch'
        | 'capability-unavailable' | 'provenance-missing' | 'provenance-mismatch'
        | 'state-stale' | 'revision-stale' | 'project-mismatch' | 'worktree-mismatch'
        | 'evaluation-error'
      remediation: 'return-to-build-and-capture-current-revision'
      stateHash?: string
      revisionHash?: string
    }
  | {
      kind: 'guard-failed'
      guardType: string
      field?: string
      actual?: string
      expected?: string[]
    }
  | {
      kind: 'capability-unavailable'
      guardType: string
      capability: string
    }
  | {
      kind: 'evaluation-error'
      guardType: string
      capability?: string
    }
  | {
      kind: 'agents-incomplete'
      agents: { agent: string; reason: string }[]
    }

/** 单个已注册 Project 的聚合。 */
export interface CanonicalStateCompatibilityIssue {
  severity?: 'blocking'
  kind: 'unsupported-canonical-version'
  change: string
  foundVersion: number
  supportedVersion: number
  action: 'upgrade-runtime'
}

export interface LegacyScopeCompatibilityIssue {
  severity?: 'warning' | 'blocking'
  kind: 'legacy-scope-unmerged'
  change: string
  legacyScopePath: string
  action: 'merge-or-remove-legacy-scope'
}

export interface ProjectRepositoryIdentity {
  id: string
  label: string
  workspace_kind: 'primary' | 'worktree'
}

/** 归档只对查看者生效：同一个 change 在别人的快照里仍在 changes。 */
export type ArchivedChangeSnapshot = ChangeSnapshot & {
  archive: { archivedAt: string; phase: string; actor: { id: string; name: string; trust: 'declared' } }
}

export interface ProjectSnapshot {
  root: string
  ok: boolean
  changes: ChangeSnapshot[]
  /** 查看者已归档的 change；每个聚合读数都只读 changes，故自动排除它们。 */
  archived?: ArchivedChangeSnapshot[]
  /** 未提交删除的 change 数；仓库不受版本控制时缺省。 */
  uncommittedDeletions?: number
  repository?: ProjectRepositoryIdentity
  compatibilityIssues?: (CanonicalStateCompatibilityIssue | LegacyScopeCompatibilityIssue)[]
  compatibilityIssuesTruncated?: true
  error?: string
}

/** GET /api/snapshot 的完整响应体。 */
export interface Snapshot {
  snapshot_protocol?: 'tenon-snapshot/v2'
  version: string
  generated_at: string
  /** 能力声明（GOAL B6）：前端按声明渲染，未接线域不谎报（Advanced 占位据此标注）。 */
  capabilities: Record<string, boolean>
  project_count: number
  change_count: number
  projects: ProjectSnapshot[]
}

// ── 流程规则镜像（单一真相源 = 老仓/新仓 templates/manifest.yaml，此处为前端只读镜像）──

export const PHASES = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const
export type Phase = (typeof PHASES)[number]

/**
 * review-gate 阶段（manifest review_phases 镜像）：进入这些阶段即落复核门 marker，
 * 是"在等我决定"的判据源（收件箱据此选卡，B10/病灶②的解法）。
 */
export const REVIEW_PHASES = ['explore', 'spec', 'verify'] as const

/** from → 合法目标阶段（manifest transitions 镜像；build/verify 都有受控回退出口）。 */
export const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  open: ['explore'],
  explore: ['spec'],
  spec: ['build'],
  build: ['verify', 'spec'],
  verify: ['ship', 'build'],
  ship: ['archive'],
  archive: ['archive'],
}

/** phase 边 → 转换 event 名（逐边镜像 server/src/transition.ts TRANSITION_EVENTS）。 */
export const EVENT_BY_EDGE: Record<string, string> = {
  'open->explore': 'open-complete',
  'explore->spec': 'explore-complete',
  'spec->build': 'spec-complete',
  'build->verify': 'build-complete',
  'build->spec': 'requirements-changed',
  'verify->ship': 'verify-pass',
  'verify->build': 'verify-fail',
  'ship->archive': 'ship-complete',
  'archive->archive': 'archived',
}

export function isPhase(v: string): v is Phase {
  return (PHASES as readonly string[]).includes(v)
}
