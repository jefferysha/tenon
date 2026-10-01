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
import { hostNote } from './agent-route.js'
import { rerunNote } from './agent-rerun.js'

const ROLE_WORD = { executor: '执行者', reviewer: '评审者' } as const
const STATE_WORD = { idle: '未运行', running: '进行中', done: '已完成', stale: '过期' } as const
const RESULT_WORD = { pass: '通过', fail: '不通过', done: '完成', failed: '失败' } as const

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
    const result = view.result === null ? '' : ` ${RESULT_WORD[view.result]}`
    const findings = view.findings === 0 ? '' : ` 问题 ${view.findings}`
    deps.io.out(`${view.agent} ${ROLE_WORD[view.role]} ${STATE_WORD[view.state]}${result}${findings}${rerunNote(view)}${hostNote(view)}`)
  }
  for (const line of waveSummary(name, views, wave, waiting, verdict)) deps.io.out(line)
  return 0
}

/**
 * 「下一波」为空不等于做完了：执行者 prompt 之后还没 record、评审者在等必需测试或别的 agent、
 * 必需评审者打回——这三种情况波次都是空的，从前一律印「全部完成」，运行器照信就走了。
 * 只有没有进行中的、没有在等的、且离开判定通过时才说全部完成；否则逐条说还差什么。
 */
function waveSummary(
  change: string,
  views: readonly AgentView[],
  wave: readonly string[],
  waiting: readonly { readonly agent: string; readonly for: readonly string[] }[],
  verdict: ReturnType<typeof evaluateStepAgents>,
): readonly string[] {
  if (wave.length > 0) return [`下一波：${wave.join(', ')}`]
  const lines: string[] = []
  for (const view of views) {
    if (view.state !== 'running') continue
    lines.push(`进行中：${view.agent}；完成后 tenon agent record ${change} ${view.runId ?? '<run>'}`)
  }
  for (const item of waiting) lines.push(`等待：${item.agent} ← ${item.for.join(', ')}`)
  if (lines.length === 0 && verdict.pass) return ['全部完成']
  if (lines.length === 0) {
    for (const blocker of verdict.blockers) lines.push(`未完成：${renderAgentBlocker(blocker, change)}`)
  }
  return lines
}
