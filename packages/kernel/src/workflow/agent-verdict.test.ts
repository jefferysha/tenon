import { describe, expect, it } from 'vitest'
import type { AgentRunRow } from '../state/agent-runs.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { StepAgentsCapability } from './effective-plan-types.js'
import type { WorkflowDef } from './types.js'
import {
  evaluateStepAgents, isForwardExit, nextAgentWave, projectStepAgents, renderAgentBlocker,
  type StepAgentsInput,
} from './agent-verdict.js'

const VISIT = '["run-1",7]'
const CANDIDATE = `sha256:${'1'.repeat(64)}`
const OTHER = `sha256:${'2'.repeat(64)}`
const ACTOR = { id: 'a@x.com', name: 'A', trust: 'declared' } as const

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

function input(step: Partial<StepAgentsCapability>, runs: readonly AgentRunRow[] = [], ready = true): StepAgentsInput {
  return {
    step: { stepId: 'verify', executors: [], reviewers: [], ...step },
    runs,
    stepVisit: VISIT,
    candidate: CANDIDATE,
    testsReady: ready ? { ready: true, pending: [] } : { ready: false, pending: ['unit'] },
  }
}

const reviewer = (agent: string, overrides: Partial<StepAgentsCapability['reviewers'][number]> = {}) =>
  ({ agent, required: true, blockAt: 'medium' as const, dependsOn: [], readsTests: [], ...overrides })
const executor = (agent: string, dependsOn: readonly string[] = []) => ({ agent, dependsOn })

describe('projectStepAgents 状态表', () => {
  const cases: readonly [string, Partial<AgentRunRow> | undefined, 'executor' | 'reviewer', string][] = [
    ['无运行 → idle', undefined, 'reviewer', 'idle'],
    ['进行中且同候选 → running', { status: 'running', result: null }, 'reviewer', 'running'],
    ['进行中但候选已变 → stale', { status: 'running', result: null, candidate: OTHER }, 'reviewer', 'stale'],
    ['已完成且同候选 → done', {}, 'reviewer', 'done'],
    ['已完成但候选已变 → stale', { candidate: OTHER }, 'reviewer', 'stale'],
    ['执行者进行中且候选已变仍是 running', { status: 'running', result: null, candidate: OTHER }, 'executor', 'running'],
    ['执行者完成后候选变化也不过期', { result: 'done', candidate: OTHER }, 'executor', 'done'],
  ]
  for (const [title, overrides, role, expected] of cases) {
    it(title, () => {
      const runs = overrides === undefined ? [] : [run({ agent: 'a', role, ...overrides })]
      const step = role === 'executor' ? { executors: [executor('a')] } : { reviewers: [reviewer('a')] }
      expect(projectStepAgents(input(step, runs))[0]?.state).toBe(expected)
    })
  }

  it('结论由阻断级别算，参考评审者也算 blocking 计数', () => {
    const runs = [run({
      agent: 'a',
      findings: [
        { severity: 'high', location: 'a.ts:1', message: '一' },
        { severity: 'low', location: 'a.ts:2', message: '二' },
      ],
    })]
    const strict = projectStepAgents(input({ reviewers: [reviewer('a', { blockAt: 'medium' })] }, runs))[0]
    expect(strict).toMatchObject({ result: 'fail', findings: 2, blocking: 1 })
    const loose = projectStepAgents(input({ reviewers: [reviewer('a', { blockAt: 'critical' })] }, runs))[0]
    expect(loose).toMatchObject({ result: 'pass', findings: 2, blocking: 0 })
  })

  it('更早步骤访问的运行只是历史', () => {
    const runs = [run({ agent: 'a', step_visit: '["run-1",1]' })]
    expect(projectStepAgents(input({ reviewers: [reviewer('a')] }, runs))[0]?.state).toBe('idle')
  })

  it('同一 agent 多行取最后一行；操作人与报告路径带出来', () => {
    const runs = [
      run({ agent: 'a', run_id: 'r1', status: 'running', result: null }),
      run({ agent: 'a', run_id: 'r1', report_path: 'final.md' }),
    ]
    expect(projectStepAgents(input({ reviewers: [reviewer('a')] }, runs))[0])
      .toMatchObject({ state: 'done', reportPath: 'final.md', actor: { id: 'a@x.com', name: 'A' }, runId: 'r1' })
  })
})

