import {
  isDocumentPolicyStep,
  readsRequiredForPolicyStep,
  type DocumentKind,
} from '../workflow/document-contract.js'
import {
  compileContextBundle,
  type ContextBundleMode,
} from './context-bundle.js'
import { compressDocument, renderHandoffSummary } from './compress.js'
import {
  DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES,
  LedgerContextBundleError,
  type CompiledLedgerContextBundle,
  type CompileLedgerContextBundleWithPortsInput,
  type LedgerContextBundleErrorDetails,
  type LedgerContextBundleInputSummary,
  type LedgerContextBundlePreview,
  type LedgerContextBundleReasonCode,
} from './ledger-context-bundle-contract.js'
export * from './ledger-context-bundle-contract.js'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

const DOCUMENT_REASONS: Readonly<Record<DocumentKind, string>> = {
  proposal: '定义目标、范围、非目标与验收信号',
  'openspec-design': '冻结 OpenSpec 设计决策、风险和边界',
  tasks: '提供当前七阶段可执行任务和完成状态',
  'superpower-design': '提供深层架构规则、不变量与方案取舍',
  adr: '提供已接受的长期架构决策',
  'delta-spec': '提供能力级新增、修改和删除需求',
  'superpower-plan': '提供逐文件实施顺序、测试和回滚策略',
  plan: '提供当前 Build 执行计划入口',
  'verification-report': '提供冻结基线上的验证结果和失败分类',
  'applied-spec': '证明 delta spec 已应用到主规格',
  'design-md': '提供项目设计体系',
}

const DOCUMENT_REASON_CODES: Readonly<Record<DocumentKind, LedgerContextBundleReasonCode>> = {
  proposal: 'context-bundle.reason.proposal',
  'openspec-design': 'context-bundle.reason.openspec-design',
  tasks: 'context-bundle.reason.tasks',
  'superpower-design': 'context-bundle.reason.superpower-design',
  adr: 'context-bundle.reason.adr',
  'delta-spec': 'context-bundle.reason.delta-spec',
  'superpower-plan': 'context-bundle.reason.superpower-plan',
  plan: 'context-bundle.reason.plan',
  'verification-report': 'context-bundle.reason.verification-report',
  'applied-spec': 'context-bundle.reason.applied-spec',
  'design-md': 'context-bundle.reason.design-md',
}

function materializationMode(kind: DocumentKind): Exclude<ContextBundleMode, 'reference'> {
  return kind === 'proposal' || kind === 'tasks' || kind === 'delta-spec' ? 'full' : 'summary'
}

function validRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return false
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function invalidRequest(message: string): LedgerContextBundleError {
  return new LedgerContextBundleError(
    'CONTEXT_BUNDLE_INVALID_REQUEST',
    message,
    { repairAction: '使用 registered root、安全 Change 名、canonical target 和正安全整数预算后重试' },
  )
}

function previewOf(
  input: Pick<CompileLedgerContextBundleWithPortsInput, 'change' | 'from' | 'target'>,
  maxBytes: number,
  inputs: readonly LedgerContextBundleInputSummary[],
): LedgerContextBundlePreview {
  const usedBytes = inputs.reduce((total, item) => total + item.materializedBytes, 0)
  return {
    change: input.change,
    from: input.from,
    to: input.target,
    tier: 'strong',
    budget: { maxBytes, usedBytes },
    documentCount: inputs.length,
    inputs,
  }
}

