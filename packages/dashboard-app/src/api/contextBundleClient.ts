import {
  CONTEXT_BUNDLE_DOCUMENT_KINDS,
  CONTEXT_BUNDLE_HANDOFF_KIND,
  CONTEXT_BUNDLE_HANDOFF_REASON_CODE,
  CONTEXT_BUNDLE_PHASES,
  CONTEXT_BUNDLE_REASON_CODES,
  type ContextBundleDocumentKind,
  type ContextBundleReasonCode,
  type ContextBundleMode,
  type ContextBundleErrorDetail,
  type ContextBundlePhase,
  type ContextBundlePreviewFailure,
  type ContextBundlePreviewInput,
  type ContextBundlePreviewRequest,
  type ContextBundlePreviewSuccess,
  type ContextBundleTier,
} from './contextBundleTypes'
import { isRecord } from './transport'

const PHASES = new Set<string>(CONTEXT_BUNDLE_PHASES)
const DOCUMENT_KINDS = new Set<string>(CONTEXT_BUNDLE_DOCUMENT_KINDS)
const REASON_CODES = new Set<string>(CONTEXT_BUNDLE_REASON_CODES)

export class ContextBundlePreviewApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly repairAction?: string,
    public readonly preview?: ContextBundlePreviewFailure,
    public readonly detail?: ContextBundleErrorDetail,
  ) {
    super(message)
    this.name = 'ContextBundlePreviewApiError'
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const DIGEST = /^sha256:[a-f0-9]{64}$/

function isPhase(value: unknown): value is ContextBundlePhase {
  return typeof value === 'string' && PHASES.has(value)
}

function isReasonCode(value: unknown): value is ContextBundleReasonCode {
  return typeof value === 'string' && REASON_CODES.has(value)
}

function decodeMode(value: unknown): ContextBundleMode | null {
  if (value === 'full' || value === 'summary' || value === 'reference') return value
  return null
}

function decodeTier(value: unknown): ContextBundleTier | null {
  if (value === 'light' || value === 'strong') return value
  return null
}

function decodeDocumentKind(value: unknown): ContextBundleDocumentKind | null {
  return typeof value === 'string' && DOCUMENT_KINDS.has(value)
    ? value as ContextBundleDocumentKind
    : null
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) {
    return false
  }
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function decodeInput(value: unknown): ContextBundlePreviewInput | null {
  if (!isRecord(value)) return null
  const mode = decodeMode(value.mode)
  const handoff = value.kind === CONTEXT_BUNDLE_HANDOFF_KIND
  const kind = handoff ? null : decodeDocumentKind(value.kind)
  if (
    (!handoff && kind === null)
    || !isSafeRelativePath(value.path)
    || typeof value.digest !== 'string'
    || !DIGEST.test(value.digest)
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || value.reason.length > 256
    || typeof value.reasonCode !== 'string'
    || mode === null
    || !isNonNegativeSafeInteger(value.sourceBytes)
    || !isNonNegativeSafeInteger(value.materializedBytes)
    || 'content' in value
  ) return null
  const base = {
    path: value.path,
    digest: value.digest,
    reason: value.reason,
    mode,
    sourceBytes: value.sourceBytes,
    materializedBytes: value.materializedBytes,
  }
  if (handoff) {
    // 交接输入：原因码只有一种，必须带来源步骤与来源技能（字符串或 null）。
    if (
      value.reasonCode !== CONTEXT_BUNDLE_HANDOFF_REASON_CODE
      || typeof value.fromStep !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(value.fromStep)
      || (value.skill !== null && typeof value.skill !== 'string')
    ) return null
    return { ...base, kind: CONTEXT_BUNDLE_HANDOFF_KIND, reasonCode: CONTEXT_BUNDLE_HANDOFF_REASON_CODE, fromStep: value.fromStep, skill: value.skill }
  }
  if (kind === null || !isReasonCode(value.reasonCode) || 'fromStep' in value || 'skill' in value) return null
  return { ...base, kind, reasonCode: value.reasonCode }
}

function decodePreviewBase(value: unknown): {
  schemaVersion: 'context-bundle-preview/v1'
  sideEffects: 'none'
  change: string
  from: string
  to: ContextBundlePhase
  tier: ContextBundleTier
  documentCount: number
  inputs: ContextBundlePreviewInput[]
  budget: { maxBytes: number; usedBytes: number; fits: boolean }
} | null {
  if (!isRecord(value)) return null
  const tier = decodeTier(value.tier)
  if (
    value.schemaVersion !== 'context-bundle-preview/v1'
    || value.sideEffects !== 'none'
    || typeof value.change !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(value.change)
    || typeof value.from !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(value.from)
    || !isPhase(value.to)
    || tier === null
    || !isNonNegativeSafeInteger(value.documentCount)
    || !Array.isArray(value.inputs)
    || !isRecord(value.budget)
    || !isNonNegativeSafeInteger(value.budget.maxBytes)
    || value.budget.maxBytes <= 0
    || !isNonNegativeSafeInteger(value.budget.usedBytes)
    || typeof value.budget.fits !== 'boolean'
  ) return null
  const inputs: ContextBundlePreviewInput[] = []
  for (const candidate of value.inputs) {
    const input = decodeInput(candidate)
    if (!input) return null
    inputs.push(input)
  }
  if (value.documentCount !== inputs.length) return null
  if (
    value.budget.fits !== (value.budget.usedBytes <= value.budget.maxBytes)
    || inputs.reduce((sum, input) => sum + input.materializedBytes, 0) !== value.budget.usedBytes
    || 'content' in value
  ) return null
  return {
    schemaVersion: value.schemaVersion,
    sideEffects: value.sideEffects,
    change: value.change,
    from: value.from,
    to: value.to,
    tier,
    documentCount: value.documentCount,
    inputs,
    budget: {
      maxBytes: value.budget.maxBytes,
      usedBytes: value.budget.usedBytes,
      fits: value.budget.fits,
    },
  }
}

function decodeSuccess(value: unknown): ContextBundlePreviewSuccess | null {
  if (!isRecord(value) || value.ok !== true || 'content' in value) return null
  const preview = decodePreviewBase(value.preview)
  if (
    !preview
    || preview.budget.fits !== true
    || !isRecord(value.preview)
    || typeof value.preview.aggregateDigest !== 'string'
    || !DIGEST.test(value.preview.aggregateDigest)
  ) return null
  return {
    ...preview,
    budget: { ...preview.budget, fits: true },
    aggregateDigest: value.preview.aggregateDigest,
  }
}

function decodeDetail(value: unknown): ContextBundleErrorDetail | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const detail: ContextBundleErrorDetail = {}
  if (value.kind !== undefined) {
    const kind = decodeDocumentKind(value.kind)
    if (kind === null) return undefined
    detail.kind = kind
  }
  if (value.path !== undefined) {
    if (!isSafeRelativePath(value.path)) return undefined
    detail.path = value.path
  }
  for (const key of ['requiredBytes', 'availableBytes', 'limit', 'actual'] as const) {
    if (value[key] !== undefined) {
      if (!isNonNegativeSafeInteger(value[key])) return undefined
      detail[key] = value[key]
    }
  }
  if (value.metric !== undefined) {
    if (
      value.metric !== 'records'
      && value.metric !== 'sourceBytesPerDocument'
      && value.metric !== 'totalSourceBytes'
    ) return undefined
    detail.metric = value.metric
  }
  return detail
}

