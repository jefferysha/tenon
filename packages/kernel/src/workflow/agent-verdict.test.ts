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
      .toEqual([{ kind: 'executor-running', agent: 'b' }])
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
      .toEqual([{ kind: 'reviewer-running', agent: 'a' }])
    expect(evaluateStepAgents(input(step, [run({ agent: 'a', candidate: OTHER })])).blockers)
      .toEqual([{ kind: 'reviewer-stale', agent: 'a' }])
    const failing = [run({ agent: 'a', findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }] })]
    expect(evaluateStepAgents(input(step, failing)).blockers).toEqual([{
      kind: 'reviewer-failed', agent: 'a', blockAt: 'medium',
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
    expect(renderAgentBlocker({ kind: 'executor-running', agent: 'b' }, 'c'))
      .toBe("执行者 'b' 进行中；完成后：tenon agent record c <run>")
    expect(renderAgentBlocker({ kind: 'executor-failed', agent: 'b' }, 'c'))
      .toBe("执行者 'b' 失败；重跑：tenon agent prompt c b")
    expect(renderAgentBlocker({ kind: 'reviewer-missing', agent: 'a' }, 'c'))
      .toBe("评审者 'a' 未运行；运行：tenon agent next c")
    expect(renderAgentBlocker({ kind: 'reviewer-running', agent: 'a' }, 'c'))
      .toBe("评审者 'a' 进行中；完成后：tenon agent record c <run>")
    expect(renderAgentBlocker({ kind: 'reviewer-stale', agent: 'a' }, 'c'))
      .toBe("评审者 'a' 的结论已过期（候选已变化）；重跑：tenon agent prompt c a")
    expect(renderAgentBlocker({ kind: 'agent-records-invalid', reason: '第 2 行形状非法' }, 'c'))
      .toBe('agent 记录不可读：第 2 行形状非法')
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
