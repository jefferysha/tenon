import { describe, expect, it } from 'vitest'
import type { PipelineState } from '../types.js'
import { selectExecution } from './execution-seam.js'
import type { ExitReportInput } from './execution-seam.js'
import {
  compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromSnapshot, workflowPlanSnapshot,
} from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import { allFields, legacyDefaultPlan } from './test-support.js'
import type { WorkflowDef } from './types.js'

/** 旧快照里记着 phase-manifest 的 default 计划。 */
function legacyPlan(): EffectiveWorkflowPlan {
  return legacyDefaultPlan({ track: 'backend', executionModel: 'phase-manifest' })
}

/** 两步的自定义工作流：build 往前到 verify，verify 只有回退边（完结靠派生的 archived 自边）。 */
function graphPlan(): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('flow', {
    name: 'flow',
    steps: [
      { id: 'build', label: 'B', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'verify' }] },
      { id: 'verify', label: 'V', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'back', to: 'build' }] },
    ],
  } as WorkflowDef)
}

function stateAt(phase: string): PipelineState {
  return { fields: allFields({ phase, track: 'backend' }), opaqueTail: '' }
}

describe('execution seam', () => {
  it('旧快照的 phase-manifest 计划走旧适配器', () => {
    const plan = legacyPlan()
    expect(plan.capabilities.execution.model).toBe('phase-manifest')
    expect(selectExecution(plan).kind).toBe('legacy-phase-manifest')
  })

  it('step-graph 计划走新适配器', () => {
    const plan = graphPlan()
    expect(plan.capabilities.execution.model).toBe('step-graph')
    expect(selectExecution(plan).kind).toBe('step-graph')
  })

  it('从快照恢复的计划沿用快照里记着的执行模型', () => {
    const restoredLegacy = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(legacyPlan()))
    expect(restoredLegacy.capabilities.execution.model).toBe('phase-manifest')
    expect(selectExecution(restoredLegacy).kind).toBe('legacy-phase-manifest')
    const restoredGraph = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(graphPlan()))
    expect(selectExecution(restoredGraph).kind).toBe('step-graph')
  })
})

describe('就绪判定的模型相关部分', () => {
  const context = { changeDirAbs: '/tmp/none' }

  it('旧适配器的出边是步骤声明的出边，且每条出边取事件表里的 guard', () => {
    const plan = legacyPlan()
    const basis = selectExecution(plan).readiness({ plan, state: stateAt('build'), context })
    const build = plan.workflow.steps.find((candidate) => candidate.id === 'build')
    expect(build).toBeDefined()
    if (build === undefined) return
    expect(basis.exitsOf(build)).toEqual(build.transitions)
    const buildComplete = build.transitions.find((transition) => transition.event === 'build-complete')
    expect(buildComplete).toBeDefined()
    if (buildComplete === undefined) return
    expect(basis.guardsOf(build, buildComplete).length).toBeGreaterThan(0)
  })

  it('旧适配器遇到事件表里没有的事件直接报错', () => {
    const plan = legacyPlan()
    const basis = selectExecution(plan).readiness({ plan, state: stateAt('build'), context })
    const step = plan.workflow.steps[0]
    expect(step).toBeDefined()
    if (step === undefined) return
    expect(() => basis.guardsOf(step, { event: 'no-such-event', to: step.id, guards: [], actions: [] }))
      .toThrow(/未知 default event 'no-such-event'/)
  })

  // 事件表是普通对象：原型链上的键（constructor、toString…）不是事件，不能当作「表里有」而读出 undefined 的 guards。
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('旧适配器把原型键 %s 也当作未知事件报错', (event) => {
    const plan = legacyPlan()
    const basis = selectExecution(plan).readiness({ plan, state: stateAt('build'), context })
    const step = plan.workflow.steps[0]
    expect(step).toBeDefined()
    if (step === undefined) return
    expect(() => basis.guardsOf(step, { event, to: step.id, guards: [], actions: [] }))
      .toThrow(`未知 default event '${event}'`)
  })

  it('step-graph 适配器的出边带上派生的完结边', () => {
    const plan = graphPlan()
    const basis = selectExecution(plan).readiness({ plan, state: stateAt('verify'), context })
    const verify = plan.workflow.steps.find((candidate) => candidate.id === 'verify')
    expect(verify).toBeDefined()
    if (verify === undefined) return
    expect(verify.transitions.map((transition) => transition.event)).toEqual(['back'])
    expect(basis.exitsOf(verify).map((transition) => transition.event)).toEqual(['back', 'archived'])
  })
})

describe('出口报告的模型相关部分', () => {
  function exitInput(plan: EffectiveWorkflowPlan, stepId: string, guardFailures: readonly string[]): ExitReportInput {
    return {
      plan,
      state: stateAt(stepId),
      stepId,
      changeDir: '/tmp/none',
      fileContext: undefined,
      guardCheck: () => ({ pass: guardFailures.length === 0, failures: [...guardFailures] }),
    }
  }

  it('step-graph 适配器没有相位出口表：不产生出口失败与待办任务', async () => {
    const plan = graphPlan()
    const basis = await selectExecution(plan).exitReport(exitInput(plan, 'build', ['不应被读取']))
    expect(basis.phaseExit).toEqual({ failures: [], openTasks: [] })
  })

  it('旧适配器把相位出口表的失败原样带出', async () => {
    const plan = legacyPlan()
    const basis = await selectExecution(plan).exitReport(exitInput(plan, 'build', ['build 出口：缺少 x']))
    expect(basis.phaseExit.failures).toEqual(['build 出口：缺少 x'])
  })

  it('step-graph 适配器的单条出边在未知步骤上没有 guard 阻断', async () => {
    const plan = graphPlan()
    const basis = await selectExecution(plan).exitReport(exitInput(plan, 'build', []))
    expect(await basis.edgeGuards({ stepId: 'no-such-step', event: 'go', to: 'verify' }, {})).toEqual([])
  })

  it('旧适配器的单条出边按事件表求值：build-complete 缺实现前评审时返回 guard 阻断', async () => {
    const plan = legacyPlan()
    const basis = await selectExecution(plan).exitReport(exitInput(plan, 'build', []))
    const items = await basis.edgeGuards({ stepId: 'build', event: 'build-complete', to: 'verify' }, {})
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.source === 'guard' && item.code === 'guard-failed')).toBe(true)
  })
})
