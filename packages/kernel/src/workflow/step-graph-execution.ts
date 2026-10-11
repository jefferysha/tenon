/**
 * step-graph 执行适配器——所有新任务，以及快照里记着 `executionModel: 'step-graph'` 的任务。
 *
 * 转换规划、就绪判定与出口报告里随执行模型而变的部分都按工作流 YAML 声明的步骤、出边与 guard 求值，
 * 不读任何写死的阶段规则。旧模型的同位物是 legacy-phase-manifest/legacy-execution.ts。
 */
import { applyActions } from './action-handlers.js'
import { BuildRevisionCaptureError, safeRevisionHash } from './build-revision.js'
import { applyStepTransition, planStepTransition, resolveStep } from './engine.js'
import type { EdgeGuardBlocker, ExecutionAdapter, TransitionInput, TransitionPlanResult } from './execution-seam-types.js'
import { effectiveLifecyclePolicy } from './governed-lifecycle-policy.js'
import { implicitCompletionTransition, stepExitTransitions } from './implicit-completion.js'
import type { ActionOutcome, WorkflowIR } from './ir.js'
import { buildStepGuardInput, evaluateWorkflowIrStepGuards } from './stepGuard.js'
import { fieldStr } from './transition-field-scalar.js'
import type { TransitionApplicationWarning } from './transition-application-types.js'

async function planStepGraphTransition({ state, plan: effectivePlan, command, clock }: TransitionInput): Promise<TransitionPlanResult> {
  const ir = effectivePlan.workflow
  const workflowName = effectivePlan.id
  const currentBeforePlan = resolveStep(ir, fieldStr(state.fields.phase))
  // A step without a forward exit completes the run through the derived `archived` self-edge.
  // It is added to a planning copy only, so the frozen IR and its fingerprint stay untouched, and
  // it flows through the same guards, skills, documents and review receipt as a declared exit.
  const completion = currentBeforePlan === null
    ? undefined
    : implicitCompletionTransition(effectivePlan, currentBeforePlan.id, state)
  const planningIr: WorkflowIR = completion === undefined
    ? ir
    : {
        ...ir,
        steps: ir.steps.map((step) => step.id === completion.to
          ? { ...step, transitions: [...step.transitions, completion] }
          : step),
      }
  const edgeBeforePlan = resolveStep(planningIr, fieldStr(state.fields.phase))
    ?.transitions.find((candidate) => candidate.event === command.event)
  const documentPolicy = effectivePlan.capabilities.documents.policy
  const governed = documentPolicy !== undefined
  const targetStep = edgeBeforePlan === undefined
    ? undefined
    : resolveStep(planningIr, edgeBeforePlan.to)
  const lifecycle = currentBeforePlan && edgeBeforePlan
    ? effectiveLifecyclePolicy(governed, currentBeforePlan, edgeBeforePlan, targetStep ?? undefined)
    : undefined
  const plan = await planStepTransition(planningIr, state, command.event, {
    changeDirAbs: command.changeDir,
    fileExists: command.context.fileExists,
    gitHeadSha: command.context.gitHeadSha,
    workspaceFingerprint: command.context.workspaceFingerprint,
    specMigrationStatus: command.context.specMigrationStatus,
    assessBuildRevision: command.context.assessBuildRevision,
    currentStep: fieldStr(state.fields.phase),
    tasksThroughStep: command.context.tasksThroughStep,
    afkQueued: command.context.afkQueued,
    dependencyStates: command.context.dependencyStates,
  }, lifecycle)
  if (!plan.ok) {
    if (plan.kind === 'step-not-in-graph') return { kind: 'step-not-in-graph', workflowName, stepId: plan.stepId }
    if (plan.kind === 'event-unsupported') {
      return {
        kind: 'event-unsupported', workflowName, stepId: plan.stepId, event: command.event, available: plan.available,
      }
    }
    const blocker = plan.blockers?.[0]
    if (blocker !== undefined) return { kind: 'revision-untrusted', blocker }
    return { kind: 'step-guard-failed', workflowName, stepId: plan.stepId, failures: plan.failures, blockers: plan.blockers }
  }
  const currentStep = resolveStep(planningIr, plan.from)
  if (!currentStep) throw new Error(`workflow '${workflowName}' 在已规划 step '${plan.from}' 后无法重取当前 step`)
  // 计划通过：先算 phase 推进（applyStepTransition），再跑该边 edge actions——patch 合并进
  // nextFields **在 commit 之前**（对照 default 轨 typed action（applyActions）在 commit 前改 fields
  // 的同一时序）。actions 是 async，其真异常（如 freeze-build-sha 的 gitHeadSha 抛错）原样上抛 → 出
  // transact 回调 → 事务中止不 commit（state 不推进）。旧 YAML 无 edge action → 零 patch 零 signal，
  // 行为逐字不变。actions 直接取自 plan（planStepTransition 选边时携带同一条 edge 的
  // effective lifecycle actions），不二次按 from+event 查表——规划即选边的单一真相，无
  // 「选一条边、执行另查一条」的语义漂移面。
  const nextState = applyStepTransition(state, plan.to, clock)
  const actions = plan.actions
  const closesRun = actions.some((action) => action.type === 'archive-run')
  const warnings: TransitionApplicationWarning[] = []
  let nextFields = closesRun
    ? { ...nextState.fields, phase_status: 'done' as const }
    : nextState.fields
  if (actions.length > 0) {
    let outcome: ActionOutcome
    try {
      outcome = await applyActions(actions, {
        fields: nextState.fields,
        clock,
        gitHeadSha: command.context.gitHeadSha,
        workspaceFingerprint: command.context.workspaceFingerprint,
        captureBuildRevision: command.context.captureBuildRevision,
      })
    } catch (error) {
      if (error instanceof BuildRevisionCaptureError) {
        return {
          kind: 'revision-untrusted',
          blocker: {
            ...error.blocker,
            // Capture ran against the prospective target fields, but a rejected transition never
            // commits that state. Always report the locked canonical pre-state digest.
            stateHash: safeRevisionHash(state.fields),
          },
        }
      }
      throw error
    }
    nextFields = { ...nextFields, ...outcome.patch }
    for (const signal of outcome.signals) warnings.push({ kind: signal.kind })
  }
  return {
    governedDocumentContract: governed,
    ...(documentPolicy ? { documentPolicy } : {}),
    requiresReviewApproval: effectivePlan.capabilities.review.steps.includes(currentStep.id),
    from: plan.from, to: plan.to, nextFields, warnings,
  }
}

