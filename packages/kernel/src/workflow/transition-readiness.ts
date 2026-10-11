import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import type { AgentBlocker } from './agent-verdict.js'
import type { BuildRevisionBlocker } from './build-revision.js'
import type { StepBlockerSource } from './step-exit-report.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import { selectExecution } from './execution-seam.js'
import { evaluateGuards } from './guard-handlers.js'
import type { CompiledGuardConfig, GuardCapability, GuardDecision } from './ir.js'
import type { StepGuardContext } from './stepGuard.js'

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
  | {
      /**
       * `tenon status` exits 里出边 guard 之外的阻断（相位出口规则含 tasks.md、技能、文档、测试、规格迁移），
       * 由 evaluateStepExitReport 给出；`message` 与 CLI 同一份文案。
       */
      readonly kind: 'step-exit'
      readonly source: StepBlockerSource
      readonly code: string
      readonly message: string
      readonly items?: readonly string[]
      /** 结构化描述（见 StepBlockerDetail）：客户端按它分类展示，不解析 `message`。 */
      readonly subject?: string
      readonly state?: string
      readonly count?: number
    }

export interface TransitionReadiness {
  readonly ready: boolean
  readonly blockers: readonly TransitionReadinessBlocker[]
}

export type ReadinessByTransition = Readonly<
  Record<string, Readonly<Record<string, TransitionReadiness>>>
>

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
  // 出边与 guard 随执行模型而变，由接缝选适配器；求值循环与 agent 阻断两种模型共用。
  const basis = selectExecution(plan).readiness({ plan, state, context })
  const input = basis.guardInput
  const phase = state.fields.phase
  const currentStepId = Array.isArray(phase) ? phase.join(',') : (phase ?? '')
  const step = plan.workflow.steps.find((candidate) => candidate.id === currentStepId)
  if (step === undefined) return {}
  // Structural exits (no run-state filter) so readiness keys always match the projected rules.
  const exits = basis.exitsOf(step)
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
      const guards = basis.guardsOf(step, transition)
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
