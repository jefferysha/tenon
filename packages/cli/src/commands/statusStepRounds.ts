/**
 * `tenon status <change> --json` 步骤块的 `rounds`：受上限约束的步骤（评审门且有回退边）当前是第几轮、
 * 上限多少、上限从哪来。其余步骤为 null。
 *
 * 轮次的读取（canonical 转换记录链，没有链的旧任务退回 JSONL 转换行）在 kernel 的 `readStepRounds`，
 * Dashboard 服务的 transition 强制层读同一份；这里只把 CLI 的读取能力交进去。
 */
import { readStepRounds, type EffectiveWorkflowPlan, type PipelineState, type StepRounds } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

export type { StepRounds }

export function stepRounds(
  deps: Pick<CliDeps, 'recordStore' | 'readHistoryRaw'>,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  stepId: string,
): Promise<StepRounds | null> {
  return readStepRounds(deps, dir, state, plan, stepId)
}
