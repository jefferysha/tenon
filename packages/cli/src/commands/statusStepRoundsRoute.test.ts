/**
 * 验证轮次用完后「回到规格」的真实路径：受约束步骤自己没有会让轮次清零的边（它声明的每条回退边都是它自己的回退目标，
 * 落到那里不会清零；用完后这些回退边也都被拒），所以要先经回退边回到回退目标，再在那一步上回到更早的步骤。
 */
import { describe, expect, test } from 'vitest'
import { compileEffectiveWorkflowPlan, currentRound, stepBackTargets, type StepDef } from '@tenon/kernel'
import { roundsRoute } from './statusStepRoundsRoute.js'

const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions']): StepDef => ({
  id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
})

const planOf = (name: string, steps: readonly StepDef[]) => compileEffectiveWorkflowPlan(name, { name, steps })

describe('roundsRoute：用完后 verify-fail 之后再回规格的路径', () => {
  test('内置 default：verify-fail 回 build，再在 build 上用 requirements-changed 回 spec', () => {
    expect(roundsRoute(compileEffectiveWorkflowPlan('default'), 'verify')).toEqual({
      back: { event: 'verify-fail', to: 'build' },
      reset: { event: 'requirements-changed', to: 'spec' },
      resettable: true,
    })
  })

  test('不受约束的步骤（build 没有评审门、spec 没有回退边）与不在计划里的步骤：null', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    expect(roundsRoute(plan, 'build')).toBeNull()
    expect(roundsRoute(plan, 'spec')).toBeNull()
    expect(roundsRoute(plan, 'nowhere')).toBeNull()
  })

  test('自定义计划：回退目标步骤上落到更早步骤的边按事件名点出来', () => {
    const plan = planOf('custom-route', [
      step('spec', 'review', [{ event: 'spec-done', to: 'build' }]),
      step('build', null, [{ event: 'build-done', to: 'verify' }, { event: 'replan', to: 'spec' }]),
      step('verify', 'review', [{ event: 'ok', to: 'ship' }, { event: 'redo', to: 'build' }]),
      step('ship', null, []),
    ])
    expect(roundsRoute(plan, 'verify')).toMatchObject({
      back: { event: 'redo', to: 'build' }, reset: { event: 'replan', to: 'spec' }, resettable: true,
    })
  })

  test('多个回退目标：挑回退目标步骤上有回更早步骤的边的那条回退边', () => {
    const plan = planOf('multi-route', [
      step('spec', null, [{ event: 'spec-done', to: 'design' }]),
      step('design', null, [{ event: 'design-done', to: 'build' }, { event: 'respec', to: 'spec' }]),
      step('build', null, [{ event: 'build-done', to: 'verify' }]),
      step('verify', 'review', [
        { event: 'ok', to: 'ship' },
        { event: 'redo-build', to: 'build' },
        { event: 'redo-design', to: 'design' },
      ]),
      step('ship', null, []),
    ])
    expect(roundsRoute(plan, 'verify')).toMatchObject({
      back: { event: 'redo-design', to: 'design' }, reset: { event: 'respec', to: 'spec' }, resettable: true,
    })
  })

  test('回退目标步骤上没有落到更早步骤的边，但工作流里有更早的步骤：不点名事件（reset 为 null），仍可回', () => {
    const plan = planOf('unnamed-route', [
      step('spec', 'review', [{ event: 'spec-done', to: 'build' }]),
      step('build', null, [{ event: 'build-done', to: 'verify' }]),
      step('verify', 'review', [{ event: 'ok', to: 'ship' }, { event: 'redo', to: 'build' }]),
      step('ship', null, []),
    ])
    expect(roundsRoute(plan, 'verify')).toEqual({
      back: { event: 'redo', to: 'build' }, reset: null, resettable: true,
    })
  })

  test('回退目标就是第一个步骤：没有更早的步骤可落，回规格这条路不存在', () => {
    const plan = planOf('first-route', [
      step('build', null, [{ event: 'build-done', to: 'verify' }]),
      step('verify', 'review', [{ event: 'ok', to: 'ship' }, { event: 'redo', to: 'build' }]),
      step('ship', null, []),
    ])
    expect(roundsRoute(plan, 'verify')).toEqual({
      back: { event: 'redo', to: 'build' }, reset: null, resettable: false,
    })
  })

  test('受约束步骤自己声明的回规格的边不算出路：它本身就是回退目标，落到那里轮次不清零，用完后它也被拒', () => {
    const plan = planOf('self-spec-route', [
      step('open', null, [{ event: 'open-done', to: 'spec' }]),
      step('spec', 'review', [{ event: 'spec-done', to: 'build' }]),
      step('build', null, [{ event: 'build-done', to: 'verify' }, { event: 'replan', to: 'spec' }]),
      step('verify', 'review', [
        { event: 'ok', to: 'ship' },
        { event: 'redo', to: 'build' },
        { event: 'rework-spec', to: 'spec' },
      ]),
      step('ship', null, []),
    ])
    // 自己声明的边是回退目标：落到 spec 不会清零（只有落到比所有回退目标更早的 open 才清零）。
    const targets = stepBackTargets(plan, 'verify')
    expect(targets).toEqual(['build', 'spec'])
    const ids = plan.workflow.steps.map((candidate) => candidate.id)
    const rounds = (via: readonly string[]) => currentRound({
      stepId: 'verify', steps: ids, backTargets: targets, runId: null,
      transitions: [{ to: 'verify' }, ...via.map((to) => ({ to })), { to: 'verify' }],
    })
    expect(rounds(['spec', 'build'])).toBe(2)
    // 点名的事件只会是回退目标步骤上的边，不会是 verify 自己的 rework-spec；这里没有落到 open 的边，所以不点名。
    const route = roundsRoute(plan, 'verify')
    expect(route?.back).toEqual({ event: 'redo', to: 'build' })
    expect(route?.reset).toBeNull()
  })
})
