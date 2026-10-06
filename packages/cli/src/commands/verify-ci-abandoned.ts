/**
 * `tenon verify --ci` 对被放弃任务的处理：读 canonical 状态校验过的链头 TransitionRecord，交给 kernel 的
 * `abandonedTerminal` 判断它是不是真的沿放弃边走进了终态；是就不判定它的测试证据、只留一条提示，受保护文件的批准照查。
 * 判断依据是作者提交的转换链：它自洽（经 run revision 摘要校验）但没有封存，CI 证明不了它不是整条重造的。
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

/**
 * 被放弃任务的报告：测试证据不判定（`policy: none`、没有记录链），只留一条提示；受保护文件的批准发现（`protectedFindings`）
 * 原样带上、照常定级——放弃边不要求任何评审，批准检查是这条边上唯一还拦得住受保护配置被改的东西。
 */
export function abandonedReport(
  deps: CliDeps,
  selected: SelectedChange,
  phase: string,
  abandoned: AbandonedChange,
  protectedFindings: readonly CiFinding[],
): CiChangeReport {
  const finding: CiFinding = {
    code: 'change-abandoned', severity: 'note', change: selected.name, source: 'ci',
    message: verifyMsg(deps, 'verify.changeAbandoned', { change: selected.name, event: abandoned.event, from: abandoned.from, to: abandoned.to }),
    path: `${selected.relDir}/.pipeline.yaml`,
  }
  return {
    change: selected.name, dir: selected.relDir, phase, step: abandoned.to, policy: 'none', evaluatedUser: null,
    chains: [], anchor: 'none', findings: [finding, ...protectedFindings],
  }
}
