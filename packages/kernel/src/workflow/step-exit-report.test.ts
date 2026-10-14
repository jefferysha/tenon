import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureAgentFreeze } from '../state/agent-freeze.js'
import type { PipelineState } from '../types.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { evaluateStepExitReport, type StepExitReport } from './step-exit-report.js'
import type { StepDef, WorkflowDef } from './types.js'

const RUN_ID = 'run-1'

const step = (id: string, overrides: Partial<StepDef> = {}): StepDef => ({
  id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides,
})

const DEFINITION: WorkflowDef = {
  name: 'exit-report',
  steps: [
    step('spec', { transitions: [{ event: 'spec-done', to: 'build' }] }),
    step('build', {
      // TDD 归执行者 builder；frontend-design 是不归任何 agent 的主线技能。
      skills: [{ id: 'test-driven-development' }, { id: 'frontend-design' }],
      agents: { executors: [{ agent: 'builder' }], reviewers: [] },
      transitions: [{ event: 'build-done', to: 'verify' }, { event: 'requirements-changed', to: 'spec' }],
    }),
    step('verify', {
      skills: [{ id: 'verification-before-completion' }],
      transitions: [{ event: 'verify-pass', to: 'done' }, { event: 'verify-fail', to: 'build' }],
    }),
    step('done'),
  ],
}

const plan = compileEffectiveWorkflowPlan('exit-report', DEFINITION)
const pendingSlot = (token: string) => ({ token, invoked: false, pendingDocuments: [], done: false }) as const

let changeDir: string

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-exit-report-'))
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
    resolve: (name) => ({
      source: 'custom',
      content: [
        '---', `name: ${name}`, `description: ${name} 说明`, 'role: executor', 'skills: [test-driven-development]',
        'tools: [Read]', '---', '', '正文', '',
      ].join('\n'),
    }),
  })
}

function report(stepId: string, slots: readonly string[]): Promise<StepExitReport> {
  const state = { fields: { phase: stepId }, runMetadata: { runId: RUN_ID, transitionSequence: 2 } } as unknown as PipelineState
  return evaluateStepExitReport({
    repoRoot: changeDir,
    changeName: 'demo',
    changeDir,
    state,
    plan,
    guardCheck: () => ({ pass: true, failures: [] }),
    guardContext: {},
    fileContext: undefined,
    testEvidence: { context: undefined },
    skills: async () => ({ completedSkillIds: new Set(), slots: slots.map(pendingSlot) }),
    agentBlockers: async () => [],
  })
}

const skillSubjects = (exit: StepExitReport['exits'][number] | undefined): readonly (string | undefined)[] =>
  (exit?.blockers ?? []).filter((blocker) => blocker.source === 'skill').map((blocker) => blocker.subject)

describe('出口报告：退回边不要求归属 agent 的技能，与 transition 同口径', () => {
  it('build 的退回边只剩主线技能；前进边两个都要；报告级的未完成技能列表保持完整', async () => {
    await freeze()
    const result = await report('build', ['test-driven-development', 'frontend-design'])
    const back = result.exits.find((exit) => exit.event === 'requirements-changed')
    const forward = result.exits.find((exit) => exit.event === 'build-done')
    expect(back).toMatchObject({ direction: 'back', ready: false })
    expect(skillSubjects(back)).toEqual(['frontend-design'])
    expect(forward).toMatchObject({ direction: 'forward', ready: false })
    expect(skillSubjects(forward)).toEqual(['test-driven-development', 'frontend-design'])
    expect(result.skills.map((blocker) => blocker.subject)).toEqual(['test-driven-development', 'frontend-design'])
  })

  it('退回边上只欠 agent 的技能：出口就绪（ready: true），没有 skill 类阻断', async () => {
    await freeze()
    const result = await report('build', ['test-driven-development'])
    const back = result.exits.find((exit) => exit.event === 'requirements-changed')
    expect(back).toMatchObject({ ready: true, blockers: [] })
    expect(result.exits.find((exit) => exit.event === 'build-done')?.ready).toBe(false)
  })

  it('没有 agent 的步骤：退回边 verify-fail 仍要求主线技能', async () => {
    await freeze()
    const result = await report('verify', ['verification-before-completion'])
    const back = result.exits.find((exit) => exit.event === 'verify-fail')
    expect(back).toMatchObject({ direction: 'back', ready: false })
    expect(skillSubjects(back)).toEqual(['verification-before-completion'])
  })

  it('冻结读不到：退回边保持原有要求', async () => {
    const result = await report('build', ['test-driven-development'])
    const back = result.exits.find((exit) => exit.event === 'requirements-changed')
    expect(back).toMatchObject({ ready: false })
    expect(skillSubjects(back)).toEqual(['test-driven-development'])
  })
})
