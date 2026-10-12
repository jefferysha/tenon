import { describe, expect, test } from 'vitest'
import { compileEffectiveWorkflowPlan, parseWorkflow, type CompiledGuardConfig, type EffectiveWorkflowPlan } from '@tenon/kernel'
import { mockState } from '../test-support.js'
import { advancingExits, leaveGuards } from './exitGuards.js'

/** 一个步骤 s1 + 它的出边（YAML 片段）；s0 在它前面、s2 / s3 在它后面，三者都从 s0 可达（工作流校验要求）。 */
function planOf(stepGuards: string, transitions: string): EffectiveWorkflowPlan {
  const tail = (id: string): string => `  - id: ${id}
    label: ${id}
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
  const source = `name: exitguards
steps:
  - id: s0
    label: s0
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: s0-go
        to: s1
      - event: s0-skip-to-s2
        to: s2
      - event: s0-skip-to-s3
        to: s3
  - id: s1
    label: s1
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: ${stepGuards}
    transitions:${transitions}
${tail('s2')}${tail('s3')}`
  return compileEffectiveWorkflowPlan('exitguards', parseWorkflow(source))
}

const PASS = '          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n'
const NONEMPTY_PLAN = '          - type: field-nonempty\n            field: plan\n'

function guardsOf(plan: EffectiveWorkflowPlan): readonly CompiledGuardConfig[] {
  const step = plan.workflow.steps.find((candidate) => candidate.id === 's1')
  if (step === undefined) throw new Error('fixture: s1 missing')
  return leaveGuards(plan, step, mockState({ phase: 's1' }))
}

describe('advancingExits —— 前进出边', () => {
  test('回退边（目标更靠前）与放弃边（scope-expanded）不算前进出边，判定不按事件名写死回退边', () => {
    const plan = planOf('[]', `
      - event: s1-complete
        to: s2
      - event: s1-rework
        to: s0
      - event: scope-expanded
        to: s3`)
    const step = plan.workflow.steps.find((candidate) => candidate.id === 's1')
    if (step === undefined) throw new Error('fixture: s1 missing')
    expect(advancingExits(plan, step).map((edge) => edge.event)).toEqual(['s1-complete'])
  })

  test('回退边叫什么都一样：只看它指向的位置', () => {
    const plan = planOf('[]', `
      - event: whatever-name
        to: s0
      - event: requirements-changed
        to: s2`)
    const step = plan.workflow.steps.find((candidate) => candidate.id === 's1')
    if (step === undefined) throw new Error('fixture: s1 missing')
    expect(advancingExits(plan, step).map((edge) => edge.event)).toEqual(['requirements-changed'])
  })
})

describe('leaveGuards —— 步骤 guards ∪ 前进出边 guards', () => {
  test('一条前进边：它的 guards 与步骤自己的 guards 并在一起，同一条 guard 只留一份', () => {
    const plan = planOf(`\n${NONEMPTY_PLAN}`, `
      - event: s1-complete
        to: s2
        guards:
${PASS}${NONEMPTY_PLAN}`)
    expect(guardsOf(plan)).toEqual([
      { type: 'field-nonempty', field: 'plan' },
      { type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' },
    ])
  })

  test('回退边与放弃边上的 guards 不拦前进：修问题的路与放弃的路不属于「离开条件」', () => {
    const plan = planOf('[]', `
      - event: s1-complete
        to: s2
        guards:
${PASS}      - event: s1-rework
        to: s0
        guards:
${NONEMPTY_PLAN}      - event: scope-expanded
        to: s3
        guards:
          - type: not-afk-queued`)
    expect(guardsOf(plan)).toEqual([{ type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }])
  })

  test('分岔（多条前进边）是互斥的出路：只留各条边共有的条件，边专属的条件看那一条边', () => {
    const plan = planOf('[]', `
      - event: accept
        to: s2
        guards:
${PASS}${NONEMPTY_PLAN}      - event: reject
        to: s3
        guards:
          - type: field-equals
            field: pre_verify_review_result
            value: pending
${NONEMPTY_PLAN}`)
    // pre_verify_review_result 在两条边上要的值相反（pass / pending），同时要求它们永远过不了；共有的只有 plan 非空。
    expect(guardsOf(plan)).toEqual([{ type: 'field-nonempty', field: 'plan' }])
  })

  test('分岔里结构相同、键序不同的 guard 算同一条：只留一份，不因键序不同而丢掉共有条件', () => {
    const compiled = planOf('[]', `
      - event: accept
        to: s2
        guards:
${PASS}${NONEMPTY_PLAN}      - event: reject
        to: s3
        guards:
          - type: field-equals
            field: pre_verify_review_result
            value: pending
${NONEMPTY_PLAN}`)
    // 编译会把 YAML 里的 guard 归一成固定键序；键序不同的同构 guard 来自别的构造路径（生命周期补充、程序拼的计划），
    // 这里直接在编译后的 IR 上把 reject 边的 plan 非空守卫换成 field 在前。
    const plan: EffectiveWorkflowPlan = {
      ...compiled,
      workflow: {
        ...compiled.workflow,
        steps: compiled.workflow.steps.map((step) => step.id !== 's1' ? step : {
          ...step,
          transitions: step.transitions.map((transition) => transition.event !== 'reject' ? transition : {
            ...transition,
            guards: transition.guards.map((guard): CompiledGuardConfig =>
              guard.type === 'field-nonempty' ? { field: guard.field, type: guard.type } : guard),
          }),
        }),
      },
    }
    const reject = plan.workflow.steps.find((step) => step.id === 's1')?.transitions.find((edge) => edge.event === 'reject')
    expect(reject?.guards.map((guard) => Object.keys(guard))).toContainEqual(['field', 'type'])
    expect(guardsOf(plan)).toEqual([{ type: 'field-nonempty', field: 'plan' }])
  })

  test('没有前进出边的步骤只剩自己的 guards', () => {
    const plan = planOf(`\n${NONEMPTY_PLAN}`, `
      - event: s1-rework
        to: s0`)
    // 只有一条回退边，而别的步骤还有出路（s2 / s3 回不到 s1）：既没有前进出边，也不推导隐式完结边。
    const step = plan.workflow.steps.find((candidate) => candidate.id === 's1')
    if (step === undefined) throw new Error('fixture: s1 missing')
    expect(advancingExits(plan, step)).toEqual([])
    expect(guardsOf(plan)).toEqual([{ type: 'field-nonempty', field: 'plan' }])
  })
})
