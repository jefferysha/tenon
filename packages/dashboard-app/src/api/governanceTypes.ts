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
  by?: string
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
  kind?: 'work' | 'review'
  review_lane?: string
  depends_on?: string[]
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

export interface WbStepDef {
  id: string
  label: string
  gate: 'review' | 'auto' | null
  prompt?: string
  reviewLanes?: string[]
  skills: WbSkillRef[]
  inputs: WbFieldRef[]
  outputs: WbFieldRef[]
  artifacts?: WbArtifactConfig[]
  guards: WbGuardConfig[]
  transitions: WbTransition[]
}

export interface WbDocumentContract {
  version: 'v1'
  /** role 缺省 = produce；require 没有 producers（空数组）。 */
  slots: Array<{ kind: string; ownerStep: string; role?: 'update' | 'require'; producers: string[] }>
  reads: Array<{ step: string; kinds: string[] }>
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

export interface WbReviewBudgetPolicy {
  version: 'v1'
  max_attempts: number
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

export const DEFAULT_WB_REVIEW_BUDGET_POLICY: WbReviewBudgetPolicy = {
  version: 'v1',
  max_attempts: 2,
}

/** 服务端物化的一个输入 / 输出槽位：文档（登记台账）或值（change 字段）。 */
export type WbIoSlot =
  | { kind: 'document'; id: string; role: 'produce' | 'update' | 'read' | 'require'; scope: 'change' | 'project'; producers: string[]; consumers: string[] }
  | { kind: 'field'; id: string; type: 'string' | 'file_path' | 'boolean'; producer: string | null; consumers: string[] }

export interface WbStepIo {
  inputs: WbIoSlot[]
  outputs: WbIoSlot[]
}

export type WbEffectiveIo = Record<string, WbStepIo>

/** builtin = 内建模板；global = 用户级全局存储；project = 项目目录里的遗留覆盖文件。 */
export type WbWorkflowSource = 'builtin' | 'project' | 'global'

export interface WbWorkflowDef {
  name: string
  /** 读接口附带：内建模板 / 项目文件（default 有覆盖文件时为 project）。写回前剔除。 */
  source?: WbWorkflowSource
  /** 读接口附带：每步物化后的输入 / 输出（文档槽位 + 值槽位）。写回前剔除。 */
  effectiveIo?: WbEffectiveIo
  /** OpenSpec 开关；default 恒为 true。 */
  openspec?: boolean
  /** 只与顶层 steps 同在；有 tracks 时写在 tracks.<id>.documentContract。 */
  documentContract?: WbDocumentContract
  /** Omitted only by pre-policy in-memory fixtures; HTTP decoding always projects safe v1 defaults. */
  decomposition?: WbDecompositionPolicy
  /** Omitted only by pre-policy in-memory fixtures; HTTP decoding always projects safe v1 defaults. */
  interaction?: WbInteractionPolicy
  /** Omitted only by pre-policy in-memory fixtures; HTTP decoding always projects a finite v1 budget. */
  reviewBudget?: WbReviewBudgetPolicy
  /** 通用分支：track 未命中任何 tracks.<id> 时使用的 pipeline。 */
  steps: WbStepDef[]
  /** track 分支：每条 track 自己的完整 pipeline。 */
  tracks?: Record<string, WbTrackBranch>
  /** 读接口附带：每条分支（`_base` = 通用）物化后的 IO。写回前剔除。 */
  branches?: Record<string, WbBranchProjection>
}

export interface WbTrackBranch {
  label?: string
  documentContract?: WbDocumentContract
  steps: WbStepDef[]
}

export interface WbBranchProjection {
  label?: string
  effectiveIo: WbEffectiveIo
}

export interface WbTrackDefinition {
  id: string
  label: string
  builtin: boolean
  workflow: { default: string; allowed: '*' | string[] }
  policyProfile: {
    reviewSeed: 'pending' | 'skipped'
    autoEnqueueOnSpecComplete?: boolean
    automationEligible: boolean
    coverageProfile: 'none' | 'pm' | 'frontend' | 'backend'
    routing:
      | { enabled: false }
      | { enabled: true; pattern: string; excludePattern?: string; priority: number }
    skills: { matrix: boolean; profile: string }
  }
}

export interface WbRouterPreviewCandidate {
  track: WbTrackDefinition
  order: number
  priority: number
  score: number
  routable: boolean
  excluded: boolean
}

export interface WbRouterPreview {
  ok: true
  revision: string
  source: 'builtin-only' | 'project-file'
  winner: WbRouterPreviewCandidate | null
  candidates: WbRouterPreviewCandidate[]
  suppressed_reason: 'system-notification' | 'slash-command' | 'discussion' | null
}

export type ChangeSessionStatus = 'not_requested' | 'unavailable' | 'failed' | 'degraded' | 'active'

export interface ChangeSessionLaunch {
  requested: boolean
  active: boolean
  status: ChangeSessionStatus
  exit_code: number | null
}

export interface CreatedChange {
  ok: true
  name: string
  /** Current servers return the initialized directory; older compatible responses may omit it. */
  path?: string
  task_prompt_saved?: boolean
  session?: ChangeSessionLaunch
}

export interface WbConfigSnapshot {
  ok: true
  generated_at: string
  revision: string
  source: 'builtin-only' | 'project-file'
  mandatory_skills: Record<string, string[]>
  tracks: WbTrackDefinition[]
  mandatory_skills_writable_profiles: string[]
}
