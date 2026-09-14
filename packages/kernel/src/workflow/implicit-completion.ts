/**
 * Implicit completion edge for step-graph workflows.
 *
 * The Dashboard editor writes forward edges between consecutive stages plus optional send-back
 * edges, so the last stage of every branch has no declared way to finish the run. The kernel
 * therefore derives one reserved self-edge at planning/consumption time: a step without a forward
 * edge exits through `archived`, which closes the WorkflowRun. The bundled `archive` terminal is
 * the same rule. Compiled IR, plan fingerprints and frozen snapshots never contain this edge.
 */
import type { PipelineState } from '../types.js'
import { compileGuards } from './compile-guards.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { StepIR, StepTransitionIR } from './ir.js'

export const IMPLICIT_COMPLETION_EVENT = 'archived'

export type ImplicitCompletionPlan = Pick<EffectiveWorkflowPlan, 'capabilities' | 'workflow'>

function runArchived(state: PipelineState): boolean {
  const value = state.fields.archived
  return (Array.isArray(value) ? value.join(',') : (value ?? '')) === 'true'
}

/**
 * A step entered only through edges that already archive the run (for example `simple`'s `done`
 * and `escalated`) is a completion node itself; it gets no second completion edge.
 */
function enteredOnlyByArchivingEdges(steps: readonly StepIR[], step: StepIR): boolean {
  const incoming = steps
    .filter((candidate) => candidate.id !== step.id)
    .flatMap((candidate) => candidate.transitions.filter((transition) => transition.to === step.id))
  return incoming.length > 0
    && incoming.every((transition) => transition.actions.some((action) => action.type === 'archive-run'))
}

/**
 * The implicit `archived` edge of `stepId`, or undefined when the step has a forward edge, declares
 * `archived` itself, or the workflow is phase-manifest. Pass `state` whenever the caller acts on
 * the edge: an archived run has nothing left to complete. Plan-level projections that must agree
 * across Changes (snapshot rules, readiness, review handshake) omit it.
 */
export function implicitCompletionTransition(
  plan: ImplicitCompletionPlan,
  stepId: string,
  state?: PipelineState,
): StepTransitionIR | undefined {
  if (plan.capabilities.execution.model !== 'step-graph') return undefined
  if (state !== undefined && runArchived(state)) return undefined
  const steps = plan.workflow.steps
  const index = steps.findIndex((candidate) => candidate.id === stepId)
  const step = steps[index]
  if (step === undefined) return undefined
  if (step.transitions.some((transition) => transition.event === IMPLICIT_COMPLETION_EVENT)) return undefined
  const hasForwardEdge = step.transitions.some((transition) =>
    steps.findIndex((candidate) => candidate.id === transition.to) > index)
  if (hasForwardEdge || enteredOnlyByArchivingEdges(steps, step)) return undefined
  return {
    event: IMPLICIT_COMPLETION_EVENT,
    to: step.id,
    // gate=auto compiles to output guards on every declared exit; the derived exit gets the same.
    guards: step.gate === 'auto'
      ? compileGuards([{ type: 'nonempty-output' }], `steps.${step.id}.gate(auto)`, step.outputs)
      : [],
    actions: [{ type: 'archive-run' }],
  }
}

/** Declared exits of `stepId` followed by its implicit completion edge, if any. */
export function stepExitTransitions(
  plan: ImplicitCompletionPlan,
  stepId: string,
  state?: PipelineState,
): readonly StepTransitionIR[] {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) return []
  const completion = implicitCompletionTransition(plan, stepId, state)
  return completion === undefined ? step.transitions : [...step.transitions, completion]
}
