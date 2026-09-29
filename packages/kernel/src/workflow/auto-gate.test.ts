import { describe, expect, it } from 'vitest'
import { builtinTrack } from '../tracks/builtins.js'
import { autoGateGuards, normalizeGate } from './auto-gate.js'
import { builtinWorkflow } from './builtin-workflows.js'
import { compileWorkflow } from './compile.js'
import { DEFAULT_WORKFLOW_SOURCE, DESIGN_SYSTEM_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanFromIr,
  effectiveWorkflowPlanFromSnapshot,
  workflowPlanSnapshot,
} from './effective-plan.js'
import { implicitCompletionTransition, isForwardStepEdge, stepExitTransitions } from './implicit-completion.js'
import type { StepIR, WorkflowIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import type { StepDef, WorkflowDef } from './types.js'

const PLAN_GUARD = [{ type: 'field-nonempty', field: 'plan' }]

function step(id: string, overrides: Partial<StepDef> = {}): StepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides }
}

/** draft → check → ship；check 有一个前进边、一个退回边、一个没人填的输出。 */
function flow(gate: StepDef['gate']): WorkflowDef {
  return {
    name: 'flow',
    steps: [
      step('draft', { gate: 'review', transitions: [{ event: 'draft-done', to: 'check' }] }),
      step('check', {
        gate,
        outputs: [{ field: 'plan', type: 'string' }],
        transitions: [{ event: 'check-pass', to: 'ship' }, { event: 'check-back', to: 'draft' }],
      }),
      step('ship', { gate: 'review' }),
    ],
  }
}

function guardsOf(ir: WorkflowIR, stepId: string, event: string) {
  return ir.steps.find((candidate) => candidate.id === stepId)?.transitions.find((transition) => transition.event === event)?.guards
}

describe('门禁 R7 · null 与 auto 同义', () => {
  it('归一：null 编译成 auto，review 保持；IR 里不再出现 null', () => {
    expect(normalizeGate(null)).toBe('auto')
    expect(normalizeGate('auto')).toBe('auto')
    expect(normalizeGate('review')).toBe('review')
    expect(compileWorkflow(flow(null)).steps.map((candidate) => candidate.gate)).toEqual(['review', 'auto', 'review'])
  })

  it('null 与显式 auto 编出逐字相同的 IR（含守卫），指纹也相同', () => {
    const viaNull = compileWorkflow(flow(null))
    const viaAuto = compileWorkflow(flow('auto'))
    expect(viaNull).toEqual(viaAuto)
    expect(compileEffectiveWorkflowPlan('flow', flow(null)).workflowFingerprint)
      .toBe(compileEffectiveWorkflowPlan('flow', flow('auto')).workflowFingerprint)
  })

  it('YAML 里缺省的 gate 与写 null 一样按 auto 编译', () => {
    const absent = compileWorkflow(parseWorkflow([
      'name: flow', 'steps:', '  - id: one', '    label: one', '    skills: []', '    inputs: []',
      '    outputs:', '      - field: plan', '        type: string', '    guards: []',
      '    transitions:', '      - event: go', '        to: two',
      '  - id: two', '    label: two', '    skills: []', '    inputs: []', '    outputs: []', '    guards: []', '    transitions: []', '',
    ].join('\n')))
    expect(absent.steps[0]?.gate).toBe('auto')
    expect(guardsOf(absent, 'one', 'go')).toEqual(PLAN_GUARD)
  })
})

