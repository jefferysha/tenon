import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileEffectiveWorkflowPlan,
  workflowPlanSnapshot,
  type PipelineState,
} from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { makeDeps, mockState } from '../test-support.js'
import { cmdWorkflowPlan } from './workflow-plan.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function stateWithSnapshot(
  workflow: string,
  phase: string,
  snapshot: ReturnType<typeof workflowPlanSnapshot>,
): PipelineState {
  return {
    ...mockState({ workflow, phase, track: 'free' }),
    runMetadata: {
      runId: 'run-1',
      transitionSequence: 0,
      workflowPlanFingerprint: snapshot.workflowFingerprint,
      workflowPlanSnapshot: snapshot,
    },
  }
}

describe('workflow plan —— Agent 使用冻结的运行计划而非可变项目 YAML', () => {
  test('自定义 workflow 初始化后即使 YAML 被修改，仍返回该 Change 的冻结步骤和 Skill DAG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-workflow-plan-'))
    roots.push(root)
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    const original = compileEffectiveWorkflowPlan('review-flow', {
      name: 'review-flow',
      steps: [
        {
          id: 'draft',
          label: '起草',
          gate: null,
          skills: [{ id: 'writing-plans' }],
          inputs: [],
          outputs: [],
          guards: [],
          transitions: [{ event: 'draft-complete', to: 'done' }],
        },
        {
          id: 'done',
          label: '完成',
          gate: null,
          skills: [{ id: 'verification-before-completion' }],
          inputs: [],
          outputs: [],
          guards: [],
          transitions: [],
        },
      ],
    })
    const snapshot = workflowPlanSnapshot(original)
    await writeFile(
      join(root, '.pipeline', 'workflows', 'review-flow.yaml'),
      'name: review-flow\nsteps:\n  - id: replacement\n    label: 已替换\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions: []\n',
      'utf8',
    )
    const deps = makeDeps({
      cwd: root,
      state: stateWithSnapshot('review-flow', 'draft', snapshot),
    })

    expect(await cmdWorkflowPlan(deps, 'demo', { json: true })).toBe(0)
    const result = JSON.parse(deps.outLines[0]!) as {
      source: string
      current_step: string
      plan: { workflow: { steps: Array<{ id: string; skills: Array<{ id: string }> }> } }
    }
    expect(result.source).toBe('frozen-snapshot')
    expect(result.current_step).toBe('draft')
    expect(result.plan.workflow.steps.map((step) => step.id)).toEqual(['draft', 'done'])
    expect(result.plan.workflow.steps[0]?.skills.map((skill) => skill.id)).toEqual(['writing-plans'])
  })

  test('冻结快照存在时，项目 YAML 被删除也仍可恢复并输出完整计划', async () => {
    const plan = compileEffectiveWorkflowPlan('short-flow', {
      name: 'short-flow',
      steps: [{
        id: 'change',
        label: '修改',
        gate: null,
        skills: [{ id: 'simple-task' }],
        inputs: [],
        outputs: [],
        guards: [],
        transitions: [],
      }],
    })
    const deps = makeDeps({
      state: stateWithSnapshot('short-flow', 'change', workflowPlanSnapshot(plan)),
    })

    expect(await cmdWorkflowPlan(deps, 'demo', { json: true })).toBe(0)
    expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
      change: 'demo',
      source: 'frozen-snapshot',
      current_step: 'change',
      plan: {
        id: 'short-flow',
        workflow: {
          steps: [{ id: 'change', skills: [{ id: 'simple-task' }] }],
        },
      },
    })
  })

  test('没有前进出口的 step 暴露 completion_event；有前进出边或运行已归档时不暴露', async () => {
    const plan = compileEffectiveWorkflowPlan('ui-built', {
      name: 'ui-built',
      steps: [
        {
          id: 'build', label: '实现', gate: 'auto', skills: [], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'build-complete', to: 'verify' }],
        },
        {
          id: 'verify', label: '验证', gate: 'review', skills: [], inputs: [], outputs: [], guards: [],
          transitions: [{ event: 'verify-back', to: 'build' }],
        },
      ],
    })
    const snapshot = workflowPlanSnapshot(plan)
    const open = makeDeps({ state: stateWithSnapshot('ui-built', 'verify', snapshot) })
    expect(await cmdWorkflowPlan(open, 'demo', { json: true })).toBe(0)
    const steps = (JSON.parse(open.outLines[0]!) as {
      plan: { workflow: { steps: Array<{ id: string; completion_event?: string; transitions: unknown[] }> } }
    }).plan.workflow.steps
    expect(steps.map((candidate) => [candidate.id, candidate.completion_event])).toEqual([
      ['build', undefined],
      ['verify', 'archived'],
    ])
    // The declared edges stay exactly as frozen; completion is exposed beside them, not inside them.
    expect(steps[1]?.transitions).toEqual([{ event: 'verify-back', to: 'build', guards: [], actions: [] }])

    const human = makeDeps({ state: stateWithSnapshot('ui-built', 'verify', snapshot) })
    expect(await cmdWorkflowPlan(human, 'demo', {})).toBe(0)
    expect(human.outLines.find((line) => line.includes(' verify '))).toContain('completion: archived')

    const archivedState = stateWithSnapshot('ui-built', 'verify', snapshot)
    const archived = makeDeps({
      state: { ...archivedState, fields: { ...archivedState.fields, archived: 'true' } },
    })
    expect(await cmdWorkflowPlan(archived, 'demo', { json: true })).toBe(0)
    expect(JSON.stringify(JSON.parse(archived.outLines[0]!))).not.toContain('completion_event')
  })

  test('人读输出每步列出输入、输出、测试与 agents（空的不写），与 --json 同一份计划', async () => {
    const plan = compileEffectiveWorkflowPlan('io-flow', {
      name: 'io-flow',
      steps: [
        {
          id: 'build', label: '实现', gate: 'auto', skills: [{ id: 'writing-plans' }],
          inputs: [], outputs: [{ field: 'plan', type: 'file_path' }], guards: [],
          tests: [
            { id: 'unit', direction: 'unit', command: 'npm test', required: true },
            { id: 'bench', direction: 'benchmark', command: 'npm run bench', required: false },
          ],
          agents: { executors: [{ agent: 'builder' }], reviewers: [] },
          transitions: [{ event: 'build-complete', to: 'verify' }],
        },
        {
          id: 'verify', label: '验证', gate: 'review', skills: [],
          inputs: [{ field: 'plan', type: 'file_path' }], outputs: [], guards: [],
          agents: {
            executors: [],
            reviewers: [
              { agent: 'security', required: true, block_at: 'high' },
              { agent: 'architecture', required: false, block_at: 'medium' },
            ],
          },
          transitions: [],
        },
      ],
    })
    const deps = makeDeps({ state: stateWithSnapshot('io-flow', 'build', workflowPlanSnapshot(plan)) })
    expect(await cmdWorkflowPlan(deps, 'demo', {})).toBe(0)
    const body = deps.outLines.slice(deps.outLines.findIndex((line) => line.startsWith('01 ')))
    expect(body).toEqual([
      '01 build | 实现 | skills: writing-plans',
      '     outputs: plan(file_path)',
      '     tests: unit, bench(可选)',
      '     executors: builder',
      '02 verify | 验证 | skills: - | completion: archived',
      '     inputs: plan(file_path)',
      '     reviewers: security(block_at=high), architecture(参考, block_at=medium)',
    ])
  })
})
