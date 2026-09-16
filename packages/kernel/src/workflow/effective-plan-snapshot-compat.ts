import type { TrackDefinition } from '../tracks/types.js'
import type { DocumentGovernancePolicy } from './document-contract.js'
import { legacyDocumentPolicyForSnapshot } from './migrations/openspec-v1-document-policy.js'
import type {
  EffectiveWorkflowPlan,
} from './effective-plan.js'
import type {
  LegacyWorkflowIR,
  WorkflowPlanSnapshotV1,
  WorkflowPlanSnapshotV2,
  WorkflowPlanSnapshotV3,
  WorkflowIRV3,
} from './workflow-plan-snapshot-types.js'
import type { WorkflowIR } from './ir.js'
import { preTenonV1DocumentPolicy } from './migrations/pre-tenon-v1-document-policy.js'
import {
  compileWorkflowDecompositionPolicy,
  compileWorkflowInteractionPolicy,
  compileWorkflowReviewBudgetPolicy,
} from './policy.js'
import { sha256Hex } from '../sha256.js'

type Fail = (message: string) => never
type PlanBuilder = (
  workflow: WorkflowIR,
  documentPolicy: DocumentGovernancePolicy | null,
  workflowFingerprint: string,
  track?: TrackDefinition,
) => EffectiveWorkflowPlan

const LEGACY_DEFAULT_VERIFY_REVIEW_LANES = ['standards', 'spec', 'e2e'] as const
const LEGACY_REVIEW_LANE_PROJECTIONS = new Map<string, readonly string[]>([
  ['phase-manifest:default:verify:review', LEGACY_DEFAULT_VERIFY_REVIEW_LANES],
])

function legacyReviewLanes(
  workflowId: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  step: WorkflowIR['steps'][number],
): readonly string[] | undefined {
  return LEGACY_REVIEW_LANE_PROJECTIONS.get(
    `${executionModel}:${workflowId}:${step.id}:${step.gate ?? 'none'}`,
  )
}

function projectLegacyReviewLanes(
  workflowId: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  workflow: WorkflowIR,
): WorkflowIR {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      const lanes = legacyReviewLanes(workflowId, executionModel, step)
      return lanes !== undefined && (step.reviewLanes?.length ?? 0) === 0
        ? { ...step, reviewLanes: [...lanes] }
        : step
    }),
  }
}

function removeLegacyReviewLaneProjection(
  workflowId: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  workflow: LegacyWorkflowIR,
): LegacyWorkflowIR {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      const lanes = legacyReviewLanes(workflowId, executionModel, step)
      if (lanes === undefined || JSON.stringify(step.reviewLanes) !== JSON.stringify(lanes)) {
        return step
      }
      const { reviewLanes: _reviewLanes, ...legacyStep } = step
      return legacyStep
    }),
  }
}

export function legacyWorkflowForSnapshot(
  plan: EffectiveWorkflowPlan,
  documentFingerprint: (policy: DocumentGovernancePolicy) => string,
): LegacyWorkflowIR {
  const {
    decomposition: _decomposition,
    interaction: _interaction,
    reviewBudget: _reviewBudget,
    ...legacyWorkflow
  } = plan.workflow
  const projected = removeLegacyReviewLaneProjection(plan.id, plan.executionModel, legacyWorkflow)
  return historicalWorkflowFingerprint(
    plan.id,
    plan.executionModel,
    projected,
    plan.documentPolicy,
    documentFingerprint,
  ) === plan.workflowFingerprint
    ? projected
    : legacyWorkflow
}

