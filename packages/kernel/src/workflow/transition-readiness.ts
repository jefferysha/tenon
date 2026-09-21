import { DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'
import type { EventName } from '../flow/transition-table.js'
import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import type { AgentBlocker } from './agent-verdict.js'
import type { BuildRevisionBlocker } from './build-revision.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import { evaluateGuards } from './guard-handlers.js'
import {
  effectiveLifecyclePolicy,
} from './governed-lifecycle-policy.js'
import type { CompiledGuardConfig, GuardCapability, GuardDecision } from './ir.js'
import { stepExitTransitions } from './implicit-completion.js'
import {
  buildDefaultGuardInput,
  buildStepGuardInput,
  type StepGuardContext,
} from './stepGuard.js'

export type TransitionReadinessBlocker =
  | BuildRevisionBlocker
  | {
      readonly kind: 'guard-failed'
      readonly guardType: CompiledGuardConfig['type']
      readonly field?: string
      readonly actual?: string
      readonly expected?: readonly string[]
    }
  | {
      readonly kind: 'capability-unavailable'
      readonly guardType: CompiledGuardConfig['type']
      readonly capability: GuardCapability
    }
  | {
      readonly kind: 'evaluation-error'
      readonly guardType: CompiledGuardConfig['type']
      readonly capability?: GuardCapability | 'specMigrationStatus'
    }
  | {
      readonly kind: 'agents-incomplete'
      readonly agents: readonly { readonly agent: string; readonly reason: AgentBlocker['kind'] }[]
    }

export interface TransitionReadiness {
  readonly ready: boolean
  readonly blockers: readonly TransitionReadinessBlocker[]
}

export type ReadinessByTransition = Readonly<
  Record<string, Readonly<Record<string, TransitionReadiness>>>
>

function defaultEventGuards(event: string): readonly CompiledGuardConfig[] {
  if (!(event in DEFAULT_EVENT_POLICY)) {
    throw new Error(`phase-manifest workflow 声明了未知 default event '${event}'`)
  }
  return DEFAULT_EVENT_POLICY[event as EventName].guards
}

function blocker(
  guard: CompiledGuardConfig,
  decision: Exclude<GuardDecision, { readonly kind: 'passed' }>,
): TransitionReadinessBlocker {
  if (decision.kind === 'skipped') {
    if (guard.type === 'build-head-unchanged') {
      return {
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'capability-unavailable',
        remediation: 'return-to-build-and-capture-current-revision',
      }
    }
    return {
      kind: 'capability-unavailable',
      guardType: guard.type,
      capability: decision.capability,
    }
  }
  if (decision.blocker !== undefined) return decision.blocker
  return {
    kind: 'guard-failed',
    guardType: decision.guardType,
    ...(decision.field === undefined ? {} : { field: decision.field }),
    ...(decision.actual === undefined ? {} : { actual: decision.actual }),
    ...(decision.expected === undefined ? {} : { expected: decision.expected }),
  }
}

/**
 * Evaluate every declared edge with the same compiled guards and handlers used by transition.
 *
 * Runtime may deliberately treat a missing optional capability as `skipped`; the Dashboard is a
 * predictive read model and must not claim that an edge is ready when it could not evaluate the
 * predicate. Therefore a skipped guard is projected as a typed `capability-unavailable` blocker.
 * Production server wiring supplies all capabilities used by the current Change.
 */
export async function readinessByTransition(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  context: StepGuardContext,
): Promise<ReadinessByTransition> {
  const input = plan.executionModel === 'phase-manifest'
    ? buildDefaultGuardInput(state, context)
    : buildStepGuardInput(state, context)
  const phase = state.fields.phase
  const currentStepId = Array.isArray(phase) ? phase.join(',') : (phase ?? '')
  const step = plan.workflow.steps.find((candidate) => candidate.id === currentStepId)
  if (step === undefined) return {}
  // Structural exits (no run-state filter) so readiness keys always match the projected rules.
  const exits = plan.executionModel === 'phase-manifest' ? step.transitions : stepExitTransitions(plan, step.id)
  // agent 阻断只求一次（要读台账与冻结内容），再按边分发到前进出边上。
  const agentBlockers = context.stepAgents === undefined ? [] : await context.stepAgents()
  const agentsBlocker = agentBlockers.length === 0
    ? undefined
    : {
        kind: 'agents-incomplete' as const,
        agents: agentBlockers.map((item) => ({
          agent: 'agent' in item ? item.agent : item.reason,
          reason: item.kind,
        })),
      }
  const transitions = await Promise.all(exits.map(async (transition) => {
      const guards = plan.executionModel === 'phase-manifest'
        ? defaultEventGuards(transition.event)
        : effectiveLifecyclePolicy(
            plan.capabilities.documents.policy !== undefined,
            step,
            transition,
            plan.workflow.steps.find((candidate) => candidate.id === transition.to),
          ).guards
      const evaluations = []
      const errors: TransitionReadinessBlocker[] = []
      for (const guard of guards) {
        try {
          evaluations.push(...await evaluateGuards([guard], input, { stopOnFirstFailure: false }))
        } catch {
          const fieldValue = guard.type === 'build-head-unchanged' ? state.fields[guard.field] : undefined
          const scalar = Array.isArray(fieldValue) ? fieldValue.join(',') : (fieldValue ?? '')
          if (guard.type === 'build-head-unchanged') {
            errors.push({
              kind: 'verify-build-revision-untrusted',
              code: 'verify-build-revision-untrusted',
              reason: 'evaluation-error',
              remediation: 'return-to-build-and-capture-current-revision',
            })
            continue
          }
          const capability = guard.type === 'tasks-at-least'
            ? 'readText'
            : guard.type === 'file-exists'
              ? 'fileExists'
              : guard.type === 'spec-migration-applied'
                  ? 'specMigrationStatus'
                  : undefined
          errors.push({
            kind: 'evaluation-error',
            guardType: guard.type,
            ...(capability === undefined ? {} : { capability }),
          })
        }
      }
      const blockers = evaluations.flatMap(({ guard, decision }) =>
        decision.kind === 'passed' ? [] : [blocker(guard, decision)],
      )
      blockers.push(...errors)
      if (agentsBlocker !== undefined && isForwardExit(plan, step.id, transition.to, transition.event)) {
        blockers.push(agentsBlocker)
      }
      return [transition.event, { ready: blockers.length === 0, blockers }] as const
    }))
  return { [step.id]: Object.fromEntries(transitions) }
}
