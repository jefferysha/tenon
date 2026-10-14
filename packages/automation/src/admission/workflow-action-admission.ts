import {
  DEFAULT_WORKFLOW_DECOMPOSITION_POLICY,
  effectiveWorkflowPlanFromSnapshot,
  evaluateWorkflowDecompositionMaterialization,
  evaluateWorkflowAction,
  sameWorkflowActionAuthoritySnapshot,
  workflowPolicyPermissionLayer,
  type BudgetReservationRecord,
  type RunRecord,
  type WorkflowActionEvaluation,
  type WorkflowAuthorityBinding,
  type WorkflowDecompositionCandidate,
  type WorkflowDecompositionReviewReceipt,
  type WorkflowHardConfirmation,
  type WorkflowInteractionMode,
  type WorkflowActionAuthoritySnapshotV1,
  type WorkflowPermissionLayerInput,
  type WorkflowPermissionLayers,
} from '@tenon/kernel'
import type { ExecutionContext } from './execution-context.js'
import type { createAdmissionJournal } from './loop-admission-journal.js'
import { frozenProjectLayer } from './frozen-project-layer.js'
import {
  buildAfkWorkflowActionAuthoritySnapshot,
  type WorkflowActionAuthorityFacts,
  type WorkflowProjectAuthority,
} from './workflow-action-authority-binding.js'
import {
  errText,
  type AdmissionDenial,
  type ClaimAuthorizationResult,
  type LoopAdmissionDeps,
} from './loop-admission-types.js'

/**
 * The AFK transport is a named permission, not an autonomy level. Keeping this adapter tiny makes
 * the queue/CLI preview and the authoritative reservation boundary consume the same kernel table.
 */
export function evaluateAfkWorkflowAdmission(input: {
  readonly interactionMode: WorkflowInteractionMode
  readonly layers: WorkflowPermissionLayers
}): WorkflowActionEvaluation {
  return evaluateWorkflowAction({
    action: 'enter-afk',
    classification: 'routine-reversible',
    interactionMode: input.interactionMode,
    layers: input.layers,
  })
}

const unavailableLayer = (status: 'missing' | 'malformed'): WorkflowPermissionLayerInput => ({
  status,
  grants: [],
})

/** Fail-closed result for callers that cannot bind the reservation to a canonical WorkflowRun. */
export function evaluateMissingAfkWorkflowAdmission(): WorkflowActionEvaluation {
  const missing = unavailableLayer('missing')
  return evaluateAfkWorkflowAdmission({
    interactionMode: 'interactive',
    layers: { platform: missing, skill: missing, project: missing, workflow: missing, run: missing },
  })
}

type BoundWorkflowRun = Awaited<ReturnType<NonNullable<LoopAdmissionDeps['bindAutomationPolicy']>>>

/** Authority facts are dynamic infrastructure; provider exceptions are not ordinary denials. */
export class WorkflowActionAuthorityResolutionError extends Error {
  override readonly name = 'WorkflowActionAuthorityResolutionError'
  readonly _tag = 'WorkflowActionAuthorityResolutionError'

  constructor(readonly authorityError: unknown) {
    super(`Workflow action authority resolution failed: ${errText(authorityError)}`, {
      cause: authorityError,
    })
  }
}

/**
 * Production admission adapter for decomposition execution. It restores only the immutable Run
 * snapshot and downgrades the exact Run layer on any run/fingerprint mismatch before delegating to
 * the authoritative kernel evaluator; callers cannot substitute a live Workflow definition.
 */