export function historicalWorkflowFingerprint(
  workflowId: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  workflow: LegacyWorkflowIR,
  documentPolicy: DocumentGovernancePolicy | undefined,
  documentFingerprint: (policy: DocumentGovernancePolicy) => string,
): string {
  const skillPolicy = executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared'
  const reviewSteps = workflow.steps.filter((step) => step.gate === 'review').map((step) => step.id)
  const projectionSteps = workflow.steps.map((step) => ({ id: step.id, label: step.label }))
  return sha256Hex(JSON.stringify({
    schema: 'effective-workflow-plan-v1',
    id: workflowId,
    executionModel,
    workflow,
    documentPolicy: documentPolicy === undefined
      ? null
      : { id: documentPolicy.id, fingerprint: documentFingerprint(documentPolicy) },
    skillPolicy,
    reviewSteps,
    projectionSteps,
  }))
}

export function restoreLegacyWorkflowPlan(
  snapshot: WorkflowPlanSnapshotV1 | WorkflowPlanSnapshotV2,
  track: TrackDefinition | undefined,
  documentFingerprint: (policy: DocumentGovernancePolicy) => string,
  build: PlanBuilder,
  fail: Fail,
): EffectiveWorkflowPlan {
  const legacyWorkflow = structuredClone(snapshot.workflow)
  if (Object.hasOwn(legacyWorkflow, 'decomposition') || Object.hasOwn(legacyWorkflow, 'interaction')) {
    return fail('legacy workflow plan snapshot 不得携带 V3 policy 字段')
  }
  const workflow = projectLegacyReviewLanes(snapshot.workflowId, snapshot.executionModel, {
    ...legacyWorkflow,
    decomposition: compileWorkflowDecompositionPolicy(undefined),
    interaction: compileWorkflowInteractionPolicy(undefined),
    reviewBudget: compileWorkflowReviewBudgetPolicy(undefined),
  })
  let documentPolicy = snapshot.version === 2
    ? structuredClone(snapshot.documentPolicy) ?? undefined
    : legacyDocumentPolicyForSnapshot(snapshot.workflowId, legacyWorkflow)
  const historicalWorkflow = removeLegacyReviewLaneProjection(
    snapshot.workflowId,
    snapshot.executionModel,
    legacyWorkflow,
  )
  let historical = historicalWorkflowFingerprint(
    snapshot.workflowId,
    snapshot.executionModel,
    historicalWorkflow,
    documentPolicy,
    documentFingerprint,
  )
  // A short-lived pre-migration build persisted the derived default lanes in V1/V2 bytes.
  // Keep those already-authenticated snapshots readable without making the derived projection
  // part of the canonical historical fingerprint.
  if (historical !== snapshot.workflowFingerprint
    && JSON.stringify(historicalWorkflow) !== JSON.stringify(legacyWorkflow)) {
    const projectedHistorical = historicalWorkflowFingerprint(
      snapshot.workflowId,
      snapshot.executionModel,
      legacyWorkflow,
      documentPolicy,
      documentFingerprint,
    )
    if (projectedHistorical === snapshot.workflowFingerprint) historical = projectedHistorical
  }
  if (historical !== snapshot.workflowFingerprint && snapshot.version === 1) {
    const preTenonPolicy = preTenonV1DocumentPolicy(snapshot.workflowId, snapshot.workflowFingerprint)
    if (preTenonPolicy !== undefined) {
      documentPolicy = preTenonPolicy
      historical = historicalWorkflowFingerprint(
        snapshot.workflowId,
        snapshot.executionModel,
        historicalWorkflow,
        documentPolicy,
        documentFingerprint,
      )
      if (historical !== snapshot.workflowFingerprint
        && JSON.stringify(historicalWorkflow) !== JSON.stringify(legacyWorkflow)) {
        const projectedHistorical = historicalWorkflowFingerprint(
          snapshot.workflowId,
          snapshot.executionModel,
          legacyWorkflow,
          documentPolicy,
          documentFingerprint,
        )
        if (projectedHistorical === snapshot.workflowFingerprint) historical = projectedHistorical
      }
    }
  }
  if (historical !== snapshot.workflowFingerprint) {
    return fail(
      `workflow plan snapshot 内容与 fingerprint 不一致`
      + `（expected=${snapshot.workflowFingerprint}, historical=${historical}）`,
    )
  }
  return build(workflow, documentPolicy ?? null, snapshot.workflowFingerprint, track)
}