function decodeFailurePreview(value: unknown): ContextBundlePreviewFailure | undefined {
  const preview = decodePreviewBase(value)
  if (!preview || preview.budget.fits !== false || (isRecord(value) && 'aggregateDigest' in value)) {
    return undefined
  }
  return { ...preview, budget: { ...preview.budget, fits: false } }
}

function decodeApiFailure(
  value: unknown,
  status: number,
): ContextBundlePreviewApiError | null {
  if (
    !isRecord(value)
    || value.ok !== false
    || typeof value.code !== 'string'
    || typeof value.error !== 'string'
    || (value.repairAction !== undefined && typeof value.repairAction !== 'string')
    || 'content' in value
  ) return null
  const preview = value.preview === undefined ? undefined : decodeFailurePreview(value.preview)
  if (value.preview !== undefined && preview === undefined) return null
  const detail = decodeDetail(value.detail)
  if (value.detail !== undefined && detail === undefined) return null
  const expected = {
    CONTEXT_BUNDLE_INVALID_REQUEST: { status: 400, preview: false },
    CONTEXT_BUNDLE_STATE_CORRUPT: { status: 409, preview: false },
    CONTEXT_BUNDLE_LEDGER_MISSING: { status: 409, preview: false },
    CONTEXT_BUNDLE_DOCUMENT_MISSING: { status: 409, preview: false },
    CONTEXT_BUNDLE_DOCUMENT_STALE: { status: 409, preview: false },
    CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED: { status: 413, preview: false },
    CONTEXT_BUNDLE_BUDGET_EXCEEDED: { status: 422, preview: true },
    CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE: { status: 501, preview: false },
  } as const
  const contract = expected[value.code as keyof typeof expected]
  if (
    contract === undefined
    || status !== contract.status
    || (preview !== undefined) !== contract.preview
  ) return null
  return new ContextBundlePreviewApiError(
    value.error,
    value.code,
    status,
    value.repairAction,
    preview,
    detail,
  )
}

