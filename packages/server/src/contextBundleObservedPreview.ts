/**
 * Context Bundle 预览的观察模式分支（新任务，冻结计划没有文档契约）：包的输入是当前步骤的交接输入，读自步骤产出账本
 * （`readStepHandoff`，与 CLI `tenon handoff --bundle` 同源）；源文件仍经 trusted reader 读，不放宽路径信任。
 * 契约模式（升级前的任务）按文档账本记录编译，见 contextBundlePreview.ts。
 */
import { join } from 'node:path'
import {
  compileObservedContextBundleWithPorts,
  DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  nodeLedgerContextBundlePrimitives,
  readStepHandoff,
  type ObservedBundleRepository,
  type StepOutputsContext,
} from '@tenon/kernel'
import { safeObservedContextBundlePreview } from './contextBundlePreviewSupport.js'
import { trustedContextBundleSourceReader, type TrustedChangeIdentity } from './contextBundleTrustedReader.js'
import type { WorkflowRootAnchor } from './workflows.js'

/** 交接输入加上本次访问写过的读取回执，按路径对齐成编译器要的核对事实（摘要不折叠成已读布尔）。 */
export function observedBundleRepository(ctx: StepOutputsContext): ObservedBundleRepository {
  return {
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
  }
}

export async function compileObservedPreview(input: {
  readonly anchor: WorkflowRootAnchor
  readonly change: string
  readonly from: string
  readonly target: string
  readonly budgetBytes: number
  readonly changeIdentity: TrustedChangeIdentity
}): Promise<Record<string, unknown>> {
  const { anchor, change } = input
  const result = await compileObservedContextBundleWithPorts({
    root: anchor.path,
    change,
    from: input.from,
    target: input.target,
    budgetBytes: input.budgetBytes,
    repository: observedBundleRepository({ root: anchor.path, changeDir: join(anchor.path, 'openspec', 'changes', change), change }),
    sourceReader: trustedContextBundleSourceReader(anchor, input.changeIdentity, DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS),
    primitives: nodeLedgerContextBundlePrimitives,
    resourceLimits: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  })
  return safeObservedContextBundlePreview(result.preview, true, result.bundle.aggregateDigest)
}
