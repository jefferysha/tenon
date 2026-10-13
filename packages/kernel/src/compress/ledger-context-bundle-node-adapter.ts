import { createHash } from 'node:crypto'
import { isAbsolute, join, posix } from 'node:path'
import { readStepHandoff, stepOutputsContextFor } from '../documents/step-outputs.js'
import { readDocumentLedger } from '../state/document-ledger.js'
import { nodeHandoffFs, type HandoffFs } from './handoff.js'
import {
  LedgerContextBundleError,
  type CompiledLedgerContextBundle,
  type CompileLedgerContextBundleInput,
  type LedgerContextBundleResourceLimits,
  type LedgerContextBundleSourceReader,
} from './ledger-context-bundle-contract.js'
import {
  compileObservedContextBundleWithPorts,
  type CompiledObservedContextBundle,
} from './observed-context-bundle.js'
import {
  anchorLedgerContextBundleSource,
  sameLedgerContextBundleSourceAnchor,
  type LedgerContextBundleSourceAnchor,
} from './ledger-context-bundle-node-source.js'
import { compileLedgerContextBundleWithPorts } from './ledger-context-bundle.js'

export const nodeLedgerContextBundlePrimitives = {
  isAbsoluteRoot: isAbsolute,
  ledgerPath: (change: string): string => posix.join(
    'openspec',
    'changes',
    change,
    '.pipeline-documents.json',
  ),
  sha256: (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex'),
  utf8ByteLength: (text: string): number => Buffer.byteLength(text, 'utf8'),
}

/** 源文件读取：根下稳定的非 symlink 普通文件，读前读后锚点必须一致（`fs` 注入时是旧的 HandoffFs 测试缝，不做锚点）。 */
function nodeSourceReader(root: string, handoffFs: HandoffFs | undefined): LedgerContextBundleSourceReader {
  const fs = handoffFs ?? nodeHandoffFs()
  const guarded = handoffFs === undefined
  return {
    read: async (path, limit) => {
      const absolute = join(root, path)
      let before: LedgerContextBundleSourceAnchor | undefined
      if (guarded) before = await anchorLedgerContextBundleSource(root, absolute, path)
      if (limit && before && before.size > limit.maxBytes) {
        throw new LedgerContextBundleError(
          'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
          `Context Bundle resource limit exceeded: ${limit.metric}`,
          {
            path,
            metric: limit.metric,
            limit: limit.limit,
            actual: limit.actualOffset + before.size,
            repairAction: '减少已登记输入或拆分过大的治理文档后重试',
          },
        )
      }
      const text = fs.readText(absolute)
      if (text === undefined) throw new Error(`source is missing: ${path}`)
      if (guarded && before !== undefined) {
        const after = await anchorLedgerContextBundleSource(root, absolute, path)
        if (!sameLedgerContextBundleSourceAnchor(before, after)) {
          throw new Error(`source anchor changed: ${path}`)
        }
      }
      return { text, sourceBytes: Buffer.byteLength(text, 'utf8') }
    },
  }
}

/**
 * Trusted-local CLI adapter. The port-based compiler remains storage-agnostic; this adapter owns
 * Node path traversal, document-ledger persistence, and the legacy HandoffFs test seam.
 */
export async function compileLedgerContextBundle(
  input: CompileLedgerContextBundleInput,
): Promise<CompiledLedgerContextBundle> {
  return compileLedgerContextBundleWithPorts({
    root: input.root,
    change: input.change,
    from: input.from,
    target: input.target,
    policy: input.policy,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.resourceLimits === undefined ? {} : { resourceLimits: input.resourceLimits }),
    ledgerRepository: {
      read: async () => readDocumentLedger(join(input.root, 'openspec', 'changes', input.change)),
    },
    sourceReader: nodeSourceReader(input.root, input.fs),
    primitives: nodeLedgerContextBundlePrimitives,
  })
}

export interface CompileObservedContextBundleInput {
  readonly root: string
  readonly change: string
  readonly from: string
  /** 必须是任务当前所在步骤：包里是它的交接输入。 */
  readonly target: string
  readonly budgetBytes?: number
  readonly fs?: HandoffFs
  readonly resourceLimits?: LedgerContextBundleResourceLimits
}

/**
 * 观察模式的本机适配器：交接输入与读取回执来自步骤产出账本（`readStepHandoff`），源文件读取同契约模式。
 * 账本损坏 → CONTEXT_BUNDLE_STATE_CORRUPT，不当作没有输入。
 */
export async function compileObservedContextBundle(
  input: CompileObservedContextBundleInput,
): Promise<CompiledObservedContextBundle> {
  const ctx = stepOutputsContextFor(join(input.root, 'openspec', 'changes', input.change))
  return compileObservedContextBundleWithPorts({
    root: input.root,
    change: input.change,
    from: input.from,
    target: input.target,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.resourceLimits === undefined ? {} : { resourceLimits: input.resourceLimits }),
    repository: {
      read: async () => {
        const handoff = await readStepHandoff(ctx)
        return {
          step: handoff.step,
          sources: handoff.inputs.map((handed) => ({
            path: handed.path,
            fromStep: handed.fromStep,
            skill: handed.skill,
            recordedSha256: handed.sha256,
            readSha256s: handoff.reads.filter((read) => read.path === handed.path).map((read) => read.sha256),
          })),
        }
      },
    },
    sourceReader: nodeSourceReader(input.root, input.fs),
    primitives: nodeLedgerContextBundlePrimitives,
  })
}
