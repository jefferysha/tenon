import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_RUN_META_FILE, AGENT_RUNS_FILE, appendAgentRunRow, compileEffectiveWorkflowPlan, ensureAgentFreeze,
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

  it('跨厂商评审：要求 codex 的评审登记成 claude → 视图 stale + wrongHost，阻断是 reviewer-wrong-host（不是过期）；codex 登记则通过', async () => {
    const hosted = compileEffectiveWorkflowPlan('hosted', {
      ...DEFINITION,
      steps: DEFINITION.steps.map((step) => step.id === 'verify'
        ? { ...step, agents: { executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'medium' as const, host: 'codex' as const }] } }
        : step),
    })
    await ensureAgentFreeze({
      changeDir, runId: RUN_ID, workflowFingerprint: hosted.workflowFingerprint, workflow: hosted.workflow,
      resolve: (name) => ({ source: 'custom', content: agentFile(name) }),
    })
    const project = () => projectAgentRuns({ changeDir, plan: hosted, state: state('verify'), phase: 'verify', candidate: async () => CANDIDATE })
    await ledger([row({ agent: 'security', host: 'claude', host_source: 'detected' })])
    const wrong = await project()
    expect(wrong.find((item) => item.stepId === 'verify')?.agents[0]).toMatchObject({
      state: 'stale', result: null, requiredHost: 'codex', host: 'claude', hostSource: 'detected', wrongHost: true, candidate: CANDIDATE,
    })
    expect(agentBlockersOf(wrong, hosted, 'verify')).toEqual([
      { kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: 'claude' },
    ])
    await ledger([row({ agent: 'security', host: 'codex', host_source: 'declared' })])
    const right = await project()
    expect(right.find((item) => item.stepId === 'verify')?.agents[0]).toMatchObject({
      state: 'done', result: 'pass', host: 'codex', hostSource: 'declared', wrongHost: false, candidate: CANDIDATE,
    })
    expect(agentBlockersOf(right, hosted, 'verify')).toEqual([])
  })

  it('已离开的步骤：视图展示真实绑定的候选，而不是"不判过期"用的占位值', async () => {
    await ledger([row({ agent: 'builder', role: 'executor', step: 'build', result: 'done' })])
    const runs = await projectAgentRuns({
      changeDir, plan, state: state('verify'), phase: 'verify', candidate: async () => `sha256:${'9'.repeat(64)}`,
    })
    expect(runs.find((item) => item.stepId === 'build')?.agents[0]).toMatchObject({ state: 'done', candidate: CANDIDATE })
  })

  it('执行者未运行时 build 步骤有一条阻断', async () => {
    const runs = await projectAgentRuns({ changeDir, plan, state: state('build'), phase: 'build' })
    expect(agentBlockersOf(runs, plan, 'build')).toEqual([{ kind: 'executor-missing', agent: 'builder' }])
  })
})

describe('宿主 / 宿主来源 / 重跑原因：v0.3 写在旁注里，Dashboard 读到的视图仍带着它们', () => {
  const hostedPlan = (): EffectiveWorkflowPlan => compileEffectiveWorkflowPlan('hosted', {
    ...DEFINITION,
    steps: DEFINITION.steps.map((step) => step.id === 'verify'
      ? { ...step, agents: { executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'medium' as const, host: 'codex' as const }] } }
      : step),
  })
  const freeze = async (hosted: EffectiveWorkflowPlan): Promise<void> => {
    await ensureAgentFreeze({
      changeDir, runId: RUN_ID, workflowFingerprint: hosted.workflowFingerprint, workflow: hosted.workflow,
      resolve: (name) => ({ source: 'custom', content: agentFile(name) }),
    })
  }
  const project = (hosted: EffectiveWorkflowPlan) =>
    projectAgentRuns({ changeDir, plan: hosted, state: state('verify'), phase: 'verify', candidate: async () => CANDIDATE })
  const verifyAgent = async (hosted: EffectiveWorkflowPlan) =>
    (await project(hosted)).find((item) => item.stepId === 'verify')?.agents[0]

  it('appendAgentRunRow 写下的旁注经 readAgentRuns 叠回行，投影出 host / hostSource / rerunReason；台账行本身不含这三项', async () => {
    const hosted = hostedPlan()
    await freeze(hosted)
    await appendAgentRunRow(changeDir, row({
      run_id: 'r-1', agent: 'security', host: 'codex', host_source: 'detected',
      findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }],
    }))
    await appendAgentRunRow(changeDir, row({
      run_id: 'r-2', agent: 'security', host: 'codex', host_source: 'declared', rerun_reason: '提示词缺上下文，补全后重跑',
      started_at: '2026-09-20T02:00:00Z', finished_at: '2026-09-20T02:10:00Z',
    }))

    const ledgerText = await readFile(join(changeDir, AGENT_RUNS_FILE), 'utf8')
    expect(ledgerText).not.toMatch(/"host"|"host_source"|"rerun_reason"/u)
    const metaText = await readFile(join(changeDir, AGENT_RUN_META_FILE), 'utf8')
    expect(metaText).toContain('"host_source":"declared"')
    expect(metaText).toContain('"rerun_reason":"提示词缺上下文，补全后重跑"')

    const view = await verifyAgent(hosted)
    expect(view).toMatchObject({
      state: 'done', result: 'pass', requiredHost: 'codex', wrongHost: false,
      host: 'codex', hostSource: 'declared', rerunReason: '提示词缺上下文，补全后重跑', reruns: 1, flipped: true, runId: 'r-2',
    })
    // 与 HTTP 快照同一条路：视图经 JSON 往返后三项仍在，Dashboard 的抽屉宿主行读的就是这些键。
    expect(JSON.parse(JSON.stringify(view))).toMatchObject({ host: 'codex', hostSource: 'declared', rerunReason: '提示词缺上下文，补全后重跑' })
  })

  it('旁注缺失（宿主读不出）：要求宿主的评审结论失效而不是放行', async () => {
    const hosted = hostedPlan()
    await freeze(hosted)
    await appendAgentRunRow(changeDir, row({ run_id: 'r-1', agent: 'security', host: 'codex', host_source: 'detected' }))
    expect(await verifyAgent(hosted)).toMatchObject({ state: 'done', result: 'pass', host: 'codex', wrongHost: false })

    await rm(join(changeDir, AGENT_RUN_META_FILE))
    const view = await verifyAgent(hosted)
    expect(view).toMatchObject({ state: 'stale', result: null, host: null, hostSource: null, wrongHost: true })
    expect(agentBlockersOf(await project(hosted), hosted, 'verify')).toEqual([
      { kind: 'reviewer-wrong-host', agent: 'security', required: 'codex', recorded: null },
    ])
  })
})