describe('evaluateStepAgents', () => {
  it('执行者四态', () => {
    expect(evaluateStepAgents(input({ executors: [executor('b')] })).blockers)
      .toEqual([{ kind: 'executor-missing', agent: 'b' }])
    expect(evaluateStepAgents(input({ executors: [executor('b')] },
      [run({ agent: 'b', role: 'executor', status: 'running', result: null })])).blockers)
      .toEqual([{ kind: 'executor-running', agent: 'b', runId: 'r-b' }])
    expect(evaluateStepAgents(input({ executors: [executor('b')] },
      [run({ agent: 'b', role: 'executor', result: 'failed' })])).blockers)
      .toEqual([{ kind: 'executor-failed', agent: 'b' }])
    expect(evaluateStepAgents(input({ executors: [executor('b')] },
      [run({ agent: 'b', role: 'executor', result: 'done' })])))
      .toEqual({ pass: true, blockers: [] })
  })

  it('必需评审者五态', () => {
    const step = { reviewers: [reviewer('a')] }
    expect(evaluateStepAgents(input(step)).blockers).toEqual([{ kind: 'reviewer-missing', agent: 'a' }])
    expect(evaluateStepAgents(input(step, [run({ agent: 'a', status: 'running', result: null })])).blockers)
      .toEqual([{ kind: 'reviewer-running', agent: 'a', runId: 'r-a' }])
    expect(evaluateStepAgents(input(step, [run({ agent: 'a', candidate: OTHER })])).blockers)
      .toEqual([{ kind: 'reviewer-stale', agent: 'a' }])
    const failing = [run({ agent: 'a', findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }] })]
    // 不通过的阻断带着判定所依据的那次运行与候选：剩余阻断的接受绑定的就是这两样。
    expect(evaluateStepAgents(input(step, failing)).blockers).toEqual([{
      kind: 'reviewer-failed', agent: 'a', blockAt: 'medium', runId: 'r-a', candidate: CANDIDATE,
      blocking: [{ severity: 'high', location: 'a.ts:1', message: '坏' }],
    }])
    expect(evaluateStepAgents(input(step, [run({ agent: 'a' })]))).toEqual({ pass: true, blockers: [] })
  })

  it('参考评审者从不阻断', () => {
    const failing = [run({ agent: 'a', findings: [{ severity: 'critical', location: 'a.ts:1', message: '坏' }] })]
    expect(evaluateStepAgents(input({ reviewers: [reviewer('a', { required: false })] }, failing)))
      .toEqual({ pass: true, blockers: [] })
  })

  it('没有 agent 的步骤直接通过', () => {
    expect(evaluateStepAgents(input({}))).toEqual({ pass: true, blockers: [] })
  })
})

