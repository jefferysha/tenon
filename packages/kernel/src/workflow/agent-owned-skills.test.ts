import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureAgentFreeze, readFrozenAgents, FROZEN_DIR, FROZEN_LOCK_FILE } from '../state/agent-freeze.js'
import type { PipelineState } from '../types.js'
import { agentOwnedSkills, readAgentOwnedSkills, skillsExemptOnExit } from './agent-owned-skills.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { StepDef, WorkflowDef } from './types.js'

const RUN_ID = 'run-1'

const step = (id: string, overrides: Partial<StepDef> = {}): StepDef => ({
  id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides,
})

const DEFINITION: WorkflowDef = {
  name: 'owned',
  steps: [
    step('spec', { transitions: [{ event: 'spec-done', to: 'build' }] }),
    step('build', {
      skills: [{ id: 'test-driven-development' }, { id: 'frontend-design' }],
      agents: {
        executors: [{ agent: 'builder' }],
        reviewers: [{ agent: 'security', required: true, block_at: 'medium' }],
      },
      transitions: [{ event: 'build-done', to: 'verify' }, { event: 'requirements-changed', to: 'spec' }],
    }),
    step('verify', {
      skills: [{ id: 'verification-before-completion' }],
      agents: { executors: [], reviewers: [{ agent: 'code-size', required: true, block_at: 'medium' }] },
      transitions: [{ event: 'verify-pass', to: 'done' }, { event: 'verify-fail', to: 'build' }],
    }),
    step('done'),
  ],
}

const SKILLS: Readonly<Record<string, readonly string[]>> = {
  builder: ['test-driven-development'],
  security: ['security-review'],
  'code-size': ['size-check'],
}

const agentFile = (name: string): string => [
  '---', `name: ${name}`, `description: ${name} 说明`, `role: ${name === 'builder' ? 'executor' : 'reviewer'}`,
  `skills: [${(SKILLS[name] ?? []).join(', ')}]`, 'tools: [Read]', '---', '', '正文', '',
].join('\n')

const plan = compileEffectiveWorkflowPlan('owned', DEFINITION)
/** `runId` 为 null = 状态里没有 run 身份（旧任务）。 */
const state = (phase: string, runId: string | null = RUN_ID): PipelineState => ({
  fields: { phase },
  ...(runId === null ? {} : { runMetadata: { runId, transitionSequence: 3 } }),
}) as unknown as PipelineState

let changeDir: string

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-agent-owned-'))
})

afterEach(async () => {
  await rm(changeDir, { recursive: true, force: true })
})

async function freeze(): Promise<void> {
  await ensureAgentFreeze({
    changeDir,
    runId: RUN_ID,
    workflowFingerprint: plan.workflowFingerprint,
    workflow: plan.workflow,
    resolve: (name) => ({ source: 'custom', content: agentFile(name) }),
  })
}

const frozenAgents = () => readFrozenAgents({ changeDir, runId: RUN_ID, workflowFingerprint: plan.workflowFingerprint })

describe('agentOwnedSkills：本步声明的 agent 的技能并集', () => {
  it('执行者与评审者的 skills 并在一起；没有 agent 的技能（主线技能）不在里面', async () => {
    await freeze()
    const owned = agentOwnedSkills({ plan, stepId: 'build', frozen: await frozenAgents() })
    expect([...owned].sort()).toEqual(['security-review', 'test-driven-development'])
    expect(owned.has('frontend-design')).toBe(false)
  })

  it('只看本步声明的 agent：别的步骤的 agent 的技能不算', async () => {
    await freeze()
    const frozen = await frozenAgents()
    expect([...agentOwnedSkills({ plan, stepId: 'verify', frozen })]).toEqual(['size-check'])
    expect(agentOwnedSkills({ plan, stepId: 'build', frozen }).has('size-check')).toBe(false)
  })

  it('步骤没有声明任何 agent、或根本不在计划里：空集', async () => {
    await freeze()
    const frozen = await frozenAgents()
    expect(agentOwnedSkills({ plan, stepId: 'spec', frozen }).size).toBe(0)
    expect(agentOwnedSkills({ plan, stepId: 'nowhere', frozen }).size).toBe(0)
  })

  it('声明了但冻结里没有的 agent 被忽略，不抛错', async () => {
    await freeze()
    const frozen = new Map([...(await frozenAgents())].filter(([name]) => name !== 'security'))
    expect([...agentOwnedSkills({ plan, stepId: 'build', frozen })]).toEqual(['test-driven-development'])
  })
})

describe('readAgentOwnedSkills：读冻结内容后求并集，读不到时不豁免任何技能', () => {
  it('冻结齐全：与 agentOwnedSkills 一致', async () => {
    await freeze()
    const owned = await readAgentOwnedSkills({ changeDir, plan, state: state('build'), stepId: 'build' })
    expect([...owned].sort()).toEqual(['security-review', 'test-driven-development'])
  })

  const unreadable: ReadonlyArray<{
    readonly label: string
    readonly prepare: () => Promise<void>
    readonly current: PipelineState
  }> = [
    { label: '任务没有冻结目录', prepare: async () => {}, current: state('build') },
    { label: '状态里没有 run 身份', prepare: freeze, current: state('build', null) },
    { label: '冻结绑定的 run 与当前不同', prepare: freeze, current: state('build', 'another-run') },
    {
      label: '冻结锁损坏',
      prepare: async () => {
        await freeze()
        await writeFile(join(changeDir, FROZEN_DIR, FROZEN_LOCK_FILE), '{not json', 'utf8')
      },
      current: state('build'),
    },
  ]
  for (const { label, prepare, current } of unreadable) {
    it(`${label}：返回空集（保持原有要求，不因读失败多豁免）`, async () => {
      await prepare()
      expect((await readAgentOwnedSkills({ changeDir, plan, state: current, stepId: 'build' })).size).toBe(0)
    })
  }

  it('步骤没有声明 agent：空集，也不需要冻结目录', async () => {
    expect((await readAgentOwnedSkills({ changeDir, plan, state: state('spec'), stepId: 'spec' })).size).toBe(0)
  })
})

describe('skillsExemptOnExit：只有退回边豁免归属 agent 的技能', () => {
  const exempt = (to: string, event: string, current: PipelineState = state('build')) =>
    skillsExemptOnExit({ changeDir, plan, state: current, stepId: 'build', to, event })

  it('前进边：空集（行为不变）', async () => {
    await freeze()
    expect((await exempt('verify', 'build-done')).size).toBe(0)
  })

  it('退回边：本步 agent 的技能，主线技能不在其中', async () => {
    await freeze()
    const owned = await exempt('spec', 'requirements-changed')
    expect([...owned].sort()).toEqual(['security-review', 'test-driven-development'])
    expect(owned.has('frontend-design')).toBe(false)
  })

  it('退回边但冻结读不到：空集', async () => {
    expect((await exempt('spec', 'requirements-changed')).size).toBe(0)
  })
})