export const stepGraphExecution: ExecutionAdapter = {
  kind: 'step-graph',

  planTransition: planStepGraphTransition,

  readiness: ({ plan, state, context }) => ({
    guardInput: buildStepGuardInput(state, context),
    exitsOf: (step) => stepExitTransitions(plan, step.id),
    guardsOf: (step, transition) => effectiveLifecyclePolicy(
      plan.capabilities.documents.policy !== undefined,
      step,
      transition,
      plan.workflow.steps.find((candidate) => candidate.id === transition.to),
    ).guards,
  }),

  exitReport: async ({ plan, state, changeDir }) => ({
    phaseExit: { failures: [], openTasks: [] },
    async edgeGuards({ stepId, event, to }, context): Promise<readonly EdgeGuardBlocker[]> {
      const step = resolveStep(plan.workflow, stepId)
      if (!step) return []
      const edge = stepExitTransitions(plan, stepId, state).find((transition) => transition.event === event)
      const guards = edge === undefined
        ? step.guards
        : effectiveLifecyclePolicy(
          plan.capabilities.documents.governed,
          step,
          edge,
          plan.workflow.steps.find((candidate) => candidate.id === to),
        ).guards
      const result = await evaluateWorkflowIrStepGuards(state, { ...step, guards }, { changeDirAbs: changeDir, ...context })
      return result.failures.map((message) => ({ source: 'guard' as const, code: 'guard-failed', message }))
    },
  }),
}
