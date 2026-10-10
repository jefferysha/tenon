import { describe, expect, it, vi } from 'vitest'
import type { PipelineState } from '../types.js'
import { builtinTrack } from '../tracks/builtins.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { StepDef } from './types.js'
import { rejectOnRoundsExhausted } from './transition-rounds-gate.js'
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

const DEFAULT_PLAN = compileEffectiveWorkflowPlan('default', undefined, builtinTrack('backend'))
const STATE = { fields: { phase: 'verify' }, opaqueTail: '' } as unknown as PipelineState

function gate(
  roundsOf: ((input: { stepId: string }) => Promise<StepRounds | null>) | undefined,
  over: Partial<{ plan: EffectiveWorkflowPlan; from: string; to: string; event: string }> = {},
) {
  return rejectOnRoundsExhausted({
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

describe('rejectOnRoundsExhausted：用完后回退边的转换被拒', () => {
  it('当前轮次 >= 上限的回退边被拒：点名步骤、事件、已用轮次、上限与来源', async () => {
    expect(await gate(async () => rounds(2))).toEqual({
      kind: 'rounds-exhausted', workflowName: 'rounds-gate', stepId: 'verify', event: 'verify-fail', current: 2, max: 2, source: 'workflow',
    })
    expect(await gate(async () => rounds(3, 2, 'task'))).toMatchObject({ kind: 'rounds-exhausted', current: 3, max: 2, source: 'task' })
  })

  it('未用完（当前轮次 < 上限）：放行，行为与没有上限时一致', async () => {
    expect(await gate(async () => rounds(1))).toBeUndefined()
    expect(await gate(async () => rounds(2, 3, 'task'))).toBeUndefined()
  })

  it('读取的是迁出的那一步：把步骤 id 交给 roundsOf', async () => {
    const roundsOf = vi.fn(async () => rounds(1))
    await gate(roundsOf)
    expect(roundsOf).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'verify', changeDir: '/repo/openspec/changes/demo', state: STATE, plan: CUSTOM }))
  })

  it('前进边永远不被它拒绝，也不去读轮次', async () => {
    const roundsOf = vi.fn(async () => rounds(5))
    expect(await gate(roundsOf, { to: 'ship', event: 'verify-pass' })).toBeUndefined()
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('放弃边（scope-expanded）永远可用', async () => {
    const roundsOf = vi.fn(async () => rounds(5))
    expect(await gate(roundsOf, { to: 'escalated', event: 'scope-expanded' })).toBeUndefined()
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('不受约束的步骤（没有评审门）：build 的 requirements-changed 始终可用，也不去读轮次', async () => {
    const roundsOf = vi.fn(async () => rounds(9))
    expect(await gate(roundsOf, { from: 'build', to: 'spec', event: 'requirements-changed' })).toBeUndefined()
    expect(roundsOf).not.toHaveBeenCalled()
  })

  it('宿主没接线（没有 roundsOf）或步骤不受约束（返回 null）：不拦', async () => {
    expect(await gate(undefined)).toBeUndefined()
    expect(await gate(async () => null)).toBeUndefined()
  })

  it('内置 default（phase-manifest）：verify-fail 用完后被拒，verify-pass 与 build 的 requirements-changed 不受影响', async () => {
    const base = { plan: DEFAULT_PLAN, workflowName: 'default' }
    expect(await gate(async () => rounds(2), { ...base, from: 'verify', to: 'build', event: 'verify-fail' }))
      .toMatchObject({ kind: 'rounds-exhausted', stepId: 'verify', event: 'verify-fail' })
    expect(await gate(async () => rounds(2), { ...base, from: 'verify', to: 'ship', event: 'verify-pass' })).toBeUndefined()
    expect(await gate(async () => rounds(9), { ...base, from: 'build', to: 'spec', event: 'requirements-changed' })).toBeUndefined()
  })
})
