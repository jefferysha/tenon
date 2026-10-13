/**
 * 观察模式（冻结计划没有旧文档契约）的 Context Bundle：包的输入就是当前步骤访问的交接输入——转入当前步骤的
 * 那次访问产出的文档，按路径排序，原因点名上游步骤。契约模式按台账记录编译，见 ledger-context-bundle.ts。
 *
 * 每份输入的摘要必须与源文件字节对得上：等于上游记下的输出摘要，或等于本访问写过的读取回执摘要
 * （本步改过输入又重读过）。否则失败关闭并要求重读，而不是悄悄把未确认的内容交给下一个 agent。
 * 观察模式没有文档种类，所有输入按摘要物化；需要全文的步骤本来就必须读完这些输入（read-documents）。
 */
import { compileContextBundle, type ContextBundleV1 } from './context-bundle.js'
import { compressDocument, renderHandoffSummary } from './compress.js'
import {
  DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES,
  LedgerContextBundleError,
  type LedgerContextBundlePrimitives,
  type LedgerContextBundleResourceLimits,
  type LedgerContextBundleSourceReader,
} from './ledger-context-bundle-contract.js'
import { invalidRequest, SAFE_ID, validRelativePath } from './ledger-context-bundle.js'
import { readBundleSource, resourceLimitError } from './ledger-context-bundle-source.js'

/** 一份交接输入加上核对它所需的事实。 */
export interface ObservedBundleSource {
  readonly path: string
  readonly fromStep: string
  readonly skill: string | null
  /** 上游那次访问记下的输出摘要（sha256 十六进制）。 */
  readonly recordedSha256: string
  /** 本访问对这个文件写过的读取回执摘要。 */
  readonly readSha256s: readonly string[]
}

export interface ObservedBundleRepository {
  /** `step` 是当前步骤（任务缺 run 状态时为 null，此时没有输入）。 */
  read(): Promise<{ readonly step: string | null; readonly sources: readonly ObservedBundleSource[] }>
}

export interface ObservedContextBundleInputSummary {
  readonly path: string
  readonly fromStep: string
  readonly skill: string | null
  readonly digest: `sha256:${string}`
  readonly reason: string
  readonly mode: 'summary'
  readonly sourceBytes: number
  readonly materializedBytes: number
}

export interface ObservedContextBundlePreview {
  readonly change: string
  readonly from: string
  readonly to: string
  readonly tier: 'strong'
  readonly budget: { readonly maxBytes: number; readonly usedBytes: number }
  readonly documentCount: number
  readonly inputs: readonly ObservedContextBundleInputSummary[]
}

export interface CompiledObservedContextBundle {
  readonly bundle: ContextBundleV1
  readonly preview: ObservedContextBundlePreview
}

export interface CompileObservedContextBundleWithPortsInput {
  readonly root: string
  readonly change: string
  readonly from: string
  /** 必须是当前步骤：包里是它的交接输入。 */
  readonly target: string
  readonly budgetBytes?: number
  readonly repository: ObservedBundleRepository
  readonly sourceReader: LedgerContextBundleSourceReader
  readonly primitives: LedgerContextBundlePrimitives
  readonly resourceLimits?: LedgerContextBundleResourceLimits
}

const HANDOFF_KIND = 'handoff'

export async function compileObservedContextBundleWithPorts(
  input: CompileObservedContextBundleWithPortsInput,
): Promise<CompiledObservedContextBundle> {
  const maxBytes = input.budgetBytes ?? DEFAULT_LEDGER_CONTEXT_BUNDLE_BUDGET_BYTES
  if (
    !input.primitives.isAbsoluteRoot(input.root)
    || !SAFE_ID.test(input.change) || !SAFE_ID.test(input.from) || !SAFE_ID.test(input.target)
  ) {
    throw invalidRequest('Context Bundle root/change/from/target 非法')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw invalidRequest(`Context Bundle budgetBytes 必须是正安全整数: ${maxBytes}`)
  }
  let handoff: Awaited<ReturnType<ObservedBundleRepository['read']>>
  try {
    handoff = await input.repository.read()
  } catch (cause) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_STATE_CORRUPT',
      'Context Bundle 步骤产出账本不可读取',
      { cause, repairAction: `修复 openspec/changes/${input.change}/.pipeline-step-outputs.json 后重试` },
    )
  }
  if (handoff.step !== null && handoff.step !== input.target) {
    throw invalidRequest(`观察模式的 Context Bundle 只能为当前步骤 ${handoff.step} 编译（输入是它的交接输入），target=${input.target}`)
  }
  const limits = input.resourceLimits
  if (limits && handoff.sources.length > limits.maxRecords) {
    throw resourceLimitError('records', limits.maxRecords, handoff.sources.length)
  }
  const readAll = `tenon document read ${input.change} all`
  const bundleInputs: Array<{
    kind: string; path: string; digest: `sha256:${string}`; reason: string; mode: 'summary'; content: string
  }> = []
  const summaries: ObservedContextBundleInputSummary[] = []
  let totalSourceBytes = 0
  for (const source of [...handoff.sources].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    if (!validRelativePath(source.path)) throw invalidRequest(`Context Bundle 输入 path 非法: ${source.path}`)
    const { text, sourceBytes } = await readBundleSource(input, source.path, totalSourceBytes, {
      subject: `'${HANDOFF_KIND}'`,
      unreadableRepair: (path) => `恢复 root 内稳定的非 symlink 普通文件 ${path}，并重新 ${readAll}`,
      missingHint: 'restore it or let the upstream step produce it again',
      missingRepair: (path) => `恢复 ${path}（或让 ${source.fromStep} 重新产出），然后 ${readAll}`,
    })
    totalSourceBytes += sourceBytes
    const actual = input.primitives.sha256(text)
    if (actual !== source.recordedSha256 && !source.readSha256s.includes(actual)) {
      throw new LedgerContextBundleError(
        'CONTEXT_BUNDLE_DOCUMENT_STALE',
        `Context Bundle stale input '${source.path}'（${source.fromStep} 的产出）已被改动且没有重读；run ${readAll}`,
        { path: source.path, repairAction: `重新运行 ${readAll}` },
      )
    }
    const content = renderHandoffSummary(compressDocument(text), `${input.change}/${source.path}`)
    const digest = `sha256:${actual}` as const
    const reason = `${source.fromStep} 的产出`
    bundleInputs.push({ kind: HANDOFF_KIND, path: source.path, digest, reason, mode: 'summary', content })
    summaries.push({
      path: source.path,
      fromStep: source.fromStep,
      skill: source.skill,
      digest,
      reason,
      mode: 'summary',
      sourceBytes,
      materializedBytes: input.primitives.utf8ByteLength(content),
    })
  }
  const usedBytes = summaries.reduce((total, item) => total + item.materializedBytes, 0)
  if (usedBytes > maxBytes) {
    throw new LedgerContextBundleError(
      'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
      `Context Bundle 超预算: required=${usedBytes} bytes, available=${maxBytes} bytes`,
      { requiredBytes: usedBytes, availableBytes: maxBytes, repairAction: `把 budgetBytes 调整到至少 ${usedBytes} 后重试` },
    )
  }
  const bundle = compileContextBundle({
    change: input.change, from: input.from, to: input.target, tier: 'strong', maxBytes, inputs: bundleInputs,
  })
  return {
    bundle,
    preview: {
      change: input.change,
      from: input.from,
      to: input.target,
      tier: 'strong',
      budget: { maxBytes, usedBytes },
      documentCount: summaries.length,
      inputs: summaries,
    },
  }
}