export function evaluateBoundWorkflowDecompositionMaterialization(input: {
  readonly run: BoundWorkflowRun
  readonly authority: WorkflowAuthorityBinding
  readonly layers: Omit<WorkflowPermissionLayers, 'workflow'>
  readonly candidate: WorkflowDecompositionCandidate
  readonly hardConfirmation?: WorkflowHardConfirmation
  readonly review?: {
    readonly event_id: string
    readonly receipt?: WorkflowDecompositionReviewReceipt
  }
}): WorkflowActionEvaluation {
  let decomposition = DEFAULT_WORKFLOW_DECOMPOSITION_POLICY
  let interactionMode: WorkflowInteractionMode = 'interactive'
  let snapshotMatches = false
  if (input.run.workflowPlanSnapshot !== undefined) {
    try {
      const frozen = effectiveWorkflowPlanFromSnapshot(input.run.workflowPlanSnapshot)
      snapshotMatches = input.run.workflowPlanFingerprint === frozen.workflowFingerprint
        && input.run.workflowId === frozen.id
        && input.authority.workflow_run_id === input.run.id
        && input.authority.workflow_fingerprint === frozen.workflowFingerprint
      decomposition = frozen.decomposition
      interactionMode = frozen.interaction.mode
    } catch {
      snapshotMatches = false
    }
  }
  const layers = snapshotMatches
    ? input.layers
    : { ...input.layers, run: { status: 'fingerprint-mismatch' as const, grants: [] } }
  return evaluateWorkflowDecompositionMaterialization({
    policy: decomposition,
    interactionMode,
    authority: input.authority,
    layers,
    candidate: input.candidate,
    hardConfirmation: input.hardConfirmation,
    review: input.review,
  })
}

interface BoundAfkLayers {
  readonly interactionMode: WorkflowInteractionMode
  readonly layers: WorkflowPermissionLayers
  /** 项目层授权所依据的冻结分支；项目层不放行 enter-afk 时为 undefined。 */
  readonly projectAuthority?: WorkflowProjectAuthority
}

/**
 * Derives the frozen Workflow ceiling and the frozen Project layer from the immutable WorkflowRun
 * snapshot, and preserves the exact layer inputs used by the evaluator.
 */
function afkLayersAgainstBoundRun(
  run: BoundWorkflowRun,
  dynamic: Pick<WorkflowActionAuthorityFacts, 'platform' | 'skill' | 'run' | 'trackId'>,
): BoundAfkLayers {
  const missing = unavailableLayer('missing')
  let interactionMode: WorkflowInteractionMode = 'interactive'
  let workflow: WorkflowPermissionLayerInput = missing
  if (run.workflowPlanSnapshot !== undefined) {
    try {
      const frozenPlan = effectiveWorkflowPlanFromSnapshot(run.workflowPlanSnapshot)
      if (run.workflowPlanFingerprint !== frozenPlan.workflowFingerprint
        || run.workflowId !== frozenPlan.id) {
        workflow = { status: 'fingerprint-mismatch', grants: [] }
      } else {
        interactionMode = frozenPlan.workflow.interaction.mode
        workflow = workflowPolicyPermissionLayer(frozenPlan.workflow)
      }
    } catch {
      workflow = { status: 'fingerprint-mismatch', grants: [] }
    }
  }
  const project = frozenProjectLayer(run, dynamic.trackId)
  return {
    interactionMode,
    layers: {
      platform: dynamic.platform,
      skill: dynamic.skill,
      project: project.layer,
      workflow,
      run: dynamic.run,
    },
    ...(project.authority === undefined ? {} : { projectAuthority: project.authority }),
  }
}

function evaluateAfkAgainstBoundRun(
  run: BoundWorkflowRun,
  dynamic: Pick<WorkflowActionAuthorityFacts, 'platform' | 'skill' | 'run' | 'trackId'>,
): WorkflowActionEvaluation {
  return evaluateAfkWorkflowAdmission(afkLayersAgainstBoundRun(run, dynamic))
}

const missingDynamicAuthority = (): WorkflowActionAuthorityFacts => {
  const missing = unavailableLayer('missing')
  return { platform: missing, skill: missing, run: missing }
}

interface BoundAfkAuthorityEvaluation {
  readonly authorization: WorkflowActionEvaluation
  readonly binding?: WorkflowActionAuthoritySnapshotV1
}

