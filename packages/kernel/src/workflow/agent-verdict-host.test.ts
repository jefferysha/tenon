/**
 * 跨厂商评审的裁决规则（纯函数，桩出的台账行）：登记的宿主必须满足步骤声明的 host，候选绑定照旧。
 */
import { describe, expect, it } from 'vitest'
import type { AgentRunRow } from '../state/agent-runs.js'
import {
  evaluateStepAgents, nextAgentWave, projectStepAgents, renderAgentBlocker, type StepAgentsInput,
} from './agent-verdict.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { StepAgentsCapability } from './effective-plan-types.js'
import type { WorkflowDef } from './types.js'

const VISIT = '["run-1",7]'
const CANDIDATE = `sha256:${'1'.repeat(64)}`
const OTHER = `sha256:${'2'.repeat(64)}`
const ACTOR = { id: 'a@x.com', name: 'A', trust: 'declared' } as const
const FINDING = [{ severity: 'high' as const, location: 'a.ts:1', message: '一' }]

function run(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    schema: 'agent-run/v1',
    run_id: `r-${overrides.agent ?? 'x'}`,
    agent: 'security',
    agent_digest: `sha256:${'0'.repeat(64)}`,
    role: 'reviewer',
    step: 'verify',
    step_visit: VISIT,
    candidate: CANDIDATE,
    status: 'finished',
    result: 'pass',
    findings: [],
    report_path: 'r.md',
    report_digest: `sha256:${'3'.repeat(64)}`,
    actor: ACTOR,
    started_at: '2026-09-20T01:00:00Z',
    finished_at: '2026-09-20T01:10:00Z',
    ...overrides,
  }
}

function input(step: Partial<StepAgentsCapability>, runs: readonly AgentRunRow[] = []): StepAgentsInput {
  return {
    step: { stepId: 'verify', executors: [], reviewers: [], ...step },
    runs,
    stepVisit: VISIT,
    candidate: CANDIDATE,
    testsReady: { ready: true, pending: [] },
  }
}

const reviewer = (agent: string, overrides: Partial<StepAgentsCapability['reviewers'][number]> = {}) =>
  ({ agent, required: true, blockAt: 'medium' as const, dependsOn: [], readsTests: [], ...overrides })

