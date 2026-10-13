import { describe, expect, test } from 'vitest'
import { compileEffectiveWorkflowPlan, compileWorkflow, effectiveWorkflowPlanFromIr, type EffectiveWorkflowPlan, type WorkflowDef } from '@tenon/kernel'
import { mockState } from '../test-support.js'
import { emptyStepDocuments, type StepDocumentsView } from './statusStepParts.js'
import { stepOwnership } from './statusStepOwnership.js'

const defaultPlan = (track: string): EffectiveWorkflowPlan => compileEffectiveWorkflowPlan('default', undefined, { track })

function ownershipOf(plan: EffectiveWorkflowPlan, stepId: string, track: string, documents: StepDocumentsView = emptyStepDocuments('observed')) {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) throw new Error(`fixture: 没有步骤 ${stepId}`)
  return stepOwnership(plan, step, mockState({ track }), documents)
}

describe('stepOwnership —— 观察模式：从 YAML 推出本步负责什么（设计 §9）', () => {
  test('规格步：必须产出指向 openspec/changes/{change}/specs/ → 负责 delta spec；计划策略 required → 计划步', () => {
    const plan = defaultPlan('backend')
    expect(ownershipOf(plan, 'spec', 'backend')).toEqual({ ownsDeltaSpec: true, ownsAppliedSpec: false, planning: true })
  })

  test('交付步：离开条件含 spec-migration-applied → 负责应用规格；不负责 delta spec', () => {
    for (const track of ['pm', 'frontend', 'backend']) {
      expect(ownershipOf(defaultPlan(track), 'ship', track), track).toMatchObject({ ownsDeltaSpec: false, ownsAppliedSpec: true })
    }
  })

  test('立项 / 调研 / 实现 / 验证：什么都不负责（调研与立项的必须产出不在 specs/ 下）', () => {
    const plan = defaultPlan('backend')
    for (const step of ['open', 'explore', 'build', 'verify']) {
      expect(ownershipOf(plan, step, 'backend'), step).toMatchObject({ ownsDeltaSpec: false, ownsAppliedSpec: false })
    }
  })

  test('产品轨道的规格步同样负责 delta spec', () => {
    expect(ownershipOf(defaultPlan('pm'), 'spec', 'pm').ownsDeltaSpec).toBe(true)
  })

  test('轻量轨道不走 OpenSpec：即使 build 声明了 plan: required 也不是计划步', () => {
    const plan = defaultPlan('lite')
    expect(plan.capabilities.documents.governed).toBe(false)
    for (const step of plan.workflow.steps) {
      expect(ownershipOf(plan, step.id, 'lite'), step.id).toEqual({ ownsDeltaSpec: false, ownsAppliedSpec: false, planning: false })
    }
  })

  test('不走 OpenSpec 的自定义工作流：必须产出写在 openspec/changes/{change}/specs/ 下也不算负责 delta spec', () => {
    const definition: WorkflowDef = {
      name: 'flat',
      steps: [
        { id: 'write', label: '写', gate: null, skills: [], inputs: [], outputs: [], guards: [{ type: 'required-output', path: 'openspec/changes/{change}/specs/*/spec.md' }], transitions: [] },
      ],
    }
    const plan = effectiveWorkflowPlanFromIr('flat', compileWorkflow(definition))
    expect(plan.capabilities.documents).toMatchObject({ governed: false, mode: 'observed' })
    expect(ownershipOf(plan, 'write', 'main')).toEqual({ ownsDeltaSpec: false, ownsAppliedSpec: false, planning: false })
  })
})

describe('stepOwnership —— 契约模式：照旧读契约记录', () => {
  const doc = (kind: string) => ({ kind, path: `openspec/changes/demo/${kind}.md`, path_template: '', producers: [], status: 'missing' })
  const contract = (kinds: readonly string[]): StepDocumentsView => ({ mode: 'contract', reads: [], records: kinds.map(doc), updates: [] })

  test('delta-spec / applied-spec / plan 记录决定三项，与计划里写了什么无关', () => {
    const plan = defaultPlan('backend')
    expect(ownershipOf(plan, 'build', 'backend', contract(['delta-spec']))).toEqual({ ownsDeltaSpec: true, ownsAppliedSpec: false, planning: false })
    expect(ownershipOf(plan, 'build', 'backend', contract(['applied-spec']))).toEqual({ ownsDeltaSpec: false, ownsAppliedSpec: true, planning: false })
    expect(ownershipOf(plan, 'build', 'backend', contract(['plan']))).toEqual({ ownsDeltaSpec: false, ownsAppliedSpec: false, planning: true })
    expect(ownershipOf(plan, 'build', 'backend', contract(['superpower-plan'])).planning).toBe(true)
  })

  test('没有契约记录的契约模式步骤什么都不负责（即使 YAML 里有 specs/ 的必须产出）', () => {
    expect(ownershipOf(defaultPlan('backend'), 'spec', 'backend', contract([]))).toEqual({ ownsDeltaSpec: false, ownsAppliedSpec: false, planning: false })
  })
})
