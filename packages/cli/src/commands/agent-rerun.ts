/**
 * `tenon agent prompt` 的评审者重跑防刷（F8）：同一份代码（同一候选）上评审者已经有结论，再开一次必须写明原因。
 * 没有原因就拒绝（exit 2）；有原因的重跑在判定里以最后一次为准，原因写进台账行（kernel agent-verdict.ts）。
 */
import { AGENT_RERUN_REASON_MAX, hostRunValid, type AgentRunRow, type AgentView, type ReviewerHost } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg, type LocaleCarrier } from '../i18n/messages.js'

/** `--rerun-reason` 的文字校验：一行、非空、不超长。返回 undefined = 没给；字符串 = 规整后的原因；null = 非法（已打印错误）。 */
export function parseRerunReason(deps: Pick<CliDeps, 'io' | 'locale'>, raw: string | undefined): string | undefined | null {
  if (raw === undefined) return undefined
  const reason = raw.trim()
  if (reason !== '' && reason.length <= AGENT_RERUN_REASON_MAX && !/[\r\n]/u.test(reason)) return reason
  deps.io.err(`ERROR: ${msg(deps, 'agent.rerun.reasonInvalid', { max: AGENT_RERUN_REASON_MAX })}`)
  return null
}

/** `agent next` 一行末尾的重跑说明：次数、结论是否翻转、写明的原因。 */
export function rerunNote(carrier: LocaleCarrier, view: Pick<AgentView, 'reruns' | 'flipped' | 'rerunReason'>): string {
  if (view.reruns === 0) return ''
  return msg(carrier, 'agent.next.rerun', {
    count: view.reruns,
    flipped: view.flipped ? msg(carrier, 'agent.next.rerun.flipped') : '',
    reason: view.rerunReason === null ? '' : msg(carrier, 'agent.next.rerun.reason', { reason: view.rerunReason }),
  })
}

/**
 * 本次步骤访问里，该评审者在当前候选上已结束的运行。工作流要求了宿主（`host`）时，登记的宿主不符的运行是无效裁决，
 * 不算「已经有结论」——在对的宿主上重跑它们不需要写原因。
 */
export function priorRunsOnCandidate(
  runs: readonly AgentRunRow[],
  agent: string,
  stepVisit: string,
  candidate: string,
  host?: ReviewerHost,
): readonly AgentRunRow[] {
  return runs.filter((row) => row.agent === agent && row.step_visit === stepVisit
    && row.status === 'finished' && row.candidate === candidate && hostRunValid(host, row.host))
}

export function rerunRefusal(carrier: LocaleCarrier, change: string, agent: string, prior: readonly AgentRunRow[]): string {
  return `ERROR: ${msg(carrier, 'agent.rerun.refused', {
    agent,
    count: prior.length,
    results: prior.map((row) => `${row.result ?? '?'}`).join(msg(carrier, 'list.separator')),
    change,
  })}`
}
