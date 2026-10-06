/**
 * `tenon verify --ci` 对被放弃任务的处理：读 canonical 状态校验过的链头 TransitionRecord，交给 kernel 的
 * `abandonedTerminal` 判断它是不是真的沿放弃边走进了终态；是就只留一条提示，不判定它的证据。
 * 读不出（没有 canonical 状态、校验不过、读文件失败）一律当作「不是被放弃的」——照常判定，不放宽。
 */
import {
  abandonedTerminal, readValidatedTransitionHead,
  type AbandonedChange, type CiChangeReport, type CiFinding, type EffectiveWorkflowPlan,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import type { SelectedChange } from './verify-ci-select.js'
import { verifyMsg } from './verify-ci-text.js'

export async function abandonedChangeOf(
  selected: SelectedChange,
  phase: string,
  plan: EffectiveWorkflowPlan,
): Promise<AbandonedChange | undefined> {
  try {
    const validated = await readValidatedTransitionHead(selected.dir)
    if (validated === undefined) return undefined
    return abandonedTerminal({ phase, canonicalPhase: str(validated.current.state.fields.phase), plan, head: validated.record })
  } catch {
    return undefined
  }
}

export function abandonedReport(deps: CliDeps, selected: SelectedChange, phase: string, abandoned: AbandonedChange): CiChangeReport {
  const finding: CiFinding = {
    code: 'change-abandoned', severity: 'note', change: selected.name, source: 'ci',
    message: verifyMsg(deps, 'verify.changeAbandoned', { change: selected.name, event: abandoned.event, from: abandoned.from, to: abandoned.to }),
    path: `${selected.relDir}/.pipeline.yaml`,
  }
  return {
    change: selected.name, dir: selected.relDir, phase, step: abandoned.to, policy: 'none', evaluatedUser: null,
    chains: [], anchor: 'none', findings: [finding],
  }
}
