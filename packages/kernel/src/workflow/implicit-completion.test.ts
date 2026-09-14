import { describe, expect, test } from 'vitest'
import type { PipelineState } from '../types.js'
import { builtinWorkflow } from './builtin-workflows.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { IMPLICIT_COMPLETION_EVENT, implicitCompletionTransition, stepExitTransitions } from './implicit-completion.js'
import type { StepDef, WorkflowDef } from './types.js'

function step(id: string, overrides: Partial<StepDef> = {}): StepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...overrides }
}

function stateWith(archived: string): PipelineState {
  return { fields: { archived } } as unknown as PipelineState
}

/** The shape the Dashboard editor saves: forward `<id>-complete`, send-back `<id>-back`, no exit on the last stage. */
const EDITOR_MAIN: WorkflowDef = {
  name: 'ui-main',
  steps: [
    step('stage-1', { gate: 'review', transitions: [{ event: 'stage-1-complete', to: 'build' }] }),
    step('build', { gate: 'auto', transitions: [{ event: 'build-complete', to: 'verify' }] }),
    step('verify', { gate: 'review', transitions: [{ event: 'verify-back', to: 'build' }] }),
  ],
}

const EDITOR_DOCS: WorkflowDef = {
  name: 'ui-docs',
  steps: [
    step('stage-1', { gate: 'review', transitions: [{ event: 'stage-1-complete', to: 'build' }] }),
    step('build', {
      gate: 'auto',
      skills: [{ id: 'test-driven-development' }],
      outputs: [{ field: 'design_doc', type: 'file_path' }],
    }),
  ],
}

describe('implicitCompletionTransition', () => {
  test('last stage with only a send-back edge completes through an archived self-edge', () => {
    const plan = compileEffectiveWorkflowPlan('ui-main', EDITOR_MAIN)
    expect(implicitCompletionTransition(plan, 'verify')).toEqual({
      event: IMPLICIT_COMPLETION_EVENT,
      to: 'verify',
      guards: [],
      actions: [{ type: 'archive-run' }],
    })
    expect(stepExitTransitions(plan, 'verify').map((transition) => transition.event)).toEqual(['verify-back', 'archived'])
  })

  test('zero-edge auto stage carries its output guards; steps with a forward edge get nothing', () => {
    const plan = compileEffectiveWorkflowPlan('ui-docs', EDITOR_DOCS)
    expect(implicitCompletionTransition(plan, 'build')).toEqual({
      event: 'archived',
      to: 'build',
      guards: [{ type: 'field-nonempty', field: 'design_doc' }],
      actions: [{ type: 'archive-run' }],
    })
    expect(implicitCompletionTransition(plan, 'stage-1')).toBeUndefined()
    expect(stepExitTransitions(plan, 'stage-1').map((transition) => transition.event)).toEqual(['stage-1-complete'])
    expect(stepExitTransitions(plan, 'missing')).toEqual([])
  })

  test('a single entry step without edges is completable', () => {
    const plan = compileEffectiveWorkflowPlan('single', { name: 'single', steps: [step('change')] })
    expect(implicitCompletionTransition(plan, 'change')?.event).toBe('archived')
  })

  test('an explicit archived edge or an archived run suppresses the implicit edge', () => {
    const explicit = compileEffectiveWorkflowPlan('explicit', {
      name: 'explicit',
      steps: [
        step('work', { transitions: [{ event: 'work-complete', to: 'done' }] }),
        step('done', { transitions: [{ event: 'archived', to: 'done', actions: [{ type: 'archive-run' }] }] }),
      ],
    })
    expect(implicitCompletionTransition(explicit, 'done')).toBeUndefined()
    expect(stepExitTransitions(explicit, 'done').map((transition) => transition.event)).toEqual(['archived'])

    const plan = compileEffectiveWorkflowPlan('ui-main', EDITOR_MAIN)
    expect(implicitCompletionTransition(plan, 'verify', stateWith('false'))?.event).toBe('archived')
    expect(implicitCompletionTransition(plan, 'verify', stateWith('true'))).toBeUndefined()
    expect(stepExitTransitions(plan, 'verify', stateWith('true')).map((transition) => transition.event)).toEqual(['verify-back'])
  })

  test('bundled default and simple plans are unchanged', () => {
    const defaultPlan = compileEffectiveWorkflowPlan('default')
    for (const candidate of defaultPlan.workflow.steps) {
      expect(implicitCompletionTransition(defaultPlan, candidate.id)).toBeUndefined()
      expect(stepExitTransitions(defaultPlan, candidate.id)).toBe(candidate.transitions)
    }
    const simple = builtinWorkflow('simple')
    if (simple === null) throw new Error('simple workflow missing')
    const simplePlan = compileEffectiveWorkflowPlan('simple', simple)
    for (const candidate of simplePlan.workflow.steps) {
      expect(implicitCompletionTransition(simplePlan, candidate.id)).toBeUndefined()
    }
  })

  test('derivation never mutates the compiled plan or its fingerprint', () => {
    const plan = compileEffectiveWorkflowPlan('ui-main', EDITOR_MAIN)
    const before = JSON.stringify(plan)
    stepExitTransitions(plan, 'verify')
    implicitCompletionTransition(plan, 'verify', stateWith('false'))
    expect(JSON.stringify(plan)).toBe(before)
    expect(plan.workflowFingerprint).toBe(compileEffectiveWorkflowPlan('ui-main', EDITOR_MAIN).workflowFingerprint)
    expect(plan.workflow.steps.find((candidate) => candidate.id === 'verify')?.transitions).toHaveLength(1)
  })
})