/**
 * Resolves fresh non-Workflow facts (platform / skill / run / recorded track) and evaluates them against
 * the immutable WorkflowRun snapshot. The Workflow ceiling and the Project layer come only from that
 * snapshot, so the fact provider can report its observations but cannot grant either layer.
 */
export async function evaluateBoundAfkWorkflowAdmission(input: {
  readonly change: string
  readonly context: ExecutionContext
  readonly run: BoundWorkflowRun
  readonly workflowActionAuthority: NonNullable<LoopAdmissionDeps['workflowActionAuthority']>
  readonly expectedAuthority?: WorkflowActionAuthoritySnapshotV1
}): Promise<BoundAfkAuthorityEvaluation> {
  let dynamic: WorkflowActionAuthorityFacts
  try {
    dynamic = await input.workflowActionAuthority({
      change: input.change, context: input.context, run: input.run,
    })
  } catch (error) {
    throw new WorkflowActionAuthorityResolutionError(error)
  }

  const effective = afkLayersAgainstBoundRun(input.run, dynamic)
  const authorization = evaluateAfkWorkflowAdmission(effective)
  if (!authorization.allowed) return { authorization }

  let binding: WorkflowActionAuthoritySnapshotV1
  try {
    if (effective.projectAuthority === undefined) throw new Error('project authority unavailable')
    binding = buildAfkWorkflowActionAuthoritySnapshot({
      run: input.run,
      context: input.context,
      project: effective.projectAuthority,
      layers: effective.layers,
    })
  } catch {
    return {
      authorization: evaluateAfkWorkflowAdmission({
        ...effective,
        layers: { ...effective.layers, run: unavailableLayer('malformed') },
      }),
    }
  }
  if (input.expectedAuthority !== undefined
    && !sameWorkflowActionAuthoritySnapshot(input.expectedAuthority, binding)) {
    return {
      authorization: evaluateAfkWorkflowAdmission({
        ...effective,
        layers: { ...effective.layers, project: { status: 'identity-mismatch', grants: [] } },
      }),
    }
  }
  return { authorization, binding }
}

/** Binds an admitted reservation to the canonical frozen WorkflowRun. */
async function bindAfkWorkflowRun(input: {
  readonly change: string
  readonly context: ExecutionContext
  readonly bindAutomationPolicy: NonNullable<LoopAdmissionDeps['bindAutomationPolicy']>
}): Promise<BoundWorkflowRun> {
  const policy = input.context.automation_policy
  if (policy === undefined) throw new Error('loop admission produced no AutomationPolicy snapshot')
  const iterationId = input.context.iteration_id
  if (iterationId === undefined) throw new Error('loop admission produced no iteration identity')
  const run = await input.bindAutomationPolicy(input.change, policy, {
    loopId: input.context.loop_id,
    iterationId,
  })
  if (run.automationPolicy?.policy_version !== policy.policy_version) {
    throw new Error('WorkflowRun did not persist the admitted AutomationPolicy snapshot')
  }
  if (run.loopId !== input.context.loop_id || run.iterationId !== iterationId) {
    throw new Error('WorkflowRun did not persist the admitted loop/iteration identity')
  }
  return run
}

