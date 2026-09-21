import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_RUNS_FILE, compileEffectiveWorkflowPlan, ensureAgentFreeze,
  type AgentRunRow, type EffectiveWorkflowPlan, type PipelineState, type WorkflowDef,
} from '@tenon/kernel'
import { agentBlockersOf, projectAgentRuns } from './agentRuns.js'

const RUN_ID = 'run-1'
const CANDIDATE = `sha256:${'1'.repeat(64)}`
const ACTOR = { id: 'a@x.com', name: 'A', trust: 'declared' } as const

const DEFINITION: WorkflowDef = {
  name: 'reviewed',
  steps: [
    {
      id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'go', to: 'verify' }],
      agents: { executors: [{ agent: 'builder' }], reviewers: [] },
    },
    {
      id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [],
      agents: {
        executors: [],
        reviewers: [{ agent: 'security', required: true, block_at: 'medium' }],
      },
    },
  ],
}

function row(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    schema: 'agent-run/v1',
    run_id: `r-${overrides.agent ?? 'x'}`,
    agent: 'security',
    agent_digest: `sha256:${'0'.repeat(64)}`,
    role: 'reviewer',
    step: 'verify',
    step_visit: '["run-1",7]',
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

const state = (phase: string): PipelineState => ({
  fields: { phase },
  runMetadata: { runId: RUN_ID, transitionSequence: 7 },
} as unknown as PipelineState)

let changeDir: string
let plan: EffectiveWorkflowPlan

const agentFile = (name: string): string =>
  ['---', `name: ${name}`, `description: ${name} 说明`, 'tools: [Read]', '---', '', '正文', ''].join('\n')

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-server-agent-runs-'))
  plan = compileEffectiveWorkflowPlan('reviewed', DEFINITION)
  await ensureAgentFreeze({
    changeDir,
    runId: RUN_ID,
    workflowFingerprint: plan.workflowFingerprint,
    workflow: plan.workflow,
    resolve: (name) => ({ source: 'custom', content: agentFile(name) }),
  })
})

afterEach(async () => {
  await rm(changeDir, { recursive: true, force: true })
})

async function ledger(rows: readonly AgentRunRow[]): Promise<void> {
  await writeFile(join(changeDir, AGENT_RUNS_FILE), rows.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8')
}

describe('projectAgentRuns', () => {
  it('没有声明 agent 的工作流投影为空', async () => {
    const bare = compileEffectiveWorkflowPlan('bare', {
      name: 'bare',
      steps: [{ id: 's1', label: 'S', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    })
    expect(await projectAgentRuns({ changeDir, plan: bare, state: state('s1'), phase: 's1' })).toEqual([])
  })

  it('当前步骤按台账判定，更晚的步骤一律未运行', async () => {
    await ledger([row({ agent: 'builder', role: 'executor', step: 'build', result: 'done' })])
    const runs = await projectAgentRuns({
      changeDir, plan, state: state('build'), phase: 'build', candidate: async () => CANDIDATE,
    })
    expect(runs.find((item) => item.stepId === 'build')?.agents[0])
      .toMatchObject({ agent: 'builder', state: 'done', result: 'done' })
    expect(runs.find((item) => item.stepId === 'verify')?.agents[0])
      .toMatchObject({ agent: 'security', state: 'idle' })
  })

  it('更早的步骤展示上次访问的结论且不判过期', async () => {
    await ledger([row({ agent: 'builder', role: 'executor', step: 'build', result: 'done' })])
    const runs = await projectAgentRuns({
      changeDir, plan, state: state('verify'), phase: 'verify', candidate: async () => `sha256:${'9'.repeat(64)}`,
    })
    expect(runs.find((item) => item.stepId === 'build')?.agents[0])
      .toMatchObject({ state: 'done', result: 'done' })
  })

  it('候选变化让当前步骤的评审结论显示为过期', async () => {
    await ledger([row({ agent: 'security' })])
    const runs = await projectAgentRuns({
      changeDir, plan, state: state('verify'), phase: 'verify', candidate: async () => `sha256:${'9'.repeat(64)}`,
    })
    expect(runs.find((item) => item.stepId === 'verify')?.agents[0]?.state).toBe('stale')
  })

  it('冻结内容被改动 → 空投影（工作台只读，不因此挡住任何操作）', async () => {
    await writeFile(join(changeDir, '.pipeline-frozen', 'agents', 'security.md'), agentFile('security').replace('说明', '篡改'), 'utf8')
    const runs = await projectAgentRuns({ changeDir, plan, state: state('verify'), phase: 'verify' })
    expect(runs.every((item) => item.agents.every((agent) => agent.state === 'idle'))).toBe(true)
  })
})

describe('agentBlockersOf', () => {
  it('必需评审者未运行 / 不通过各自成一条；参考评审者不拦', async () => {
    await ledger([row({ agent: 'security', findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }] })])
    const runs = await projectAgentRuns({
      changeDir, plan, state: state('verify'), phase: 'verify', candidate: async () => CANDIDATE,
    })
    expect(agentBlockersOf(runs, plan, 'verify')).toEqual([
      { kind: 'reviewer-failed', agent: 'security', blockAt: 'medium', blocking: [] },
    ])
    expect(agentBlockersOf([], plan, 'verify')).toEqual([])
  })

  it('执行者未运行时 build 步骤有一条阻断', async () => {
    const runs = await projectAgentRuns({ changeDir, plan, state: state('build'), phase: 'build' })
    expect(agentBlockersOf(runs, plan, 'build')).toEqual([{ kind: 'executor-missing', agent: 'builder' }])
  })
})