function exactPolicyShape(value: unknown, normalized: object, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && JSON.stringify(normalized) === JSON.stringify(Object.fromEntries(
      keys.map((key) => [key, Reflect.get(value, key)]),
    ))
}

export function historicalV3WorkflowFingerprint(
  workflowId: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  workflow: WorkflowIRV3,
  documentPolicy: DocumentGovernancePolicy | null,
  documentFingerprint: (policy: DocumentGovernancePolicy) => string,
): string {
  const skillPolicy = executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared'
  const reviewSteps = workflow.steps.filter((step) => step.gate === 'review').map((step) => step.id)
  const projectionSteps = workflow.steps.map((step) => ({ id: step.id, label: step.label }))
  return sha256Hex(JSON.stringify({
    schema: 'effective-workflow-plan-v2',
    id: workflowId,
    executionModel,
    workflow,
    decomposition: workflow.decomposition,
    interaction: workflow.interaction,
    documentPolicy: documentPolicy === null
      ? null
      : { id: documentPolicy.id, fingerprint: documentFingerprint(documentPolicy) },
    skillPolicy,
    reviewSteps,
    projectionSteps,
  }))
}

export function validateV3WorkflowPolicies(snapshot: WorkflowPlanSnapshotV3, fail: Fail): boolean {
  let decomposition
  let interaction
  let workflowDecomposition
  let workflowInteraction
  try {
    decomposition = compileWorkflowDecompositionPolicy(snapshot.decomposition)
    interaction = compileWorkflowInteractionPolicy(snapshot.interaction)
    workflowDecomposition = compileWorkflowDecompositionPolicy(snapshot.workflow.decomposition)
    workflowInteraction = compileWorkflowInteractionPolicy(snapshot.workflow.interaction)
  } catch (error) {
    return fail(`workflow plan snapshot frozen policy 无效：${error instanceof Error ? error.message : String(error)}`)
  }
  const decompositionKeys = [
    'version', 'mode', 'target', 'strategy', 'max_items', 'max_depth', 'auto_when', 'ask_when',
  ]
  const legacyReviewBudget = snapshot.reviewBudget === undefined
    && snapshot.workflow.reviewBudget === undefined
  let reviewBudget
  let workflowReviewBudget
  if (!legacyReviewBudget) {
    if (snapshot.reviewBudget === undefined || snapshot.workflow.reviewBudget === undefined) {
      return fail('workflow plan snapshot review budget 顶层与 workflow 绑定不完整')
    }
    try {
      reviewBudget = compileWorkflowReviewBudgetPolicy(snapshot.reviewBudget)
      workflowReviewBudget = compileWorkflowReviewBudgetPolicy(snapshot.workflow.reviewBudget)
    } catch (error) {
      return fail(`workflow plan snapshot review budget 无效：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!exactPolicyShape(snapshot.decomposition, decomposition, decompositionKeys)
    || !exactPolicyShape(snapshot.interaction, interaction, ['version', 'mode'])
    || !exactPolicyShape(snapshot.workflow.decomposition, workflowDecomposition, decompositionKeys)
    || !exactPolicyShape(snapshot.workflow.interaction, workflowInteraction, ['version', 'mode'])
    || JSON.stringify(decomposition) !== JSON.stringify(workflowDecomposition)
    || JSON.stringify(interaction) !== JSON.stringify(workflowInteraction)
    || (!legacyReviewBudget && (
      !exactPolicyShape(snapshot.reviewBudget, reviewBudget as object, ['version', 'max_attempts'])
      || !exactPolicyShape(snapshot.workflow.reviewBudget, workflowReviewBudget as object, ['version', 'max_attempts'])
      || JSON.stringify(reviewBudget) !== JSON.stringify(workflowReviewBudget)
    ))) {
    fail('workflow plan snapshot frozen policy 形状或绑定非法')
  }
  return legacyReviewBudget
}
