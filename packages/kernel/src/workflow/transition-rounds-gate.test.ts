import { describe, expect, it, vi } from 'vitest'
import type { PipelineState } from '../types.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { StepDef } from './types.js'
import { backEdgeRounds } from './transition-rounds-gate.js'
import type { StepRounds } from './step-rounds-read.js'

const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions'], maxRounds?: number): StepDef => ({
  id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
  ...(maxRounds === undefined ? {} : { maxRounds }),
})

/** 自定义工作流：build 没有评审门（有 requirements-changed 回退边），verify 是评审门（verify-fail 回退）。 */
const CUSTOM: EffectiveWorkflowPlan = compileEffectiveWorkflowPlan('rounds-gate', {
  name: 'rounds-gate',
  steps: [
    step('spec', 'review', [{ event: 'spec-complete', to: 'build' }]),
    step('build', null, [
      { event: 'build-complete', to: 'verify' },
      { event: 'requirements-changed', to: 'spec' },
    ]),
    step('verify', 'review', [
      { event: 'verify-pass', to: 'ship' },
      { event: 'verify-fail', to: 'build' },
    ], 2),
    step('ship', null, []),
  ],
})

const DEFAULT_PLAN = compileEffectiveWorkflowPlan('default', undefined, { track: 'backend', executionModel: 'phase-manifest' })
const STATE = { fields: { phase: 'verify' }, opaqueTail: '' } as unknown as PipelineState

function gate(
  roundsOf: ((input: { stepId: string }) => Promise<StepRounds | null>) | undefined,
  over: Partial<{ plan: EffectiveWorkflowPlan; from: string; to: string; event: string }> = {},
) {
  return backEdgeRounds({
    deps: { roundsOf: roundsOf as never },
    changeDir: '/repo/openspec/changes/demo',
    workflowName: 'rounds-gate',
    plan: CUSTOM,
    state: STATE,
    from: 'verify',
    to: 'build',
    event: 'verify-fail',
    ...over,
  })
}

const rounds = (current: number, max = 2, source: StepRounds['source'] = 'workflow'): StepRounds => ({ current, max, source })

describe('backEdgeRounds：受约束步骤上回退边的轮次结论（不受约束 / 轮次内 / 已用完）', () => {
  it('当前轮次 >= 上限的回退边是 exhausted：rejection 点名步骤、事件、已用轮次、上限与来源', async () => {
    expect(await gate(async () => rounds(2))).toEqual({
      kind: 'exhausted',
      rejection: {
        kind: 'rounds-exhausted', workflowName: 'rounds-gate', stepId: 'verify', event: 'verify-fail', current: 2, max: 2, source: 'workflow',
      },
    })
    expect(await gate(async () => rounds(3, 2, 'task'))).toMatchObject({
      kind: 'exhausted', rejection: { kind: 'rounds-exhausted', current: 3, max: 2, source: 'task' },
    })
  })

  it('未用完（当前轮次 < 上限）：within-budget，调用方据此免评审回执', async () => {
    expect(await gate(async () => rounds(1))).toEqual({ kind: 'within-budget' })
    expect(await gate(async () => rounds(2, 3, 'task'))).toEqual({ kind: 'within-budget' })
  })

  it('读取的是迁出的那一步：把步骤 id 交给 roundsOf', async () => {
    const roundsOf = vi.fn(async () => rounds(1))
    await gate(roundsOf)
    expect(roundsOf).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'verify', changeDir: '/repo/openspec/changes/demo', state: STATE, plan: CUSTOM }))
  })

  it('前进边永远是 not-limited，也不去读轮次', async () => {
    const roundsOf = vi.fn(async () => rounds(5))
    expect(await gate(roundsOf, { to: 'ship', event: 'verify-pass' })).toEqual({ kind: 'not-limited' })
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('放弃边（scope-expanded）永远是 not-limited', async () => {
    const roundsOf = vi.fn(async () => rounds(5))
    expect(await gate(roundsOf, { to: 'escalated', event: 'scope-expanded' })).toEqual({ kind: 'not-limited' })
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('不受约束的步骤（没有评审门）：build 的 requirements-changed 是 not-limited，也不去读轮次', async () => {
    const roundsOf = vi.fn(async () => rounds(9))
    expect(await gate(roundsOf, { from: 'build', to: 'spec', event: 'requirements-changed' })).toEqual({ kind: 'not-limited' })
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('宿主没接线（没有 roundsOf）或步骤不受约束（返回 null）：not-limited，不免回执也不拦', async () => {
    expect(await gate(undefined)).toEqual({ kind: 'not-limited' })
    expect(await gate(async () => null)).toEqual({ kind: 'not-limited' })
  })

  it('内置 default（phase-manifest）：verify-fail 轮次内是 within-budget、用完是 exhausted，verify-pass 与 build 的 requirements-changed 不受影响', async () => {
    const base = { plan: DEFAULT_PLAN, workflowName: 'default' }
    expect(await gate(async () => rounds(1), { ...base, from: 'verify', to: 'build', event: 'verify-fail' }))
      .toEqual({ kind: 'within-budget' })
    expect(await gate(async () => rounds(2), { ...base, from: 'verify', to: 'build', event: 'verify-fail' }))
      .toMatchObject({ kind: 'exhausted', rejection: { kind: 'rounds-exhausted', stepId: 'verify', event: 'verify-fail' } })
    expect(await gate(async () => rounds(2), { ...base, from: 'verify', to: 'ship', event: 'verify-pass' })).toEqual({ kind: 'not-limited' })
    expect(await gate(async () => rounds(9), { ...base, from: 'build', to: 'spec', event: 'requirements-changed' })).toEqual({ kind: 'not-limited' })
  })
})