/** Binds the run and freezes the exact initial authority identity into ExecutionContext. */
export async function bindAndEvaluateAfkWorkflowRun(input: {
  readonly change: string
  readonly context: ExecutionContext
  readonly bindAutomationPolicy: NonNullable<LoopAdmissionDeps['bindAutomationPolicy']>
  readonly bindWorkflowActionAuthority: LoopAdmissionDeps['bindWorkflowActionAuthority']
  readonly workflowActionAuthority: LoopAdmissionDeps['workflowActionAuthority']
}): Promise<{
  readonly context: ExecutionContext
  readonly run: BoundWorkflowRun
  readonly authorization: WorkflowActionEvaluation
}> {
  const run = await bindAfkWorkflowRun(input)
  const boundContext = Object.freeze({ ...input.context, workflow_run_id: run.id })
  const authorityResolver = input.workflowActionAuthority
  const bindAuthority = input.bindWorkflowActionAuthority
  if (authorityResolver === undefined || bindAuthority === undefined) {
    return {
      context: boundContext,
      run,
      authorization: evaluateAfkAgainstBoundRun(run, missingDynamicAuthority()),
    }
  }
  let evaluated: BoundAfkAuthorityEvaluation
  try {
    const result = await evaluateBoundAfkWorkflowAdmission({
      change: input.change,
      context: boundContext,
      run,
      workflowActionAuthority: authorityResolver,
    })
    if (result.binding !== undefined) {
      const bound = await bindAuthority(input.change, result.binding)
      if (bound.workflowActionAuthority === undefined
        || !sameWorkflowActionAuthoritySnapshot(bound.workflowActionAuthority, result.binding)) {
        throw new Error('WorkflowRun repository did not persist the exact Workflow action authority snapshot')
      }
    }
    evaluated = result
  } catch (error) {
    if (error instanceof WorkflowActionAuthorityResolutionError) throw error
    throw new WorkflowActionAuthorityResolutionError(error)
  }
  const context = evaluated.binding === undefined
    ? boundContext
    : Object.freeze({ ...boundContext, workflow_action_authority: evaluated.binding })
  return { context, run, authorization: evaluated.authorization }
}

type AdmissionJournal = ReturnType<typeof createAdmissionJournal>

/**
 * Re-resolves authority and performs the queued→scheduled claim right after the exact durable
 * authority rebind. Any drift (the change now records another track, the frozen branch no longer
 * grants AFK, a layer changed) therefore closes the reservation with zero charge without invoking
 * the claim callback; the claim itself re-checks the recorded track under the change lock.
 */
export async function claimWithFreshAfkWorkflowAuthority(input: {
  readonly context: ExecutionContext
  readonly bindAutomationPolicy: LoopAdmissionDeps['bindAutomationPolicy']
  readonly bindWorkflowActionAuthority: LoopAdmissionDeps['bindWorkflowActionAuthority']
  readonly workflowActionAuthority: LoopAdmissionDeps['workflowActionAuthority']
  readonly claim: (expectedTrackId: string) => Promise<boolean>
  readonly clock: () => string
  readonly close: AdmissionJournal['close']
  readonly closeRecord: AdmissionJournal['closeRecord']
}): Promise<ClaimAuthorizationResult> {
  const expected = input.context.workflow_action_authority
  const bindAutomationPolicy = input.bindAutomationPolicy
  const bindAuthority = input.bindWorkflowActionAuthority
  const authorityResolver = input.workflowActionAuthority
  if (expected === undefined
    || bindAutomationPolicy === undefined
    || bindAuthority === undefined
    || authorityResolver === undefined) {
    return closeWorkflowAuthorizationDenial({
      context: input.context,
      authorization: evaluateMissingAfkWorkflowAdmission(),
      workflowRunId: input.context.workflow_run_id,
      clock: input.clock,
      close: input.close,
      closeRecord: input.closeRecord,
    })
  }

  let run: BoundWorkflowRun
  try {
    run = await bindAfkWorkflowRun({
      change: input.context.change,
      context: input.context,
      bindAutomationPolicy,
    })
  } catch (bindingError) {
    return compensateWorkflowBindingFailure({
      context: input.context,
      bindingError,
      clock: input.clock,
      close: input.close,
      closeRecord: input.closeRecord,
    })
  }

  let claimStarted = false
  let fresh: BoundAfkAuthorityEvaluation & { readonly claimed?: boolean }
  try {
    const evaluated = await evaluateBoundAfkWorkflowAdmission({
      change: input.context.change,
      context: input.context,
      run,
      workflowActionAuthority: authorityResolver,
      expectedAuthority: expected,
    })
    if (!evaluated.authorization.allowed) {
      fresh = evaluated
    } else {
      if (evaluated.binding === undefined) {
        throw new Error('allowed Workflow action evaluation produced no durable authority snapshot')
      }
      const bound = await bindAuthority(input.context.change, evaluated.binding)
      if (bound.workflowActionAuthority === undefined
        || !sameWorkflowActionAuthoritySnapshot(bound.workflowActionAuthority, evaluated.binding)) {
        throw new Error('WorkflowRun repository did not rebind the exact Workflow action authority snapshot')
      }
      claimStarted = true
      fresh = { ...evaluated, claimed: await input.claim(expected.track_id) }
    }
  } catch (error) {
    if (claimStarted) throw error
    const bindingError = error instanceof WorkflowActionAuthorityResolutionError
      ? error
      : new WorkflowActionAuthorityResolutionError(error)
    return compensateWorkflowBindingFailure({
      context: input.context,
      bindingError,
      clock: input.clock,
      close: input.close,
      closeRecord: input.closeRecord,
    })
  }

  if (!fresh.authorization.allowed) {
    return closeWorkflowAuthorizationDenial({
      context: input.context,
      authorization: fresh.authorization,
      workflowRunId: run.id,
      clock: input.clock,
      close: input.close,
      closeRecord: input.closeRecord,
    })
  }
  return { ok: true, context: input.context, claimed: fresh.claimed ?? false }
}

