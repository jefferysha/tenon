import { describe, expect, it } from 'vitest'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import {
  currentRound,
  DEFAULT_MAX_ROUNDS,
  effectiveMaxRounds,
  isRoundsLimited,
  isValidMaxRounds,
  resolveMaxRounds,
  stepBackTargets,
} from './step-rounds.js'
import type { StepDef } from './types.js'

const step = (id: string, gate: StepDef['gate'], transitions: StepDef['transitions']): StepDef => ({
  id, label: id, gate, skills: [], inputs: [], outputs: [], guards: [], transitions,
})

/** spec → build → verify → ship；build 可回 spec，verify 可回 build。 */
function defaultShapedPlan() {
  return compileEffectiveWorkflowPlan('rounds-shape', {
    name: 'rounds-shape',
    steps: [
      step('spec', 'review', [{ event: 'spec-complete', to: 'build' }]),
      step('build', null, [
        { event: 'build-complete', to: 'verify' },
        { event: 'requirements-changed', to: 'spec' },
      ]),
      step('verify', 'review', [
        { event: 'verify-pass', to: 'ship' },
        { event: 'verify-fail', to: 'build' },
      ]),
      step('ship', null, []),
    ],
  })
}

describe('effectiveMaxRounds', () => {
  it('内置默认值是 2', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(2)
  })

  it('步骤声明了 maxRounds：取声明值，来源 workflow', () => {
    expect(effectiveMaxRounds({ maxRounds: 3 })).toEqual({ max: 3, source: 'workflow' })
  })

  it('步骤没声明（自定义工作流、升级前冻结的计划）：按默认值 2，来源 default', () => {
    expect(effectiveMaxRounds({})).toEqual({ max: 2, source: 'default' })
  })
})

describe('isValidMaxRounds', () => {
  it('1 到 20 的整数合法', () => {
    expect(isValidMaxRounds(1)).toBe(true)
    expect(isValidMaxRounds(20)).toBe(true)
  })

  it('0、21、小数、非数字都不合法', () => {
    for (const value of [0, 21, -1, 1.5, Number.NaN, '2', undefined, null]) {
      expect(isValidMaxRounds(value), String(value)).toBe(false)
    }
  })
})

describe('resolveMaxRounds', () => {
  const planMax = { max: 2, source: 'workflow' } as const

  it('任务没设：沿用计划的上限与来源', () => {
    expect(resolveMaxRounds(planMax, '')).toEqual({ max: 2, source: 'workflow' })
    expect(resolveMaxRounds(planMax, undefined)).toEqual({ max: 2, source: 'workflow' })
    expect(resolveMaxRounds({ max: 2, source: 'default' }, '')).toEqual({ max: 2, source: 'default' })
  })

  it('任务设了 1 到 20 的整数：覆盖计划，来源 task（可调低也可调高）', () => {
    expect(resolveMaxRounds(planMax, '1')).toEqual({ max: 1, source: 'task' })
    expect(resolveMaxRounds(planMax, '3')).toEqual({ max: 3, source: 'task' })
    expect(resolveMaxRounds(planMax, '20')).toEqual({ max: 20, source: 'task' })
  })

  it('任务字段里是越界或手改出来的脏值：忽略，不让它悄悄放宽或收紧上限', () => {
    for (const dirty of ['0', '21', 'x', '1.5', ' 2', '02']) {
      expect(resolveMaxRounds(planMax, dirty), dirty).toEqual({ max: 2, source: 'workflow' })
    }
  })
})

describe('stepBackTargets / isRoundsLimited', () => {
  it('评审门且有回退边的步骤才受上限约束', () => {
    const plan = defaultShapedPlan()
    expect(stepBackTargets(plan, 'verify')).toEqual(['build'])
    expect(isRoundsLimited(plan, 'verify')).toBe(true)
  })

  it('没有评审门的步骤（build）有回退边但不受约束：requirements-changed 始终可用', () => {
    const plan = defaultShapedPlan()
    expect(stepBackTargets(plan, 'build')).toEqual(['spec'])
    expect(isRoundsLimited(plan, 'build')).toBe(false)
  })

  it('有评审门但没有回退边的步骤不受约束', () => {
    const plan = defaultShapedPlan()
    expect(stepBackTargets(plan, 'spec')).toEqual([])
    expect(isRoundsLimited(plan, 'spec')).toBe(false)
  })

  it('不在计划里的步骤：没有回退目标', () => {
    const plan = defaultShapedPlan()
    expect(stepBackTargets(plan, 'nowhere')).toEqual([])
    expect(isRoundsLimited(plan, 'nowhere')).toBe(false)
  })

  it('多条回退边：目标按声明序去重', () => {
    const plan = compileEffectiveWorkflowPlan('rounds-multi', {
      name: 'rounds-multi',
      steps: [
        step('spec', null, [{ event: 'spec-complete', to: 'design' }]),
        step('design', null, [{ event: 'design-complete', to: 'build' }]),
        step('build', null, [{ event: 'build-complete', to: 'verify' }]),
        step('verify', 'review', [
          { event: 'verify-pass', to: 'ship' },
          { event: 'redo-build', to: 'build' },
          { event: 'redo-design', to: 'design' },
          { event: 'redo-build-again', to: 'build' },
        ]),
        step('ship', null, []),
      ],
    })
    expect(stepBackTargets(plan, 'verify')).toEqual(['build', 'design'])
  })

  it('default 工作流（phase-manifest）：verify 是受约束步骤，回退目标是 build', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    expect(isRoundsLimited(plan, 'verify')).toBe(true)
    expect(stepBackTargets(plan, 'verify')).toEqual(['build'])
    expect(isRoundsLimited(plan, 'build')).toBe(false)
    expect(isRoundsLimited(plan, 'spec')).toBe(false)
  })
})

