import type { DocumentLedger } from '../state/document-ledger.js'
import type { DocumentGovernancePolicy, DocumentKind } from '../workflow/document-contract.js'
import type {
  ContextBundleMode,
  ContextBundleTier,
  ContextBundleV1,
} from './context-bundle.js'
import type { HandoffFs } from './handoff.js'

export const DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES = 120_000
export const DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS = {
  maxRecords: 64,
  maxSourceBytesPerDocument: 262_144,
  maxTotalSourceBytes: 1_048_576,
} as const

export type LedgerContextBundleErrorCode =
  | 'CONTEXT_BUNDLE_INVALID_REQUEST'
  | 'CONTEXT_BUNDLE_STATE_CORRUPT'
  | 'CONTEXT_BUNDLE_LEDGER_MISSING'
  | 'CONTEXT_BUNDLE_DOCUMENT_MISSING'
  | 'CONTEXT_BUNDLE_DOCUMENT_STALE'
  | 'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED'
  | 'CONTEXT_BUNDLE_BUDGET_EXCEEDED'

export type LedgerContextBundleReasonCode =
  | 'context-bundle.reason.proposal'
  | 'context-bundle.reason.openspec-design'
  | 'context-bundle.reason.tasks'
  | 'context-bundle.reason.superpower-design'
  | 'context-bundle.reason.adr'
  | 'context-bundle.reason.delta-spec'
  | 'context-bundle.reason.superpower-plan'
  | 'context-bundle.reason.plan'
  | 'context-bundle.reason.verification-report'
  | 'context-bundle.reason.applied-spec'
  | 'context-bundle.reason.design-md'

export interface LedgerContextBundleInputSummary {
  readonly kind: DocumentKind
  readonly path: string
  readonly digest: `sha256:${string}`
  readonly reason: string
  readonly reasonCode: LedgerContextBundleReasonCode
  readonly mode: ContextBundleMode
  readonly sourceBytes: number
  readonly materializedBytes: number
}

export interface LedgerContextBundlePreview {
  readonly change: string
  readonly from: string
  readonly to: string
  readonly tier: ContextBundleTier
  readonly budget: {
    readonly maxBytes: number
    readonly usedBytes: number
  }
  readonly documentCount: number
  readonly inputs: readonly LedgerContextBundleInputSummary[]
}

export interface CompiledLedgerContextBundle {
  readonly bundle: ContextBundleV1
  readonly preview: LedgerContextBundlePreview
}

export interface CompileLedgerContextBundleInput {
  readonly root: string
  readonly change: string
  readonly from: string
  readonly target: string
  /** The change's document policy; target must be one of its steps. */
  readonly policy: DocumentGovernancePolicy
  readonly budgetBytes?: number
  readonly fs?: HandoffFs
  readonly resourceLimits?: LedgerContextBundleResourceLimits
}

export interface LedgerContextBundleLedgerRepository {
  read(): Promise<DocumentLedger | undefined>
}

export interface CompileLedgerContextBundleWithPortsInput {
  readonly root: string
  readonly change: string
  readonly from: string
  readonly target: string
  readonly policy: DocumentGovernancePolicy
  readonly budgetBytes?: number
  readonly ledgerRepository: LedgerContextBundleLedgerRepository
  readonly sourceReader: LedgerContextBundleSourceReader
  readonly primitives: LedgerContextBundlePrimitives
  readonly resourceLimits?: LedgerContextBundleResourceLimits
}

export interface LedgerContextBundlePrimitives {
  isAbsoluteRoot(root: string): boolean
  ledgerPath(change: string): string
  sha256(text: string): string
  utf8ByteLength(text: string): number
}

export interface LedgerContextBundleSource {
  readonly text: string
  readonly sourceBytes: number
}

export interface LedgerContextBundleSourceReader {
  read(
    path: string,
    limit?: LedgerContextBundleSourceReadLimit,
  ): Promise<LedgerContextBundleSource>
}

export interface LedgerContextBundleSourceReadLimit {
  readonly maxBytes: number
  readonly metric: 'sourceBytesPerDocument' | 'totalSourceBytes'
  readonly limit: number
  readonly actualOffset: number
}

export interface LedgerContextBundleResourceLimits {
  readonly maxRecords: number
  readonly maxSourceBytesPerDocument: number
  readonly maxTotalSourceBytes: number
}

export interface LedgerContextBundleErrorDetails {
  readonly repairAction: string
  readonly cause?: unknown
  readonly kind?: DocumentKind
  readonly path?: string
  readonly requiredBytes?: number
  readonly availableBytes?: number
  readonly preview?: LedgerContextBundlePreview
  readonly metric?: 'records' | 'sourceBytesPerDocument' | 'totalSourceBytes'
  readonly limit?: number
  readonly actual?: number
}

export class LedgerContextBundleError extends Error {
  override readonly cause?: unknown
  readonly code: LedgerContextBundleErrorCode
  readonly repairAction: string
  readonly kind?: DocumentKind
  readonly path?: string
  readonly requiredBytes?: number
  readonly availableBytes?: number
  readonly preview?: LedgerContextBundlePreview
  readonly metric?: 'records' | 'sourceBytesPerDocument' | 'totalSourceBytes'
  readonly limit?: number
  readonly actual?: number

  constructor(
    code: LedgerContextBundleErrorCode,
    message: string,
    details: LedgerContextBundleErrorDetails,
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'LedgerContextBundleError'
    this.code = code
    this.repairAction = details.repairAction
    if (details.cause !== undefined) this.cause = details.cause
    if (details.kind !== undefined) this.kind = details.kind
    if (details.path !== undefined) this.path = details.path
    if (details.requiredBytes !== undefined) this.requiredBytes = details.requiredBytes
    if (details.availableBytes !== undefined) this.availableBytes = details.availableBytes
    if (details.preview !== undefined) this.preview = details.preview
    if (details.metric !== undefined) this.metric = details.metric
    if (details.limit !== undefined) this.limit = details.limit
    if (details.actual !== undefined) this.actual = details.actual
  }
}
