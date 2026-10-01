/**
 * `tenon agent prompt` 的评审者重跑防刷（F8）：同一份代码（同一候选）上评审者已经有结论，再开一次必须写明原因。
 * 没有原因就拒绝（exit 2）；有原因的重跑在判定里以最后一次为准，原因写进台账行（kernel agent-verdict.ts）。
 */
import { AGENT_RERUN_REASON_MAX, type AgentRunRow, type AgentView } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

/** `--rerun-reason` 的文字校验：一行、非空、不超长。返回 undefined = 没给；字符串 = 规整后的原因；null = 非法（已打印错误）。 */
export function parseRerunReason(deps: Pick<CliDeps, 'io'>, raw: string | undefined): string | undefined | null {
  if (raw === undefined) return undefined
  const reason = raw.trim()
  if (reason !== '' && reason.length <= AGENT_RERUN_REASON_MAX && !/[\r\n]/u.test(reason)) return reason
  deps.io.err(`ERROR: --rerun-reason 需要一行不超过 ${AGENT_RERUN_REASON_MAX} 字的原因`)
  return null
}

/** `agent next` 一行末尾的重跑说明：次数、结论是否翻转、写明的原因。 */
export function rerunNote(view: Pick<AgentView, 'reruns' | 'flipped' | 'rerunReason'>): string {
  if (view.reruns === 0) return ''
  return ` 重跑 ${view.reruns} 次${view.flipped ? '（结论翻转）' : ''}${view.rerunReason === null ? '' : `：${view.rerunReason}`}`
}

/** 本次步骤访问里，该评审者在当前候选上已结束的运行。 */
export function priorRunsOnCandidate(
  runs: readonly AgentRunRow[],
  agent: string,
  stepVisit: string,
  candidate: string,
): readonly AgentRunRow[] {
  return runs.filter((row) => row.agent === agent && row.step_visit === stepVisit
    && row.status === 'finished' && row.candidate === candidate)
}

export function rerunRefusal(change: string, agent: string, prior: readonly AgentRunRow[]): string {
  return `ERROR: 评审者 '${agent}' 在当前候选上已经有 ${prior.length} 次结论（${prior.map((row) => `${row.result ?? '?'}`).join('、')}）：同一份代码不能靠重跑换结论。`
    + `改代码换候选后再重跑；确有需要（例如上次的提示缺上下文）用 tenon agent prompt ${change} ${agent} --rerun-reason <原因> 写明并留痕，`
    + '判定会把同一候选上的所有运行一并看（没有原因的重跑取最严结论，有原因的以最后一次为准）'
}
