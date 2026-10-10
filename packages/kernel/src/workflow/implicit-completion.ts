/**
 * Implicit completion edge for step-graph workflows.
 *
 * The Dashboard editor writes forward edges between consecutive stages plus optional send-back
 * edges, so the last stage of every branch has no declared way to finish the run. The kernel
 * therefore derives one reserved self-edge at planning/consumption time: a step without a forward
 * edge exits through `archived`, which closes the WorkflowRun. The bundled `archive` terminal is
 * the same rule. Compiled IR, plan fingerprints and frozen snapshots never contain this edge.
 */
import { DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'
import type { PipelineState } from '../types.js'
import { autoGateGuards } from './auto-gate.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { StepIR, StepTransitionIR } from './ir.js'

export const IMPLICIT_COMPLETION_EVENT = 'archived'

/**
 * 放弃边：任务超出了这条工作流的范围（simple 里由执行者判断，standard 里由改动风险探针触发），转入终态
 * `escalated`，之后另起一个 default 任务。放弃一个任务不该先把它做完，所以走这条边不要求测试、评审者、
 * 文档与技能证据（评审门步骤的人工确认照旧）。
 */
export const ABANDON_EVENT = 'scope-expanded'

export function isAbandonEvent(event: string): boolean {
  return event === ABANDON_EVENT
}

/**
 * 前进边 = 目标在步骤序里更靠后，或 `archived` 指向自己的完结自边（显式声明的与隐式派生的同判）。
 * 退回边（verify-fail、requirements-changed、自定义回边）不是：修问题的路必须一直开着。
 */
export function isForwardStepEdge(stepIds: readonly string[], from: string, to: string, event: string): boolean {
  if (event === IMPLICIT_COMPLETION_EVENT && from === to) return true
  const fromIndex = stepIds.indexOf(from)
  const toIndex = stepIds.indexOf(to)
  return fromIndex >= 0 && toIndex > fromIndex
}

/**
 * 前进边的统一判定（`isForwardExit` 与验证轮次上限共用，不另起第二套）：隐式完结自边永远是前进边；
 * phase-manifest（default）按事件策略的 `enforceTaskExit`；其余按步骤序（`isForwardStepEdge`）。
 */
export function isForwardEdge(
  executionModel: EffectiveWorkflowPlan['executionModel'],
  stepIds: readonly string[],
  from: string,
  to: string,
  event: string,
): boolean {
  if (event === IMPLICIT_COMPLETION_EVENT && from === to) return true
  if (executionModel === 'phase-manifest') {
    const policy = (DEFAULT_EVENT_POLICY as Record<string, { readonly enforceTaskExit: boolean } | undefined>)[event]
    return policy?.enforceTaskExit === true
  }
  return isForwardStepEdge(stepIds, from, to, event)
}

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

/** Step ids reachable from `startId` through declared edges, `startId` included. */
function reachableFrom(steps: readonly StepIR[], startId: string): ReadonlySet<string> {
  const byId = new Map(steps.map((candidate) => [candidate.id, candidate]))
  const seen = new Set<string>()
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    for (const transition of byId.get(id)?.transitions ?? []) {
      if (byId.has(transition.to) && !seen.has(transition.to)) queue.push(transition.to)
    }
  }
  return seen
}

/**
 * A step whose loop still has another way out is not an end. A hand-written `fix` step that only
 * returns to `verify`, while `verify` moves on to `ship`, has no forward edge, but completing the run
 * there would skip `ship`. The step therefore qualifies only when every step it can reach can reach
 * it back. Editor-built branches always satisfy this for their last stage, because every earlier
 * stage reaches it through the forward chain.
 */
function loopHasAnotherExit(steps: readonly StepIR[], step: StepIR): boolean {
  for (const id of reachableFrom(steps, step.id)) {
    if (id !== step.id && !reachableFrom(steps, id).has(step.id)) return true
  }
  return false
}

/**
 * The implicit `archived` edge of `stepId`, or undefined when the step has a forward edge, declares
 * `archived` itself, or can still leave its loop through another step. Pass `state` whenever the
 * caller acts on the edge: an archived run has nothing left to complete.
 *
 * The rule covers phase-manifest plans too. `default`'s `archive` terminal compiles to
 * `transitions: []`, so while it was limited to step-graph, every `default` Change reached
 * `archive` with no exit at all — `tenon status --json` printed `"exits": []` and a `fix` action
 * with an empty blocker list, and no projection ever named `tenon transition <change> archived`.
 * That event is declared by the default state machine itself (`flow/transition-table.ts`:
 * `archived: archive -> archive`); only the manifest-derived IR drops the edge, so deriving it
 * here restores the graph rather than inventing policy.
 */
export function implicitCompletionTransition(
  plan: ImplicitCompletionPlan,
  stepId: string,
  state?: PipelineState,
): StepTransitionIR | undefined {
  if (state !== undefined && runArchived(state)) return undefined
  const steps = plan.workflow.steps
  const index = steps.findIndex((candidate) => candidate.id === stepId)
  const step = steps[index]
  if (step === undefined) return undefined
  if (step.transitions.some((transition) => transition.event === IMPLICIT_COMPLETION_EVENT)) return undefined
  const hasForwardEdge = step.transitions.some((transition) =>
    steps.findIndex((candidate) => candidate.id === transition.to) > index)
  if (hasForwardEdge || enteredOnlyByArchivingEdges(steps, step) || loopHasAnotherExit(steps, step)) return undefined
  return {
    event: IMPLICIT_COMPLETION_EVENT,
    to: step.id,
    // gate=auto compiles to output guards on every forward exit; the derived completion exit gets the same.
    // A frozen plan whose IR still says gate=null recorded no such check and keeps it that way.
    guards: step.gate === 'auto' ? autoGateGuards(step.id, step.outputs) : [],
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