export async function fetchContextBundlePreview(
  request: ContextBundlePreviewRequest,
): Promise<ContextBundlePreviewSuccess> {
  const params = new URLSearchParams({
    root: request.root,
    change: request.change,
    target: request.target,
    budgetBytes: String(request.budgetBytes),
  })
  let response: Response
  try {
    response = await fetch(`/api/context-bundle/preview?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: request.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ContextBundlePreviewApiError(
      error instanceof Error ? error.message : String(error),
      'CONTEXT_BUNDLE_NETWORK_ERROR',
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ContextBundlePreviewApiError(
      'Context Bundle 预览响应不是有效 JSON',
      'CONTEXT_BUNDLE_INVALID_RESPONSE',
      response.status,
    )
  }
  if (response.ok) {
    const preview = decodeSuccess(body)
    if (
      preview
      && preview.change === request.change
      && preview.to === request.target
      && preview.budget.maxBytes === request.budgetBytes
    ) return preview
    throw new ContextBundlePreviewApiError(
      'Context Bundle 预览响应形状无效',
      'CONTEXT_BUNDLE_INVALID_RESPONSE',
      response.status,
    )
  }
  const failure = decodeApiFailure(body, response.status)
  if (failure) {
    if (
      failure.preview !== undefined
      && (
        failure.preview.change !== request.change
        || failure.preview.to !== request.target
        || failure.preview.budget.maxBytes !== request.budgetBytes
      )
    ) {
      throw new ContextBundlePreviewApiError(
        'Context Bundle 预览错误响应与请求不匹配',
        'CONTEXT_BUNDLE_INVALID_RESPONSE',
        response.status,
      )
    }
    throw failure
  }
  if (
    isRecord(body)
    && body.ok === false
    && typeof body.error === 'string'
    && body.code === undefined
  ) {
    throw new ContextBundlePreviewApiError(
      body.error,
      'CONTEXT_BUNDLE_REQUEST_FAILED',
      response.status,
    )
  }
  throw new ContextBundlePreviewApiError(
    'Context Bundle 预览错误响应形状无效',
    'CONTEXT_BUNDLE_INVALID_RESPONSE',
    response.status,
  )
}