describe('nextAgentWave', () => {
  const step: StepAgentsCapability = {
    stepId: 'build',
    executors: [executor('builder'), executor('builder-ui', ['builder'])],
    reviewers: [
      reviewer('frontend-quality'),
      reviewer('code-size', { readsTests: ['unit'] }),
      reviewer('architecture', { required: false, dependsOn: ['frontend-quality', 'code-size'] }),
    ],
  }

  it('先排执行者第 0 波，依赖者在下一波', () => {
    expect(nextAgentWave(input(step)).wave).toEqual(['builder'])
    const done = [run({ agent: 'builder', role: 'executor', result: 'done' })]
    expect(nextAgentWave(input(step, done)).wave).toEqual(['builder-ui'])
  })

  it('执行者未完成时评审者列出在等谁', () => {
    const waiting = nextAgentWave(input(step)).waiting
    expect(waiting.find((item) => item.agent === 'frontend-quality')?.for)
      .toEqual(['executor:builder', 'executor:builder-ui'])
    expect(waiting.find((item) => item.agent === 'builder-ui')?.for).toEqual(['executor:builder'])
  })

  it('执行者完成后并行评审者同波，依赖者下一波', () => {
    const done = [
      run({ agent: 'builder', role: 'executor', result: 'done' }),
      run({ agent: 'builder-ui', role: 'executor', result: 'done' }),
    ]
    expect(nextAgentWave(input(step, done)).wave).toEqual(['frontend-quality', 'code-size'])
    const reviewed = [...done, run({ agent: 'frontend-quality' }), run({ agent: 'code-size' })]
    expect(nextAgentWave(input(step, reviewed)).wave).toEqual(['architecture'])
    expect(nextAgentWave(input(step, [...reviewed, run({ agent: 'architecture' })])).wave).toEqual([])
  })

  it('必需测试未就绪时评审者等 test:<id>', () => {
    const done = [
      run({ agent: 'builder', role: 'executor', result: 'done' }),
      run({ agent: 'builder-ui', role: 'executor', result: 'done' }),
    ]
    const wave = nextAgentWave(input(step, done, false))
    expect(wave.wave).toEqual([])
    expect(wave.waiting.find((item) => item.agent === 'code-size')?.for).toEqual(['test:unit'])
  })

  it('进行中的 agent 不重复排；过期的评审者重新排', () => {
    const base = { reviewers: [reviewer('a')] }
    expect(nextAgentWave(input(base, [run({ agent: 'a', status: 'running', result: null })])).wave).toEqual([])
    expect(nextAgentWave(input(base, [run({ agent: 'a', candidate: OTHER })])).wave).toEqual(['a'])
    expect(nextAgentWave(input(base, [run({ agent: 'a' })])).wave).toEqual([])
  })

  it('不通过的评审者仍排进波次（修完重跑）', () => {
    const failing = [run({ agent: 'a', findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }] })]
    expect(nextAgentWave(input({ reviewers: [reviewer('a')] }, failing)).wave).toEqual(['a'])
  })
})

describe('isForwardExit', () => {
  const custom = compileEffectiveWorkflowPlan('flow', {
    name: 'flow',
    steps: [
      { id: 'build', label: 'B', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'verify' }] },
      { id: 'verify', label: 'V', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'back', to: 'build' }] },
    ],
  } as WorkflowDef)

  it('step-graph 按声明顺序判前后', () => {
    expect(isForwardExit(custom, 'build', 'verify', 'go')).toBe(true)
    expect(isForwardExit(custom, 'verify', 'build', 'back')).toBe(false)
  })

  it('隐式完结自边算前进', () => {
    expect(isForwardExit(custom, 'verify', 'verify', 'archived')).toBe(true)
  })

  it('phase-manifest 按事件的 enforceTaskExit', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    expect(isForwardExit(plan, 'verify', 'ship', 'verify-pass')).toBe(true)
    expect(isForwardExit(plan, 'verify', 'build', 'verify-fail')).toBe(false)
    expect(isForwardExit(plan, 'build', 'spec', 'requirements-changed')).toBe(false)
    expect(isForwardExit(plan, 'build', 'verify', 'nonsense')).toBe(false)
  })
})