describe('门禁 R7 · 输出齐全守卫只挂前进边', () => {
  for (const gate of [null, 'auto'] as const) {
    it(`gate=${String(gate)}：前进边有守卫，退回边（check-back）没有`, () => {
      const ir = compileWorkflow(flow(gate))
      expect(guardsOf(ir, 'check', 'check-pass')).toEqual(PLAN_GUARD)
      expect(guardsOf(ir, 'check', 'check-back')).toEqual([])
    })
  }

  it('显式守卫排在自动守卫之后；review 阶段任何一条边都不挂', () => {
    const def = flow('auto')
    const check = def.steps[1]
    if (check === undefined) throw new Error('fixture')
    const withExplicit: WorkflowDef = {
      ...def,
      steps: [def.steps[0]!, {
        ...check,
        transitions: [{ event: 'check-pass', to: 'ship', guards: [{ type: 'tasks-at-least', n: 1 }] }, { event: 'check-back', to: 'draft' }],
      }, def.steps[2]!],
    }
    expect(guardsOf(compileWorkflow(withExplicit), 'check', 'check-pass')).toEqual([...PLAN_GUARD, { type: 'tasks-at-least', n: 1 }])
    const reviewGate = compileWorkflow(flow('review'))
    expect(guardsOf(reviewGate, 'check', 'check-pass')).toEqual([])
    expect(guardsOf(reviewGate, 'check', 'check-back')).toEqual([])
  })

  it('轨道分支各按自己的步骤序判断前进 / 退回', () => {
    const ir = compileWorkflow({
      name: 'branched',
      steps: [],
      tracks: {
        alpha: { steps: flow(null).steps },
        beta: { steps: [flow(null).steps[1]!, flow(null).steps[0]!, flow(null).steps[2]!] },
      },
    })
    expect(guardsOf({ ...ir, steps: ir.tracks?.alpha?.steps ?? [] }, 'check', 'check-pass')).toEqual(PLAN_GUARD)
    // beta 里 check 排在 draft 前面：check-back（→ draft）成了前进边，check-pass（→ ship）依旧前进。
    const beta = { ...ir, steps: ir.tracks?.beta?.steps ?? [] }
    expect(guardsOf(beta, 'check', 'check-pass')).toEqual(PLAN_GUARD)
    expect(guardsOf(beta, 'check', 'check-back')).toEqual(PLAN_GUARD)
  })

  it('前进边判定：目标更靠后、或 archived 自边；退回、未知目标都不是', () => {
    const ids = ['a', 'b', 'c']
    expect(isForwardStepEdge(ids, 'a', 'c', 'go')).toBe(true)
    expect(isForwardStepEdge(ids, 'c', 'a', 'back')).toBe(false)
    expect(isForwardStepEdge(ids, 'b', 'b', 'stay')).toBe(false)
    expect(isForwardStepEdge(ids, 'c', 'c', 'archived')).toBe(true)
    expect(isForwardStepEdge(ids, 'a', 'zzz', 'go')).toBe(false)
  })

  it('引擎自己写的输出（build_sha / archived）不进检查，其余照检', () => {
    expect(autoGateGuards('build', [
      { field: 'build_sha', type: 'string' },
      { field: 'archived', type: 'boolean' },
      { field: 'pr_url', type: 'string' },
    ])).toEqual([{ type: 'field-nonempty', field: 'pr_url' }])
  })
})

describe('门禁 R7 · 完结边', () => {
  const LAST: WorkflowDef = {
    name: 'last',
    steps: [
      step('one', { gate: 'review', transitions: [{ event: 'one-done', to: 'two' }] }),
      step('two', { gate: null, outputs: [{ field: 'plan', type: 'string' }] }),
    ],
  }

  it('新编译：gate null 的末阶段完结边同样挂输出齐全守卫', () => {
    const plan = compileEffectiveWorkflowPlan('last', LAST)
    expect(implicitCompletionTransition(plan, 'two')?.guards).toEqual(PLAN_GUARD)
    expect(stepExitTransitions(plan, 'two').map((transition) => transition.event)).toEqual(['archived'])
  })
})

/** 旧的冻结计划：门禁 null、边上没有任何自动守卫。R7 之前编出来的 IR 就是这个形状。 */
function frozenLegacy(gate: 'auto' | null, guardedOnEveryEdge: boolean): WorkflowIR {
  const modern = compileWorkflow(flow(gate === null ? 'review' : gate))
  const steps: StepIR[] = modern.steps.map((candidate) => {
    if (candidate.id !== 'check') return candidate
    return {
      ...candidate,
      gate,
      transitions: candidate.transitions.map((transition) => ({
        ...transition,
        guards: guardedOnEveryEdge ? [...PLAN_GUARD.map((guard) => ({ ...guard })) as never[]] : [],
      })),
    }
  })
  return { ...modern, steps }
}

