/**
 * 观察模式（冻结计划没有旧文档契约）的转换接入：离开步骤前拦下没读完的交接输入，提交前记下本次访问的产出。
 *
 * 两处都在转换持有的 Change 锁内：读完才能离开（除放弃边），产出在所有门禁通过之后、提交之前写入，
 * 按访问身份幂等——提交失败后重试只会重写同一条记录。账本或 run 状态损坏时失败关闭（不提交），
 * git / 观察问题已在 `recordStepExit` 内部降级为 unavailable，不会拦转换。
 */
import { stepOutputsContextFor, recordStepExit } from '../documents/step-outputs.js'
import { stepOutputLedgerBlocker, unreadInputBlockers } from '../documents/step-input-gate.js'
import { StepOutputLedgerError } from '../state/step-output-ledger.js'
import { isAbandonEvent } from './implicit-completion.js'
import type { TransitionRejection } from './transition-application-types.js'

/** 前进、完成、回退边都要求全部读完；放弃边（终止任务）不要求。 */
export async function rejectOnUnreadInputs(input: {
  readonly changeDir: string
  readonly from: string
  readonly event: string
}): Promise<TransitionRejection | undefined> {
  if (isAbandonEvent(input.event)) return undefined
  const blockers = await unreadInputBlockers(input.changeDir)
  if (blockers.length === 0) return undefined
  // 账本损坏时 unreadInputBlockers 失败关闭成一条账本阻断：来源按它标，别把「账本坏了」说成「输入没读完」。
  const ledgerBroken = blockers.some((blocker) => blocker.code === 'step-output-ledger-invalid')
  return {
    kind: 'document-evidence-failed',
    phase: input.from,
    blockers: blockers.map((blocker) => blocker.message),
    source: ledgerBroken ? 'step-output-ledger' : 'unread-inputs',
  }
}

/** 为这次离开写离开记录并开始下一次访问；账本损坏 → 失败关闭，其余 I/O 失败照常抛出让事务中止。 */
export async function recordObservedStepExit(input: {
  readonly changeDir: string
  readonly runId: string
  readonly sequence: number
  readonly from: string
  readonly to: string
  readonly event: string
  readonly at: string
}): Promise<TransitionRejection | undefined> {
  const ctx = stepOutputsContextFor(input.changeDir)
  try {
    await recordStepExit(ctx, {
      runId: input.runId, sequence: input.sequence, step: input.from, event: input.event, to: input.to, at: input.at,
    })
    return undefined
  } catch (error) {
    if (error instanceof StepOutputLedgerError) {
      return {
        kind: 'document-evidence-failed',
        phase: input.from,
        blockers: [stepOutputLedgerBlocker(ctx.change, error).message],
        source: 'step-output-ledger',
      }
    }
    throw error
  }
}