describe('renderAgentBlocker', () => {
  it('每条都点名解锁命令', () => {
    expect(renderAgentBlocker({ kind: 'executor-missing', agent: 'b' }, 'c'))
      .toBe("执行者 'b' 未运行；运行：tenon agent next c")
    expect(renderAgentBlocker({ kind: 'executor-running', agent: 'b', runId: 'r-b' }, 'c'))
      .toBe("执行者 'b' 进行中；完成后：tenon agent record c r-b")
    expect(renderAgentBlocker({ kind: 'executor-failed', agent: 'b' }, 'c'))
      .toBe("执行者 'b' 失败；重跑：tenon agent prompt c b")
    expect(renderAgentBlocker({ kind: 'reviewer-missing', agent: 'a' }, 'c'))
      .toBe("评审者 'a' 未运行；运行：tenon agent next c")
    expect(renderAgentBlocker({ kind: 'reviewer-running', agent: 'a', runId: 'r-a' }, 'c'))
      .toBe("评审者 'a' 进行中；完成后：tenon agent record c r-a")
    expect(renderAgentBlocker({ kind: 'reviewer-stale', agent: 'a' }, 'c'))
      .toBe("评审者 'a' 的结论已过期（候选已变化）；重跑：tenon agent prompt c a")
    expect(renderAgentBlocker({ kind: 'agent-records-invalid', reason: '第 2 行形状非法' }, 'c'))
      .toBe('agent 记录不可读：第 2 行形状非法')
  })

  /**
   * 真机实测的缺陷（acceptance run）：阻断行发的是字面量 `<run>`，而真正的 run id 就在同一份
   * payload 的 `step.reviewers[].run_id` 里。照抄那条命令必然失败。
   */
  it('进行中的阻断带上真实 run id，而不是占位符', () => {
    const running = run({ agent: 'security', status: 'running', result: null, run_id: 'r-security-7' })
    const result = evaluateStepAgents(input(
      { reviewers: [reviewer('security')], executors: [executor('builder')] },
      [running, run({ agent: 'builder', role: 'executor', status: 'running', result: null, run_id: 'r-builder-3' })],
    ))
    expect(result.blockers).toEqual([
      { kind: 'executor-running', agent: 'builder', runId: 'r-builder-3' },
      { kind: 'reviewer-running', agent: 'security', runId: 'r-security-7' },
    ])
    const lines = result.blockers.map((blocker) => renderAgentBlocker(blocker, 'demo'))
    expect(lines).toEqual([
      "执行者 'builder' 进行中；完成后：tenon agent record demo r-builder-3",
      "评审者 'security' 进行中；完成后：tenon agent record demo r-security-7",
    ])
    for (const line of lines) expect(line).not.toContain('<run>')
  })

  it('拿不到 run id 时点名去哪儿查，仍不让人照抄占位符', () => {
    expect(renderAgentBlocker({ kind: 'reviewer-running', agent: 'a', runId: null }, 'c'))
      .toBe("评审者 'a' 进行中；完成后：tenon agent record c <run>（用 tenon agent next c 查 run id）")
  })

  it('不通过只列前五条问题', () => {
    const blocking = Array.from({ length: 7 }, (_unused, index) =>
      ({ severity: 'high' as const, location: `a.ts:${index}`, message: `第${index}` }))
    const line = renderAgentBlocker({ kind: 'reviewer-failed', agent: 'a', blockAt: 'medium', blocking }, 'c')
    expect(line).toContain('7 个问题 ≥ medium')
    expect(line).toContain('a.ts:4 第4')
    expect(line).not.toContain('a.ts:5')
    expect(line).toContain('tenon agent prompt c a')
  })
})