describe('跨厂商评审：登记的宿主必须满足步骤声明的 host', () => {
  const codexReviewer = reviewer('security', { host: 'codex' })

  it('宿主相符 → 照常通过；视图带出要求、登记的宿主与来源', () => {
    const view = projectStepAgents(input({ reviewers: [codexReviewer] }, [run({ agent: 'security', host: 'codex', host_source: 'detected' })]))[0]
    expect(view).toMatchObject({ state: 'done', result: 'pass', requiredHost: 'codex', host: 'codex', hostSource: 'detected', wrongHost: false })
    expect(evaluateStepAgents(input({ reviewers: [codexReviewer] }, [run({ agent: 'security', host: 'codex' })]))).toEqual({ pass: true, blockers: [] })
  })

  it('登记的宿主不符：裁决无效（状态 stale、没有结果），单独报 reviewer-wrong-host；不是候选过期', () => {
    const runs = [run({ agent: 'security', host: 'claude', host_source: 'detected' })]
    const view = projectStepAgents(input({ reviewers: [codexReviewer] }, runs))[0]
    expect(view).toMatchObject({ state: 'stale', result: null, blocking: 0, requiredHost: 'codex', host: 'claude', wrongHost: true })
    expect(evaluateStepAgents(input({ reviewers: [codexReviewer] }, runs))).toEqual({
      pass: false,
      blockers: [{ kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: 'claude' }],
    })
  })

  it('没有登记宿主（旧记录）同样无效；参考评审者不产生阻断', () => {
    const runs = [run({ agent: 'security' })]
    expect(evaluateStepAgents(input({ reviewers: [codexReviewer] }, runs)).blockers).toEqual([
      { kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: null },
    ])
    expect(evaluateStepAgents(input({ reviewers: [reviewer('security', { host: 'codex', required: false })] }, runs)).pass).toBe(true)
  })

  it('无效的宿主记录不算"已有结论"：对的宿主上重跑后只看那一次（reruns 0、不翻转），错的那次里的发现不连坐', () => {
    const runs = [
      run({ run_id: 'r1', agent: 'security', host: 'claude', findings: FINDING }),
      run({ run_id: 'r2', agent: 'security', host: 'codex', started_at: '2026-09-20T02:00:00Z' }),
    ]
    const view = projectStepAgents(input({ reviewers: [codexReviewer] }, runs))[0]
    expect(view).toMatchObject({ state: 'done', result: 'pass', reruns: 0, flipped: false, runId: 'r2', host: 'codex' })
    expect(evaluateStepAgents(input({ reviewers: [codexReviewer] }, runs)).pass).toBe(true)
  })

  it('对的宿主上的失败照常挡；错的宿主上的通过不能顶替它', () => {
    const runs = [
      run({ run_id: 'r1', agent: 'security', host: 'codex', findings: FINDING }),
      run({ run_id: 'r2', agent: 'security', host: 'claude' }),
    ]
    const verdict = evaluateStepAgents(input({ reviewers: [codexReviewer] }, runs))
    expect(verdict.pass).toBe(false)
    expect(verdict.blockers).toEqual([expect.objectContaining({ kind: 'reviewer-failed', agent: 'security' })])
  })

  it('候选绑定仍然在：宿主相符但候选变了 → 过期（reviewer-stale），不是宿主问题', () => {
    const runs = [run({ agent: 'security', host: 'codex', candidate: OTHER })]
    expect(evaluateStepAgents(input({ reviewers: [codexReviewer] }, runs)).blockers).toEqual([{ kind: 'reviewer-stale', agent: 'security' }])
    expect(projectStepAgents(input({ reviewers: [codexReviewer] }, runs))[0]).toMatchObject({ state: 'stale', wrongHost: false })
  })

  it('进行中的运行仍显示 running（宿主在登记时才判）', () => {
    const runs = [run({ agent: 'security', status: 'running', result: null })]
    expect(projectStepAgents(input({ reviewers: [codexReviewer] }, runs))[0]).toMatchObject({ state: 'running', wrongHost: false })
  })

  it('host: any 与没声明等价：任何宿主（含没登记）都有效，requiredHost 为 null', () => {
    for (const declared of [undefined, 'any' as const]) {
      const ref = reviewer('security', declared === undefined ? {} : { host: declared })
      const view = projectStepAgents(input({ reviewers: [ref] }, [run({ agent: 'security', host: 'claude' })]))[0]
      expect(view).toMatchObject({ state: 'done', result: 'pass', requiredHost: null, wrongHost: false })
      expect(evaluateStepAgents(input({ reviewers: [ref] }, [run({ agent: 'security' })])).pass).toBe(true)
    }
  })

  it('执行者不受 host 影响', () => {
    const view = projectStepAgents(input({ executors: [{ agent: 'builder', dependsOn: [] }] }, [run({ agent: 'builder', role: 'executor', result: 'done' })]))[0]
    expect(view).toMatchObject({ state: 'done', requiredHost: null, wrongHost: false })
  })

  it('wrong-host 的评审者重新排进波次（修法是在对的宿主上重跑）', () => {
    const runs = [run({ agent: 'security', host: 'claude' })]
    expect(nextAgentWave(input({ reviewers: [codexReviewer] }, runs)).wave).toEqual(['security'])
  })

  it('阻断行点名该在哪个宿主上、登记的是什么、怎么重跑', () => {
    expect(renderAgentBlocker({ kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: 'claude' }, 'demo')).toBe(
      "评审者 'security' 须在 codex 上运行，登记的宿主是 claude，这份结论无效；在 codex 上重跑：tenon agent prompt demo security",
    )
    expect(renderAgentBlocker({ kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: null }, 'demo'))
      .toContain('登记的宿主是 未记录')
  })

  it('工作流声明的 host 进入有效计划的 capabilities；没声明的没有这个键', () => {
    const def = {
      name: 'cv',
      steps: [{
        id: 'verify', label: 'V', gate: null, skills: [], inputs: [], outputs: [], guards: [],
        agents: {
          executors: [],
          reviewers: [
            { agent: 'security', required: true, block_at: 'medium', host: 'codex' },
            { agent: 'architecture', required: true, block_at: 'medium' },
          ],
        },
        transitions: [],
      }],
    } as unknown as WorkflowDef
    const plan = compileEffectiveWorkflowPlan('cv', def)
    const reviewers = plan.capabilities.agents.steps[0]?.reviewers ?? []
    expect(reviewers.find((item) => item.agent === 'security')?.host).toBe('codex')
    expect(reviewers.find((item) => item.agent === 'architecture')).not.toHaveProperty('host')
  })
})