function resourceLimitError(
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

/**
 * Compile the document-policy inputs for one canonical consumer phase.
 *
 * This is the sole ledger → Context Bundle rule source used by CLI and server. It validates every
 * source before budget evaluation, so a low budget can never mask missing or stale evidence.
 */
export async function compileLedgerContextBundleWithPorts(
  input: CompileLedgerContextBundleWithPortsInput,
): Promise<CompiledLedgerContextBundle> {
  const maxBytes = input.budgetBytes ?? DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES
  if (!input.primitives.isAbsoluteRoot(input.root) || !SAFE_ID.test(input.change) || !SAFE_ID.test(input.from)) {
    throw invalidRequest('Context Bundle root/change/from 非法')
  }
  if (!isDocumentPolicyStep(input.policy, input.target)) {
    throw invalidRequest(`Context Bundle target 必须是 workflow step: ${input.target}`)
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw invalidRequest(`Context Bundle budgetBytes 必须是正安全整数: ${maxBytes}`)
  }

  const requiredKinds = readsRequiredForPolicyStep(input.policy, input.target)
  const bundleInputs: Array<{
    kind: DocumentKind
    path: string
    digest: `sha256:${string}`
    reason: string
    mode: ContextBundleMode
    content?: string
  }> = []
  const summaries: LedgerContextBundleInputSummary[] = []

  if (requiredKinds.length > 0) {
    let ledger
    try {
      ledger = await input.ledgerRepository.read()
    } catch (cause) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle document ledger 不可读取',
        {
          path: input.primitives.ledgerPath(input.change),
          repairAction: `运行 tenon document init ${input.change} 并重新登记/读取文档`,
          cause,
        },
      )
    }
    if (ledger === undefined) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_LEDGER_MISSING',
        'Context Bundle missing document ledger; run tenon document init',
        {
          path: input.primitives.ledgerPath(input.change),
          repairAction: `运行 tenon document init ${input.change} 后重试`,
        },
      )
    }

    const limits = input.resourceLimits
    const requiredRecords = ledger.records.filter((record) => requiredKinds.includes(record.kind))
    if (limits && requiredRecords.length > limits.maxRecords) {
      throw resourceLimitError('records', limits.maxRecords, requiredRecords.length)
    }
    let totalSourceBytes = 0
    const materializedPaths = new Set<string>()
    for (const kind of requiredKinds) {
      const records = ledger.records
        .filter((record) => record.kind === kind)
        .sort((left, right) => left.path.localeCompare(right.path, 'en'))
      if (records.length === 0) {
        throw new LedgerContextBundleError(
          'CONTEXT_BUNDLE_DOCUMENT_MISSING',
          `Context Bundle missing document '${kind}'; run tenon document record ${input.change} ${kind} <path> --producer <skill>`,
          {
            kind,
            repairAction: `重新运行 tenon document record ${input.change} ${kind} <path> --producer <skill>，然后 tenon document read ${input.change} all`,
          },
        )
      }
      for (const record of records) {
        if (!validRelativePath(record.path)) {
          throw invalidRequest(`Context Bundle ledger path 非法: ${record.path}`)
        }
        let text: string | undefined
        let sourceBytes: number
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
        try {
          const source = await input.sourceReader.read(record.path, sourceReadLimit)
          text = source.text
          sourceBytes = source.sourceBytes
        } catch (error) {
          if (error instanceof LedgerContextBundleError) {
            if (error.kind !== undefined) throw error
            throw new LedgerContextBundleError(error.code, error.message, {
              cause: error,
              kind,
              path: error.path ?? record.path,
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
            `Context Bundle source reader failed for '${kind}': ${record.path}; ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              cause: error,
              kind,
              path: record.path,
              repairAction: `恢复 root 内稳定的非 symlink 普通文件 ${record.path}，并重新 record/read`,
            },
          )
        }
        if (text === undefined) {
          throw new LedgerContextBundleError(
            'CONTEXT_BUNDLE_DOCUMENT_MISSING',
            `Context Bundle missing document '${kind}': ${record.path}; restore or re-record it`,
            {
              kind,
              path: record.path,
              repairAction: `恢复 ${record.path}，或重新运行 tenon document record ${input.change} ${kind} ${record.path} --producer <skill>`,
            },
          )
        }
        if (limits && sourceBytes > limits.maxSourceBytesPerDocument) {
          throw resourceLimitError(
            'sourceBytesPerDocument',
            limits.maxSourceBytesPerDocument,
            sourceBytes,
            { kind, path: record.path },
          )
        }
        totalSourceBytes += sourceBytes
        if (limits && totalSourceBytes > limits.maxTotalSourceBytes) {
          throw resourceLimitError(
            'totalSourceBytes',
            limits.maxTotalSourceBytes,
            totalSourceBytes,
            { kind, path: record.path },
          )
        }
        const actual = input.primitives.sha256(text)
        if (actual !== record.sha256) {
          throw new LedgerContextBundleError(
            'CONTEXT_BUNDLE_DOCUMENT_STALE',
            `Context Bundle stale document '${kind}': ${record.path}; run tenon document record ${input.change} ${kind} ${record.path} --producer <skill>, then tenon document read ${input.change} all`,
            {
              kind,
              path: record.path,
              repairAction: `重新运行 tenon document record ${input.change} ${kind} ${record.path} --producer <skill>，然后 tenon document read ${input.change} all`,
            },
          )
        }

        const duplicatePath = materializedPaths.has(record.path)
        const mode: ContextBundleMode = duplicatePath ? 'reference' : materializationMode(kind)
        if (!duplicatePath) materializedPaths.add(record.path)
        const content = mode === 'reference'
          ? undefined
          : mode === 'full'
            ? text
            : renderHandoffSummary(compressDocument(text), `${input.change}/${kind}`)
        const digestValue = `sha256:${record.sha256}` as const
        bundleInputs.push({
          kind,
          path: record.path,
          digest: digestValue,
          reason: DOCUMENT_REASONS[kind],
          mode,
          ...(content === undefined ? {} : { content }),
        })
        summaries.push({
          kind,
          path: record.path,
          digest: digestValue,
          reason: DOCUMENT_REASONS[kind],
          reasonCode: DOCUMENT_REASON_CODES[kind],
          mode,
          sourceBytes,
          materializedBytes: content === undefined ? 0 : input.primitives.utf8ByteLength(content),
        })
      }
    }
  }

  const preview = previewOf(input, maxBytes, summaries)
  if (preview.budget.usedBytes > maxBytes) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      `Context Bundle 超预算: required=${preview.budget.usedBytes} bytes, available=${maxBytes} bytes`,
      {
        requiredBytes: preview.budget.usedBytes,
        availableBytes: maxBytes,
        preview,
        repairAction: `把 budgetBytes 调整到至少 ${preview.budget.usedBytes} 后重试`,
      },
    )
  }

  const bundle = compileContextBundle({
    change: input.change,
    from: input.from,
    to: input.target,
    tier: 'strong',
    maxBytes,
    inputs: bundleInputs,
  })
  return { bundle, preview }
}