describe('门禁 R7 · 旧冻结计划保持记录的行为', () => {
  it('gate=null 的旧 IR 经快照往返后仍是 null、边上没有守卫，完结边也不多出守卫', () => {
    const legacy = frozenLegacy(null, false)
    const plan = effectiveWorkflowPlanFromIr('flow', legacy)
    const restored = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(plan))
    expect(restored.workflowFingerprint).toBe(plan.workflowFingerprint)
    const check = restored.workflow.steps.find((candidate) => candidate.id === 'check')
    expect(check?.gate).toBeNull()
    expect(check?.transitions.map((transition) => transition.guards)).toEqual([[], []])
    // 末阶段 gate=null 的旧计划：完结边保持无守卫。
    const lastLegacy: WorkflowIR = {
      ...legacy,
      steps: legacy.steps.map((candidate) => candidate.id === 'ship'
        ? { ...candidate, gate: null, outputs: [{ field: 'plan', type: 'string' as const }] }
        : candidate),
    }
    const lastPlan = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(effectiveWorkflowPlanFromIr('flow', lastLegacy)))
    expect(implicitCompletionTransition(lastPlan, 'ship')?.guards).toEqual([])
  })

  it('旧 auto 计划把守卫挂在每条出边上（含退回边），这是它记录的行为，快照往返后不变', () => {
    const legacy = frozenLegacy('auto', true)
    const plan = effectiveWorkflowPlanFromIr('flow', legacy)
    const restored = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(plan))
    expect(restored.workflowFingerprint).toBe(plan.workflowFingerprint)
    const check = restored.workflow.steps.find((candidate) => candidate.id === 'check')
    expect(check?.transitions.map((transition) => transition.guards)).toEqual([PLAN_GUARD, PLAN_GUARD])
  })

  it('新编译的计划与旧 null 计划指纹不同：新任务冻结新语义，旧任务读回旧字节', () => {
    const modern = compileEffectiveWorkflowPlan('flow', flow(null))
    const legacy = effectiveWorkflowPlanFromIr('flow', frozenLegacy(null, false))
    expect(modern.workflowFingerprint).not.toBe(legacy.workflowFingerprint)
  })
})

describe('门禁 R7 · 内建工作流', () => {
  function outputGuards(ir: { readonly steps: readonly StepIR[] }): string[] {
    return ir.steps.flatMap((candidate) => candidate.transitions
      .filter((transition) => transition.guards.length > 0)
      .map((transition) => `${candidate.id}:${transition.event}`))
  }

  it('simple：四个阶段都没有输出，null 归一成 auto 后不多出任何守卫', () => {
    const simple = builtinWorkflow('simple')
    if (simple === null) throw new Error('simple missing')
    const ir = compileWorkflow(simple)
    expect(ir.steps.map((candidate) => candidate.gate)).toEqual(['auto', 'auto', 'auto', 'auto'])
    expect(outputGuards(ir)).toEqual([])
    const plan = compileEffectiveWorkflowPlan('simple', simple)
    for (const candidate of plan.workflow.steps) expect(implicitCompletionTransition(plan, candidate.id)).toBeUndefined()
  })

  it('design-system：direction / review 是 review，generate 是 auto 且没有输出', () => {
    const ir = compileWorkflow(parseWorkflow(DESIGN_SYSTEM_WORKFLOW_SOURCE))
    expect(ir.steps.map((candidate) => [candidate.id, candidate.gate])).toEqual([['direction', 'review'], ['generate', 'auto'], ['review', 'review']])
    expect(outputGuards(ir)).toEqual([])
  })

  it('default 各轨道：只有 review 与 auto 两种；完结边没有多余守卫；build_sha / archived 不进检查', () => {
    const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    for (const track of ['chat', 'pm', 'frontend', 'backend', 'free'] as const) {
      const plan = compileEffectiveWorkflowPlan('default', def, builtinTrack(track))
      expect(plan.workflow.steps.map((candidate) => candidate.gate).every((gate) => gate === 'review' || gate === 'auto')).toBe(true)
      const build = plan.workflow.steps.find((candidate) => candidate.id === 'build')
      expect(build?.transitions.find((transition) => transition.event === 'build-complete')?.guards).toEqual([])
      expect(implicitCompletionTransition(plan, 'archive')?.guards).toEqual([])
      const ship = plan.workflow.steps.find((candidate) => candidate.id === 'ship')
      const shipOutputs = (ship?.outputs ?? []).map((output) => output.field)
      const shipGuards = ship?.transitions.find((transition) => transition.event === 'ship-complete')?.guards ?? []
      expect(shipGuards.map((guard) => 'field' in guard ? guard.field : null)).toEqual(shipOutputs)
    }
  })
})