describe('跨厂商评审与按风险挂载（attach_on）组合：先排除没挂载的，再对挂载的判宿主', () => {
  const security = reviewer('security', { host: 'codex' })
  const architecture = reviewer('architecture', { host: 'codex' })
  /** security 的 attach_on 没被本任务的改动命中（没挂载），architecture 挂载。 */
  const scoped = (runs: readonly AgentRunRow[]): StepAgentsInput => ({
    ...input({ reviewers: [security, architecture] }, runs),
    unattached: ['security'],
  })

  it('没挂载又要求宿主的评审者直接缺席：不投影、不排波、不阻断，哪怕台账里有一份宿主不符的旧结论', () => {
    const runs = [run({ agent: 'security', host: 'claude' })]
    expect(projectStepAgents(scoped(runs)).map((view) => view.agent)).toEqual(['architecture'])
    expect(nextAgentWave(scoped(runs)).wave).toEqual(['architecture'])
    expect(evaluateStepAgents(scoped(runs)).blockers).toEqual([{ kind: 'reviewer-missing', agent: 'architecture' }])
  })

  it('挂载的评审者宿主不符 → 视图 stale、单独报 reviewer-wrong-host；没挂载的那个仍然缺席', () => {
    const runs = [run({ agent: 'architecture', host: 'claude' }), run({ agent: 'security', host: 'claude' })]
    const views = projectStepAgents(scoped(runs))
    expect(views.map((view) => view.agent)).toEqual(['architecture'])
    expect(views[0]).toMatchObject({ state: 'stale', result: null, requiredHost: 'codex', host: 'claude', wrongHost: true })
    expect(evaluateStepAgents(scoped(runs)).blockers).toEqual([
      { kind: 'reviewer-wrong-host', agent: 'architecture', required: 'codex', recorded: 'claude' },
    ])
    expect(nextAgentWave(scoped(runs)).wave).toEqual(['architecture'])
  })

  it('挂载的评审者在对的宿主上通过，没挂载的没有任何记录：步骤放行', () => {
    const runs = [run({ agent: 'architecture', host: 'codex' })]
    expect(evaluateStepAgents(scoped(runs))).toEqual({ pass: true, blockers: [] })
  })

  it('指向没挂载者的 depends_on 一并去掉，挂载者不会等一个不会来的结论', () => {
    const dependent = reviewer('architecture', { host: 'codex', dependsOn: ['security'] })
    const state: StepAgentsInput = { ...input({ reviewers: [security, dependent] }), unattached: ['security'] }
    expect(nextAgentWave(state)).toEqual({ wave: ['architecture'], waiting: [] })
    expect(projectStepAgents(state)[0]).toMatchObject({ agent: 'architecture', dependsOn: [] })
  })
})

