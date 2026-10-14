/**
 * Context Bundle 读取一份源文件并核对资源上限：契约模式（按台账记录）与观察模式（按交接输入）共用。
 *
 * 读取器自己的失败、读回空、单文件超限、总量超限都映射成稳定的 LedgerContextBundleError；
 * 两种模式只在点名对象与修复办法的措辞上不同，由调用方经 BundleSourceIdentity 给出。
 */
import type { DocumentKind } from '../workflow/document-contract.js'
import {
  LedgerContextBundleError,
  type LedgerContextBundleErrorDetails,
  type LedgerContextBundleResourceLimits,
  type LedgerContextBundleSource,
  type LedgerContextBundleSourceReader,
} from './ledger-context-bundle-contract.js'

/** 出错时怎么称呼这份文档、怎么修。 */
export interface BundleSourceIdentity {
  /** 消息里点名的对象，如 `'proposal'`。 */
  readonly subject: string
  readonly kind?: DocumentKind
  /** 读取器自己失败（文件被换、不是普通文件、锚点变化）的修复办法。 */
  readonly unreadableRepair: (path: string) => string
  /** 读回空（文件不存在）：消息收尾与修复办法。 */
  readonly missingHint: string
  readonly missingRepair: (path: string) => string
}

export function resourceLimitError(
  metric: NonNullable<LedgerContextBundleErrorDetails['metric']>,
  limit: number,
  actual: number,
  details: Pick<LedgerContextBundleErrorDetails, 'kind' | 'path'> = {},
): LedgerContextBundleError {
  return new LedgerContextBundleError(
    'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    `Context Bundle resource limit exceeded: ${metric}=${actual}, limit=${limit}`,
    {
      ...details,
      metric,
      limit,
      actual,
      repairAction: '减少已登记输入或拆分过大的治理文档后重试',
    },
  )
}

/** 读一份源文件；`totalSourceBytes` 是此前已读的总字节数（用来算还剩多少总量额度）。 */
export async function readBundleSource(
  input: {
    readonly sourceReader: LedgerContextBundleSourceReader
    readonly resourceLimits?: LedgerContextBundleResourceLimits
  },
  path: string,
  totalSourceBytes: number,
  identity: BundleSourceIdentity,
): Promise<LedgerContextBundleSource> {
  const limits = input.resourceLimits
  const kindDetail = identity.kind === undefined ? {} : { kind: identity.kind }
  const remainingTotalBytes = limits
    ? Math.max(0, limits.maxTotalSourceBytes - totalSourceBytes)
    : undefined
  const sourceReadLimit = limits && remainingTotalBytes !== undefined
    ? {
        maxBytes: Math.min(limits.maxSourceBytesPerDocument, remainingTotalBytes),
        metric: remainingTotalBytes < limits.maxSourceBytesPerDocument
          ? 'totalSourceBytes' as const
          : 'sourceBytesPerDocument' as const,
        limit: remainingTotalBytes < limits.maxSourceBytesPerDocument
          ? limits.maxTotalSourceBytes
          : limits.maxSourceBytesPerDocument,
        actualOffset: remainingTotalBytes < limits.maxSourceBytesPerDocument
          ? totalSourceBytes
          : 0,
      }
    : undefined
  let source: LedgerContextBundleSource
  try {
    source = await input.sourceReader.read(path, sourceReadLimit)
  } catch (error) {
    if (error instanceof LedgerContextBundleError) {
      if (error.kind !== undefined) throw error
      throw new LedgerContextBundleError(error.code, error.message, {
        cause: error,
        ...kindDetail,
        path: error.path ?? path,
        repairAction: error.repairAction,
        ...(error.requiredBytes === undefined ? {} : { requiredBytes: error.requiredBytes }),
        ...(error.availableBytes === undefined ? {} : { availableBytes: error.availableBytes }),
        ...(error.preview === undefined ? {} : { preview: error.preview }),
        ...(error.metric === undefined ? {} : { metric: error.metric }),
        ...(error.limit === undefined ? {} : { limit: error.limit }),
        ...(error.actual === undefined ? {} : { actual: error.actual }),
      })
    }
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
      `Context Bundle source reader failed for ${identity.subject}: ${path}; ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error, ...kindDetail, path, repairAction: identity.unreadableRepair(path) },
    )
  }
  if (source.text === undefined) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
      `Context Bundle missing document ${identity.subject}: ${path}; ${identity.missingHint}`,
      { ...kindDetail, path, repairAction: identity.missingRepair(path) },
    )
  }
  if (limits && source.sourceBytes > limits.maxSourceBytesPerDocument) {
    throw resourceLimitError('sourceBytesPerDocument', limits.maxSourceBytesPerDocument, source.sourceBytes, { ...kindDetail, path })
  }
  if (limits && totalSourceBytes + source.sourceBytes > limits.maxTotalSourceBytes) {
    throw resourceLimitError('totalSourceBytes', limits.maxTotalSourceBytes, totalSourceBytes + source.sourceBytes, { ...kindDetail, path })
  }
  return source
}