describe('currentRound', () => {
  const steps = ['open', 'explore', 'spec', 'build', 'verify', 'ship'] as const
  const base = { stepId: 'verify', steps, backTargets: ['build'], runId: 'run-1' }
  const into = (...targets: string[]) => targets.map((to) => ({ to, runId: 'run-1' }))

  it('第一次进入验证是第 1 轮', () => {
    expect(currentRound({ ...base, transitions: into('explore', 'spec', 'build', 'verify') })).toBe(1)
  })

  it('verify-fail 回到实现、再 build-complete 进入验证：第 2 轮', () => {
    expect(currentRound({
      ...base, transitions: into('explore', 'spec', 'build', 'verify', 'build', 'verify'),
    })).toBe(2)
  })

  it('经 requirements-changed 回到规格后重新计数：再进入验证是第 1 轮', () => {
    expect(currentRound({
      ...base, transitions: into('explore', 'spec', 'build', 'verify', 'build', 'verify', 'spec', 'build', 'verify'),
    })).toBe(1)
  })

  it('任务当前不在该步：返回自上次清零以来已进入的次数', () => {
    expect(currentRound({ ...base, transitions: into('spec', 'build', 'verify', 'build') })).toBe(1)
    expect(currentRound({ ...base, transitions: into('spec', 'build') })).toBe(0)
  })

  it('落到该步的回退目标本身（build）不清零', () => {
    expect(currentRound({
      ...base, transitions: into('spec', 'build', 'verify', 'build', 'verify', 'build', 'verify'),
    })).toBe(3)
  })

  describe('自定义工作流有多条不相邻的回退边', () => {
    // verify 可以回 design，也可以回 mid；build 夹在两个回退目标之间，它自己不是回退目标。
    const custom = {
      stepId: 'verify',
      steps: ['spec', 'design', 'build', 'mid', 'verify', 'ship'],
      backTargets: ['design', 'mid'],
      runId: 'run-1',
    }

    it('落到回退目标本身（design、mid）或夹在它们之间的步骤（build）都不清零', () => {
      expect(currentRound({
        ...custom, transitions: into('design', 'build', 'mid', 'verify', 'design', 'build', 'mid', 'verify'),
      })).toBe(2)
      expect(currentRound({
        ...custom, transitions: into('design', 'build', 'mid', 'verify', 'mid', 'verify'),
      })).toBe(2)
    })

    it('落到早于所有回退目标的步骤（spec）才清零', () => {
      expect(currentRound({
        ...custom,
        transitions: into('design', 'build', 'mid', 'verify', 'mid', 'verify', 'spec', 'design', 'build', 'mid', 'verify'),
      })).toBe(1)
    })

    it('清零后还没再进入该步：计数是 0，不是清零前的值', () => {
      expect(currentRound({
        ...custom, transitions: into('design', 'build', 'mid', 'verify', 'spec', 'design'),
      })).toBe(0)
    })
  })

  it('另一个 run 的转换记录不计入', () => {
    expect(currentRound({
      ...base,
      transitions: [
        { to: 'verify', runId: 'old-run' },
        { to: 'build', runId: 'old-run' },
        { to: 'verify', runId: 'old-run' },
        { to: 'build', runId: 'run-1' },
        { to: 'verify', runId: 'run-1' },
      ],
    })).toBe(1)
  })

  it('没有 runId 的记录（旧任务的历史行）照常计入；调用方没给 runId 时全部计入', () => {
    expect(currentRound({
      ...base, transitions: [{ to: 'build' }, { to: 'verify' }, { to: 'build' }, { to: 'verify' }],
    })).toBe(2)
    expect(currentRound({
      ...base, runId: null,
      transitions: [{ to: 'verify', runId: 'a' }, { to: 'build', runId: 'b' }, { to: 'verify', runId: 'c' }],
    })).toBe(2)
  })

  it('工作流的第一步就是受约束的步骤：任务创建时的那次进入也算一轮', () => {
    expect(currentRound({
      stepId: 'verify', steps: ['verify', 'build'], backTargets: ['build'], runId: 'run-1',
      transitions: [],
    })).toBe(1)
    expect(currentRound({
      stepId: 'verify', steps: ['verify', 'build'], backTargets: ['build'], runId: 'run-1',
      transitions: into('build', 'verify'),
    })).toBe(2)
  })

  it('没有记录：一次都没进入过', () => {
    expect(currentRound({ ...base, transitions: [] })).toBe(0)
  })

  it('没有回退目标时不会因为落到别的步骤清零（不受约束的步骤，值没有意义但不能崩）', () => {
    expect(currentRound({
      ...base, backTargets: [], transitions: into('verify', 'spec', 'verify'),
    })).toBe(2)
  })

  it('目标不在步骤序里的记录（来自被改过的工作流）既不计数也不清零', () => {
    expect(currentRound({
      ...base, transitions: into('build', 'verify', 'ghost', 'verify'),
    })).toBe(2)
  })
})
