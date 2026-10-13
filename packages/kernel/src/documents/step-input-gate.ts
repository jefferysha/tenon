/**
 * 观察模式的「没读完不能离开」阻断（设计 §5）：转换、`tenon status` / `tenon check` 与 Dashboard 的出口报告
 * 共用这一份判定和文案，三处口径不会分叉。
 *
 * 只读：不加锁、不写账本。账本或 run 状态损坏时失败关闭成一条阻断（点名文件与修复办法），
 * 而不是抛给调用方——否则 status 会崩、转换会返回与账本无关的错误。
 */
import { STEP_OUTPUT_LEDGER_FILE, StepOutputLedgerError } from '../state/step-output-ledger.js'
import { readStepOutputs, stepOutputsContextFor, unreadInputs } from './step-outputs.js'

export type StepInputBlockerCode = 'input-unread' | 'step-output-ledger-invalid'

export interface StepInputBlocker {
  readonly code: StepInputBlockerCode
  readonly message: string
  /** `input-unread` 时是未读的输入路径。 */
  readonly subject?: string
}

/** 账本损坏的阻断：转换失败关闭，不提交；git / 观察问题不在此列（它们只降级为 unavailable）。 */
export function stepOutputLedgerBlocker(change: string, error: StepOutputLedgerError): StepInputBlocker {
  const reason = error.message.replace(/^步骤产出账本(?:损坏：)?/u, '')
  return {
    code: 'step-output-ledger-invalid',
    message: `步骤产出账本损坏：${reason}；修复 openspec/changes/${change}/${STEP_OUTPUT_LEDGER_FILE} 后重试`,
  }
}

/** 当前步骤访问还没读的交接输入，每个一条阻断；读完（回执等于上游或当前摘要）的不列。 */
export async function unreadInputBlockers(changeDir: string): Promise<readonly StepInputBlocker[]> {
  const ctx = stepOutputsContextFor(changeDir)
  try {
    const view = await readStepOutputs(ctx, { live: false })
    return unreadInputs(view).map((input): StepInputBlocker => ({
      code: 'input-unread',
      message: `本步输入 ${input.path}（${input.fromStep} 的产出）还没读；读完后执行 tenon document read ${ctx.change} all`,
      subject: input.path,
    }))
  } catch (error) {
    if (error instanceof StepOutputLedgerError) return [stepOutputLedgerBlocker(ctx.change, error)]
    throw error
  }
}