describe('评审者同候选多次运行（F8：重跑刷结论）', () => {
  const FAIL = [{ severity: 'high' as const, location: 'a.ts:1', message: '越权' }]
  const first = run({ run_id: 'r1', result: 'fail', findings: FAIL, finished_at: '2026-09-20T01:10:00Z' })
  const flip = run({ run_id: 'r2', result: 'pass', findings: [], finished_at: '2026-09-20T01:20:00Z' })
  const step = { reviewers: [reviewer('security', { blockAt: 'medium' })] }

  it('第一次不通过、同候选再跑一次通过且没写原因：仍取最严结论（不通过），并标出重跑次数与翻转', () => {
    const data = input(step, [first, flip])
    const result = evaluateStepAgents(data)
    expect(result.pass).toBe(false)
    expect(result.blockers).toEqual([expect.objectContaining({ kind: 'reviewer-failed', agent: 'security', reruns: 1 })])
    const [view] = projectStepAgents(data)
    expect(view).toMatchObject({ result: 'fail', blocking: 1, runId: 'r1', reruns: 1, flipped: true, rerunReason: null })
    expect(renderAgentBlocker(result.blockers[0] as never, 'demo')).toContain('同一候选上已跑 2 次，取最严的结论')
  })

  it('最后一次运行写明了重跑原因：以它为准并留痕（仍标出翻转与原因）', () => {
    const justified = { ...flip, rerun_reason: '第一轮提示词没带 DESIGN.md' }
    const data = input(step, [first, justified])
    expect(evaluateStepAgents(data).pass).toBe(true)
    const [view] = projectStepAgents(data)
    expect(view).toMatchObject({ result: 'pass', runId: 'r2', reruns: 1, flipped: true, rerunReason: '第一轮提示词没带 DESIGN.md' })
  })

  it('有原因的重跑如果又失败，照样不通过', () => {
    const again = run({ run_id: 'r2', result: 'fail', findings: FAIL, rerun_reason: '补充上下文后重跑' })
    expect(evaluateStepAgents(input(step, [flip, again])).pass).toBe(false)
  })

  it('三次运行、无原因：取最严的一次（级别最高），而不是最新或最早的', () => {
    const low = run({ run_id: 'r1', result: 'pass', findings: [{ severity: 'low', location: 'x', message: 'nit' }] })
    const critical = run({ run_id: 'r2', result: 'fail', findings: [{ severity: 'critical', location: 'a.ts:9', message: '注入' }] })
    const clean = run({ run_id: 'r3', result: 'pass', findings: [] })
    const [view] = projectStepAgents(input(step, [low, critical, clean]))
    expect(view).toMatchObject({ runId: 'r2', result: 'fail', reruns: 2, flipped: true })
  })

  it('候选变了之后的运行是新候选上的第一次：旧候选上的失败不算，也不算重跑', () => {
    const before = run({ run_id: 'r1', result: 'fail', findings: FAIL, candidate: OTHER })
    const after = run({ run_id: 'r2', result: 'pass', findings: [] })
    const data = input(step, [before, after])
    expect(evaluateStepAgents(data).pass).toBe(true)
    expect(projectStepAgents(data)[0]).toMatchObject({ reruns: 0, flipped: false, rerunReason: null })
  })

  it('最后一次是进行中 / 候选已变：仍按原规则（running / stale），不把旧结论当成新结论', () => {
    const running = run({ run_id: 'r2', status: 'running', result: null, findings: [] })
    expect(evaluateStepAgents(input(step, [first, running])).blockers).toEqual([{ kind: 'reviewer-running', agent: 'security', runId: 'r2' }])
    const stale = run({ run_id: 'r2', result: 'pass', candidate: OTHER })
    expect(evaluateStepAgents(input(step, [first, stale])).blockers).toEqual([{ kind: 'reviewer-stale', agent: 'security' }])
  })

  it('执行者不受影响；单次运行的评审者 reruns 为 0', () => {
    const builder = run({ agent: 'builder', role: 'executor', result: 'done' })
    const [view] = projectStepAgents(input({ executors: [executor('builder')] }, [builder, { ...builder, run_id: 'r2' }]))
    expect(view).toMatchObject({ reruns: 0, flipped: false })
    expect(projectStepAgents(input(step, [first]))[0]).toMatchObject({ reruns: 0, flipped: false })
  })

  it('一个评审者失败后换个提示重跑通过，不会把另一个评审者的记录混进来', () => {
    const other = run({ agent: 'quality', run_id: 'q1', result: 'pass' })
    const data = input({ reviewers: [reviewer('security'), reviewer('quality')] }, [first, other, flip])
    const views = projectStepAgents(data)
    expect(views.find((view) => view.agent === 'quality')).toMatchObject({ reruns: 0, result: 'pass' })
    expect(views.find((view) => view.agent === 'security')).toMatchObject({ reruns: 1, result: 'fail' })
  })
})

