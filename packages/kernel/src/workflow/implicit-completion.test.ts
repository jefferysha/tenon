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

  test('a loop step that can still move on through another step gets no completion edge', () => {
    // verify moves on to ship; fix only returns to verify. Completing at fix would skip ship.
    const loop = compileEffectiveWorkflowPlan('loop', {
      name: 'loop',
      steps: [
        step('build', { transitions: [{ event: 'build-complete', to: 'verify' }] }),
        step('verify', { transitions: [{ event: 'verify-fail', to: 'fix' }, { event: 'verify-pass', to: 'ship' }] }),
        step('fix', { transitions: [{ event: 'fixed', to: 'verify' }] }),
        step('ship'),
      ],
    })
    expect(implicitCompletionTransition(loop, 'fix')).toBeUndefined()
    expect(stepExitTransitions(loop, 'fix').map((transition) => transition.event)).toEqual(['fixed'])
    expect(implicitCompletionTransition(loop, 'ship')?.event).toBe('archived')

    // Array order does not decide it: the loop step sits last and the real terminal earlier.
    const reordered = compileEffectiveWorkflowPlan('reordered', {
      name: 'reordered',
      steps: [
        step('build', { transitions: [{ event: 'build-pass', to: 'ship' }, { event: 'build-fail', to: 'fix' }] }),
        step('ship'),
        step('fix', { transitions: [{ event: 'fixed', to: 'build' }] }),
      ],
    })
    expect(implicitCompletionTransition(reordered, 'fix')).toBeUndefined()
    expect(implicitCompletionTransition(reordered, 'ship')?.event).toBe('archived')
  })

  test('an editor branch with several send-backs completes at its last stage only', () => {
    const plan = compileEffectiveWorkflowPlan('ui-backs', {
      name: 'ui-backs',
      steps: [
        step('a', { transitions: [{ event: 'a-complete', to: 'b' }] }),
        step('b', { transitions: [{ event: 'b-complete', to: 'c' }] }),
        step('c', { transitions: [{ event: 'c-complete', to: 'd' }, { event: 'c-back', to: 'a' }] }),
        step('d', { transitions: [{ event: 'd-back', to: 'b' }] }),
      ],
    })
    expect(plan.workflow.steps.map((candidate) => implicitCompletionTransition(plan, candidate.id)?.event ?? null))
      .toEqual([null, null, null, 'archived'])
  })

  /**
   * The derived edge used to be limited to step-graph plans, so `default`'s `archive` — the one
   * bundled terminal this rule was written for — had no exit at all: `tenon status --json` showed
   * `"exits": []` and `next: [{action:'fix', blockers:[]}]`, and nothing ever named
   * `tenon transition <change> archived`. The default state machine does declare that self-edge
   * (`flow/transition-table.ts`); only the manifest-derived IR drops it.
   */
  test('the bundled default archive terminal completes through the derived archived edge', () => {
    const defaultPlan = compileEffectiveWorkflowPlan('default')
    for (const candidate of defaultPlan.workflow.steps) {
      if (candidate.id === 'archive') continue
      expect(implicitCompletionTransition(defaultPlan, candidate.id)).toBeUndefined()
      expect(stepExitTransitions(defaultPlan, candidate.id)).toBe(candidate.transitions)
    }
    expect(implicitCompletionTransition(defaultPlan, 'archive')).toEqual({
      event: IMPLICIT_COMPLETION_EVENT,
      to: 'archive',
      guards: [],
      actions: [{ type: 'archive-run' }],
    })
    expect(stepExitTransitions(defaultPlan, 'archive', stateWith('false')).map((exit) => exit.event))
      .toEqual(['archived'])
    expect(stepExitTransitions(defaultPlan, 'archive', stateWith('true'))).toEqual([])
  })

  test('bundled simple plan is unchanged', () => {
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
