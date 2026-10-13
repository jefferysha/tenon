export const CONTEXT_BUNDLE_PHASES = [
  'open',
  'explore',
  'spec',
  'build',
  'verify',
  'ship',
  'archive',
] as const

export type ContextBundlePhase = (typeof CONTEXT_BUNDLE_PHASES)[number]
export type ContextBundleTier = 'light' | 'strong'
export type ContextBundleMode = 'full' | 'summary' | 'reference'
export const CONTEXT_BUNDLE_DOCUMENT_KINDS = [
  'proposal',
  'openspec-design',
  'tasks',
  'superpower-design',
  'adr',
  'delta-spec',
  'superpower-plan',
  'plan',
  'verification-report',
  'applied-spec',
] as const
export type ContextBundleDocumentKind = (typeof CONTEXT_BUNDLE_DOCUMENT_KINDS)[number]
export const CONTEXT_BUNDLE_REASON_CODES = [
  'context-bundle.reason.proposal',
  'context-bundle.reason.openspec-design',
  'context-bundle.reason.tasks',
  'context-bundle.reason.superpower-design',
  'context-bundle.reason.adr',
  'context-bundle.reason.delta-spec',
  'context-bundle.reason.superpower-plan',
  'context-bundle.reason.plan',
  'context-bundle.reason.verification-report',
  'context-bundle.reason.applied-spec',
] as const
export type ContextBundleReasonCode = (typeof CONTEXT_BUNDLE_REASON_CODES)[number]

/** 观察模式（新任务）预览里的输入：当前步骤从直接上游交接来的文件，kind 与原因码各只有这一种。 */
export const CONTEXT_BUNDLE_HANDOFF_KIND = 'handoff'
export const CONTEXT_BUNDLE_HANDOFF_REASON_CODE = 'context-bundle.reason.handoff'

interface ContextBundlePreviewInputBase {
  path: string
  digest: string
  reason: string
  mode: ContextBundleMode
  sourceBytes: number
  materializedBytes: number
}

/** 契约模式（升级前创建的任务）：按文档台账的 kind 编译。 */
export interface ContextBundleContractInput extends ContextBundlePreviewInputBase {
  kind: ContextBundleDocumentKind
  reasonCode: ContextBundleReasonCode
}

export interface ContextBundleHandoffInput extends ContextBundlePreviewInputBase {
  kind: typeof CONTEXT_BUNDLE_HANDOFF_KIND
  reasonCode: typeof CONTEXT_BUNDLE_HANDOFF_REASON_CODE
  fromStep: string
  /** 来源技能；推断不出来是 null。 */
  skill: string | null
}

export type ContextBundlePreviewInput = ContextBundleContractInput | ContextBundleHandoffInput

export interface ContextBundlePreviewBudget {
  maxBytes: number
  usedBytes: number
  fits: boolean
}

interface ContextBundlePreviewBase {
  schemaVersion: 'context-bundle-preview/v1'
  sideEffects: 'none'
  change: string
  from: string
  to: ContextBundlePhase
  tier: ContextBundleTier
  documentCount: number
  inputs: ContextBundlePreviewInput[]
  budget: ContextBundlePreviewBudget
}

export interface ContextBundlePreviewSuccess extends ContextBundlePreviewBase {
  budget: ContextBundlePreviewBudget & { fits: true }
  aggregateDigest: string
}

export interface ContextBundlePreviewFailure extends ContextBundlePreviewBase {
  budget: ContextBundlePreviewBudget & { fits: false }
  aggregateDigest?: never
}

export interface ContextBundlePreviewRequest {
  root: string
  change: string
  target: ContextBundlePhase
  budgetBytes: number
  signal?: AbortSignal
}

export interface ContextBundleErrorDetail {
  kind?: ContextBundleDocumentKind
  path?: string
  requiredBytes?: number
  availableBytes?: number
  metric?: 'records' | 'sourceBytesPerDocument' | 'totalSourceBytes'
  limit?: number
  actual?: number
}