describe('剩余阻断：已接受且运行、候选都对得上的不通过不再阻断', () => {
  const FAIL = [{ severity: 'high' as const, location: 'a.ts:1', message: '越权' }]
  const failedRun = run({ run_id: 'r1', result: 'fail', findings: FAIL })
  const step = { reviewers: [reviewer('security', { blockAt: 'medium' })] }
  const accepted = [{ agent: 'security', runId: 'r1', candidate: CANDIDATE }]
  const withAccepted = (runs: readonly AgentRunRow[], list = accepted, candidate = CANDIDATE) =>
    evaluateStepAgents({ ...input(step, runs), candidate, accepted: list })

  it('没有接受记录时与以前一致：不通过就是阻断，结果里没有 accepted 键', () => {
    const result = evaluateStepAgents(input(step, [failedRun]))
    expect(result.pass).toBe(false)
    expect(result).not.toHaveProperty('accepted')
  })

  it('运行 id 与候选都对得上：放行，并在 accepted 里留一条提示（评审者、运行、发现数）', () => {
    const result = withAccepted([failedRun])
    expect(result.pass).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.accepted).toEqual([{ agent: 'security', runId: 'r1', candidate: CANDIDATE, findings: 1 }])
  })

  it('候选变了（代码变了）：评审者在新候选上重跑仍不通过，原来的接受不再生效', () => {
    const rerun = run({ run_id: 'r2', result: 'fail', findings: FAIL, candidate: OTHER })
    const result = withAccepted([failedRun, rerun], accepted, OTHER)
    expect(result.pass).toBe(false)
    expect(result.blockers).toEqual([expect.objectContaining({ kind: 'reviewer-failed', runId: 'r2', candidate: OTHER })])
    expect(result).not.toHaveProperty('accepted')
  })

  it('接受绑定的候选对不上当前候选：不放行（旧候选上的接受不能带到新候选）', () => {
    const result = withAccepted([failedRun], [{ agent: 'security', runId: 'r1', candidate: OTHER }])
    expect(result.pass).toBe(false)
  })

  it('同一候选上带 rerun_reason 重跑得到新运行：接受只对被接受的那次运行有效，新运行不通过要重新接受', () => {
    const rerun = run({ run_id: 'r2', result: 'fail', findings: FAIL, rerun_reason: '补充上下文后重跑' })
    const result = withAccepted([failedRun, rerun])
    expect(result.pass).toBe(false)
    expect(result.blockers).toEqual([expect.objectContaining({ kind: 'reviewer-failed', runId: 'r2' })])
    // 重新接受新运行后放行。
    expect(withAccepted([failedRun, rerun], [{ agent: 'security', runId: 'r2', candidate: CANDIDATE }]).pass).toBe(true)
  })

  it('接受绑定到评审者：别的评审者的接受不放行这一个', () => {
    expect(withAccepted([failedRun], [{ agent: 'quality', runId: 'r1', candidate: CANDIDATE }]).pass).toBe(false)
  })

  it('接受只覆盖「不通过」：缺失、过期、进行中、宿主不符的评审者照旧阻断', () => {
    expect(withAccepted([]).blockers).toEqual([{ kind: 'reviewer-missing', agent: 'security' }])
    expect(withAccepted([run({ run_id: 'r1', candidate: OTHER })]).blockers).toEqual([{ kind: 'reviewer-stale', agent: 'security' }])
    expect(withAccepted([run({ run_id: 'r1', status: 'running', result: null })]).blockers)
      .toEqual([{ kind: 'reviewer-running', agent: 'security', runId: 'r1' }])
  })

  it('执行者不受接受影响；通过的评审者即使有接受记录也不出提示', () => {
    const passing = run({ run_id: 'r1', result: 'pass', findings: [] })
    const result = withAccepted([passing])
    expect(result).toEqual({ pass: true, blockers: [] })
  })

  it('同一评审者同候选多次运行取最严：被接受的是判定所依据的那次，之后更轻的无原因重跑不改变它', () => {
    const milder = run({ run_id: 'r2', result: 'pass', findings: [] })
    const result = withAccepted([failedRun, milder])
    expect(result.pass).toBe(true)
    expect(result.accepted).toEqual([expect.objectContaining({ runId: 'r1' })])
  })
})