/** Closes a policy-denied reservation without charging it and returns the structured denial. */
export async function closeWorkflowAuthorizationDenial(input: {
  readonly context: ExecutionContext
  readonly authorization: WorkflowActionEvaluation
  readonly workflowRunId?: string
  readonly clock: () => string
  readonly close: AdmissionJournal['close']
  readonly closeRecord: AdmissionJournal['closeRecord']
}): Promise<AdmissionDenial> {
  const { context, authorization } = input
  const detail = authorization.denials.map((denial) => denial.code).join(',')
  await input.close(context.reservation_id, (reservation: BudgetReservationRecord): RunRecord => ({
    ...input.closeRecord(reservation, {
      result: 'skipped', reason: 'admission-denied', charge: 'none',
      now: input.clock(), runner: context.runner,
    }),
    admitted_at: context.admitted_at,
    ...(input.workflowRunId === undefined ? {} : { workflow_run_id: input.workflowRunId }),
    error: { cause: `workflow-action-${authorization.status}`, message: detail },
  }))
  return {
    ok: false,
    action: 'skip-run',
    reason: `workflow-action-${authorization.status}`,
    detail,
    loopId: context.loop_id,
    authorization,
  }
}

/** Zero-charge compensation for a failed canonical binding or authority resolution; always rethrows. */
export async function compensateWorkflowBindingFailure(input: {
  readonly context: ExecutionContext
  readonly bindingError: unknown
  readonly clock: () => string
  readonly close: AdmissionJournal['close']
  readonly closeRecord: AdmissionJournal['closeRecord']
}): Promise<never> {
  const authorityFailure = input.bindingError instanceof WorkflowActionAuthorityResolutionError
  const reason = authorityFailure ? 'infrastructure-error' : 'automation-policy-bind-failed'
  const cause = authorityFailure ? 'workflow-action-authority-failed' : 'automation-policy-bind-failed'
  try {
    await input.close(input.context.reservation_id, (reservation: BudgetReservationRecord): RunRecord => ({
      ...input.closeRecord(reservation, {
        result: 'failed', reason, charge: 'none',
        now: input.clock(), runner: input.context.runner,
      }),
      admitted_at: input.context.admitted_at,
      error: { cause, message: errText(input.bindingError) },
    }))
  } catch (settlementError) {
    throw new Error(
      `AutomationPolicy binding failed (${errText(input.bindingError)}) and reservation compensation failed (${errText(settlementError)})`,
      { cause: input.bindingError },
    )
  }
  throw input.bindingError
}
