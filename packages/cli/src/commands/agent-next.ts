/**
 * `tenon agent next <change> [--json]` —— 当前步骤每个 agent 的身份、状态与下一波。
 * 判定是 kernel 的 projectStepAgents / nextAgentWave / evaluateStepAgents，这里只换形状；有拦截仍 exit 0。
 */
import {
  evaluateStepAgents, nextAgentWave, projectStepAgents, renderAgentBlocker,
  type AgentView,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { resolveAgentCommand } from './agent-context.js'
import { msg, type LocaleCarrier } from '../i18n/messages.js'
import { hostNote } from './agent-route.js'
import { rerunNote } from './agent-rerun.js'

const viewJson = (view: AgentView, waiting: readonly { agent: string; for: readonly string[] }[]) => ({
  agent: view.agent,
  role: view.role,
  required: view.required,
  block_at: view.blockAt ?? null,
  depends_on: view.dependsOn,
  reads_tests: view.readsTests,
  state: view.state,
  result: view.result,
  findings: view.findings,
  blocking: view.blocking,
  run_id: view.runId,
  reruns: view.reruns, flipped: view.flipped, rerun_reason: view.rerunReason,
  required_host: view.requiredHost, host: view.host, host_source: view.hostSource, wrong_host: view.wrongHost,
  candidate: view.candidate,
  waiting_for: waiting.find((item) => item.agent === view.agent)?.for ?? [],
})

export async function cmdAgentNext(deps: CliDeps, name: string, json: boolean): Promise<number> {
  const context = await resolveAgentCommand(deps, name, { requireOwner: false })
  if (typeof context === 'number') return context
  const views = projectStepAgents(context)
  const { wave, waiting } = nextAgentWave(context)
  const verdict = evaluateStepAgents(context)
  if (json) {
    deps.io.out(JSON.stringify({
      change: name,
      step: context.step.stepId,
      step_visit: context.stepVisit,
      candidate: context.candidate,
      agents: views.map((view) => viewJson(view, waiting)),
      wave,
      pass: verdict.pass,
      // 与人读输出的「全部完成」同一判定：没有进行中的、没有在等的、离开判定通过。
      complete: wave.length === 0 && waiting.length === 0 && verdict.pass
        && views.every((view) => view.state !== 'running'),
      blockers: verdict.blockers,
    }))
    return 0
  }
  for (const view of views) {
    const role = msg(deps, `agent.next.role.${view.role}`)
    const state = msg(deps, `agent.next.state.${view.state}`)
    const result = view.result === null ? '' : ` ${msg(deps, `agent.next.result.${view.result}`)}`
    const findings = view.findings === 0 ? '' : ` ${msg(deps, 'agent.next.findings', { count: view.findings })}`
    deps.io.out(`${view.agent} ${role} ${state}${result}${findings}${rerunNote(deps, view)}${hostNote(deps, view)}`)
  }
  for (const line of waveSummary(deps, name, views, wave, waiting, verdict)) deps.io.out(line)
  return 0
}

/**
 * 「下一波」为空不等于做完了：执行者 prompt 之后还没 record、评审者在等必需测试或别的 agent、
 * 必需评审者打回——这三种情况波次都是空的，从前一律印「全部完成」，运行器照信就走了。
 * 只有没有进行中的、没有在等的、且离开判定通过时才说全部完成；否则逐条说还差什么。
 */
function waveSummary(
  carrier: LocaleCarrier,
  change: string,
  views: readonly AgentView[],
  wave: readonly string[],
  waiting: readonly { readonly agent: string; readonly for: readonly string[] }[],
  verdict: ReturnType<typeof evaluateStepAgents>,
): readonly string[] {
  if (wave.length > 0) return [msg(carrier, 'agent.next.wave', { agents: wave.join(', ') })]
  const lines: string[] = []
  for (const view of views) {
    if (view.state !== 'running') continue
    lines.push(msg(carrier, 'agent.next.running', { agent: view.agent, change, run: view.runId ?? '<run>' }))
  }
  for (const item of waiting) lines.push(msg(carrier, 'agent.next.waiting', { agent: item.agent, needs: item.for.join(', ') }))
  if (lines.length === 0 && verdict.pass) return [msg(carrier, 'agent.next.allDone')]
  if (lines.length === 0) {
    for (const blocker of verdict.blockers) lines.push(msg(carrier, 'agent.next.unfinished', { blocker: renderAgentBlocker(blocker, change) }))
  }
  return lines
}
