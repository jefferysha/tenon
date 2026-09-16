import { createHash } from 'node:crypto'
import { isAbsolute, join, posix } from 'node:path'
import { readDocumentLedger } from '../state/document-ledger.js'
import { nodeHandoffFs } from './handoff.js'
import {
  LedgerContextBundleError,
  type CompiledLedgerContextBundle,
  type CompileLedgerContextBundleInput,
} from './ledger-context-bundle-contract.js'
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

/**
 * Trusted-local CLI adapter. The port-based compiler remains storage-agnostic; this adapter owns
 * Node path traversal, document-ledger persistence, and the legacy HandoffFs test seam.
 */
export async function compileLedgerContextBundle(
  input: CompileLedgerContextBundleInput,
): Promise<CompiledLedgerContextBundle> {
  const fs = input.fs ?? nodeHandoffFs()
  const guarded = input.fs === undefined
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
    sourceReader: {
      read: async (path, limit) => {
        const absolute = join(input.root, path)
        let before: LedgerContextBundleSourceAnchor | undefined
        if (guarded) before = await anchorLedgerContextBundleSource(input.root, absolute, path)
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
          const after = await anchorLedgerContextBundleSource(input.root, absolute, path)
          if (!sameLedgerContextBundleSourceAnchor(before, after)) {
            throw new Error(`source anchor changed: ${path}`)
          }
        }
        return { text, sourceBytes: Buffer.byteLength(text, 'utf8') }
      },
    },
    primitives: nodeLedgerContextBundlePrimitives,
  })
}
