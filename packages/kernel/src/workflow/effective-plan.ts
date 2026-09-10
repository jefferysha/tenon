import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { sha256Hex } from '../sha256.js'
import type { DocumentProfileId } from '../types.js'
import type { TrackDefinition } from '../tracks/types.js'
import { builtinWorkflow } from './builtin-workflows.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { documentGovernancePolicy, type DocumentGovernancePolicy } from './document-contract.js'
import { loadWorkflow } from './loadWorkflow.js'
import type { WorkflowIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import {
  restoreLegacyWorkflowPlan,
  historicalV3WorkflowFingerprint,
  legacyWorkflowForSnapshot,
  validateV3WorkflowPolicies,
} from './effective-plan-snapshot-compat.js'
import {
  DEFAULT_WORKFLOW_DECOMPOSITION_POLICY,
  DEFAULT_WORKFLOW_INTERACTION_POLICY,
  DEFAULT_WORKFLOW_REVIEW_BUDGET_POLICY,
  compileWorkflowReviewBudgetPolicy,
} from './policy.js'
import type { SkillRef, WorkflowDef } from './types.js'
import { matchesTrackPredicate } from './predicates.js'
import { validateWorkflow } from './validate.js'
import type { WorkflowPlanSnapshot } from './workflow-plan-snapshot-types.js'
import type {
  EffectiveWorkflowPlan,
  PersistedDocumentGovernanceBinding,
} from './effective-plan-types.js'
export type { EffectiveWorkflowPlan, PersistedDocumentGovernanceBinding } from './effective-plan-types.js'
export type {
  LegacyWorkflowIR, WorkflowPlanSnapshot, WorkflowPlanSnapshotV1,
  WorkflowPlanSnapshotV2, WorkflowPlanSnapshotV3,
} from './workflow-plan-snapshot-types.js'

export class DocumentGovernanceBindingError extends Error {
  readonly _tag = 'DocumentGovernanceBindingError'
}
function profileFor(policy: DocumentGovernancePolicy | undefined): DocumentProfileId | undefined {
  if (policy?.id === 'openspec-v1') return 'legacy-full'
  if (policy?.id === 'document-v1') return 'document-v1'
  return undefined
}
function canonicalRequirement(requirement: {
  readonly kind: string; readonly producerCandidates: readonly string[]
}): { readonly kind: string; readonly producerCandidates: readonly string[] } {
  return {
    kind: requirement.kind,
    producerCandidates: [...new Set(requirement.producerCandidates)].sort(),
  }
}
export function documentGovernanceFingerprint(policy: DocumentGovernancePolicy): string {
  const canonical = {
    id: policy.id,
    steps: [...policy.steps],
    outputsByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...(policy.outputsByStep[step] ?? [])]
        .map(canonicalRequirement)
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ])),
    mutableByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...(policy.mutableByStep[step] ?? [])]
        .map(canonicalRequirement)
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ])),
    readsByStep: Object.fromEntries(policy.steps.map((step) => [
      step,
      [...new Set(policy.readsByStep[step] ?? [])].sort(),
    ])),
  }
  return sha256Hex(JSON.stringify(canonical))
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function assertValid(definition: WorkflowDef, origin: 'custom' | 'default'): void {
  const errors = validateWorkflow(definition, { origin })
  if (errors.length > 0) throw new Error(`effective workflow 无效：\n${errors.map((error) => `  - ${error}`).join('\n')}`)
}

/**
 * 技能的轨道条件求值：无 when → 全轨道；有 when → 命中 track.id，或 track 开启技能矩阵时命中其 skills.profile
 * （自定义轨道按 profile 继承 default 矩阵技能）。未传 track（无轨道语境的编译）不过滤。
 */
export function skillAppliesToTrack(skill: Pick<SkillRef, 'when'>, track: TrackDefinition | undefined): boolean {
  if (skill.when === undefined || track === undefined) return true
  if (matchesTrackPredicate(skill.when, track.id)) return true
  const profile = track.policyProfile.skills
  return profile.matrix && profile.profile !== '_all' && profile.profile !== track.id && matchesTrackPredicate(skill.when, profile.profile)
}

function planFromIr(
  id: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  workflow: WorkflowIR,
  track?: TrackDefinition,
  frozenDocumentPolicy?: DocumentGovernancePolicy | null,
  frozenWorkflowFingerprint?: string,
): EffectiveWorkflowPlan {
  const documentPolicy = frozenDocumentPolicy === undefined
    ? documentGovernancePolicy(id, workflow)
    : frozenDocumentPolicy ?? undefined
  const skillPolicy = executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared'
  // 技能矩阵并入 YAML：default（manifest-overlay）里带 when 的技能不进 phase 槽，而是作为 per-track 叠加层
  // 交给 resolver 按 track / profile 求值（与旧 manifest 矩阵同位置、同门禁语义）；自定义（step-declared）
  // 则直接按当前轨道过滑成本 step 的声明列表。
  const matrixEmbedded = workflow.steps.some((step) => step.skills.some((skill) => skill.when !== undefined))
  const reviewSteps = workflow.steps.filter((step) => step.gate === 'review').map((step) => step.id)
  const reviewLaneScopes = workflow.steps
    .filter((step) => (step.reviewLanes?.length ?? 0) > 0)
    .map((step) => ({ stepId: step.id, lanes: step.reviewLanes ?? [] }))
  const projectionSteps = workflow.steps.map((step) => ({ id: step.id, label: step.label }))
  const stepLabelSource = executionModel === 'phase-manifest' ? 'localized-builtin' : 'workflow-defined'
  const workflowFingerprint = frozenWorkflowFingerprint ?? sha256Hex(JSON.stringify({
    schema: 'effective-workflow-plan-v3',
    id,
    executionModel,
    workflow,
    decomposition: workflow.decomposition,
    interaction: workflow.interaction,
    reviewBudget: workflow.reviewBudget,
    documentPolicy: documentPolicy === undefined
      ? null
      : {
          id: documentPolicy.id,
          fingerprint: documentGovernanceFingerprint(documentPolicy),
        },
    skillPolicy,
    reviewSteps,
    projectionSteps,
  }))
  const trackPolicy = track?.policyProfile
  const documentProfile = profileFor(documentPolicy)
  return freeze({
    id,
    executionModel,
    workflow,
    decomposition: workflow.decomposition,
    interaction: workflow.interaction,
    reviewBudget: workflow.reviewBudget,
    ...(documentPolicy === undefined ? {} : { documentPolicy }),
    skillPolicy,
    reviewSteps,
    workflowFingerprint,
    capabilities: {
      execution: { model: executionModel },
      skills: {
        source: skillPolicy,
        steps: workflow.steps.map((step) => {
          const active = skillPolicy === 'manifest-overlay'
            ? step.skills.filter((skill) => skill.when === undefined)
            : step.skills.filter((skill) => skillAppliesToTrack(skill, track))
          const activeIds = new Set(active.map((skill) => skill.id))
          return {
            stepId: step.id,
            requiredSkillIds: active.map((skill) => skill.id),
            declared: active.map((skill) => ({
              id: skill.id,
              dependsOn: (skill.depends_on ?? []).filter((dependency) => activeIds.has(dependency)),
              kind: skill.kind ?? 'work',
              ...(skill.review_lane === undefined ? {} : { reviewLane: skill.review_lane }),
            })),
            conditional: skillPolicy === 'manifest-overlay'
              ? step.skills.flatMap((skill) => skill.when === undefined ? [] : [{ id: skill.id, when: skill.when }])
              : [],
          }
        }),
        trackOverlay: {
          matrix: trackPolicy?.skills.matrix ?? false,
          profile: trackPolicy?.skills.profile ?? '_all',
        },
        matrixEmbedded,
      },
      documents: {
        governed: documentPolicy !== undefined,
        ...(documentProfile === undefined ? {} : { profile: documentProfile }),
        ...(documentPolicy === undefined ? {} : { policy: documentPolicy }),
      },
      review: { steps: reviewSteps, budget: workflow.reviewBudget, laneScopes: reviewLaneScopes },
      automation: {
        eligible: trackPolicy?.automationEligible ?? false,
        autoEnqueueOnSpecComplete: trackPolicy?.autoEnqueueOnSpecComplete ?? false,
      },
      track: {
        id: track?.id ?? null,
        coverageProfile: trackPolicy?.coverageProfile ?? 'none',
        routingEnabled: trackPolicy?.routing.enabled ?? false,
      },
    },
    projection: {
      steps: projectionSteps,
      stepLabelSource,
    },
  })
}

export function workflowPlanSnapshot(plan: EffectiveWorkflowPlan): WorkflowPlanSnapshot {
  const current = planFromIr(
    plan.id,
    plan.executionModel,
    plan.workflow,
    undefined,
    plan.documentPolicy ?? null,
  )
  if (current.workflowFingerprint !== plan.workflowFingerprint) {
    const { reviewBudget: _reviewBudget, ...v3Workflow } = plan.workflow
    if (historicalV3WorkflowFingerprint(
      plan.id,
      plan.executionModel,
      v3Workflow,
      plan.documentPolicy ?? null,
      documentGovernanceFingerprint,
    ) === plan.workflowFingerprint) {
      return freeze({
        version: 3,
        workflowId: plan.id,
        executionModel: plan.executionModel,
        workflow: structuredClone(v3Workflow),
        documentPolicy: structuredClone(plan.documentPolicy ?? null),
        decomposition: structuredClone(plan.decomposition),
        interaction: structuredClone(plan.interaction),
        workflowFingerprint: plan.workflowFingerprint,
      })
    }
    const persistedLegacyWorkflow = legacyWorkflowForSnapshot(plan, documentGovernanceFingerprint)
    return freeze({
      version: 2,
      workflowId: plan.id,
      executionModel: plan.executionModel,
      workflow: structuredClone(persistedLegacyWorkflow),
      documentPolicy: structuredClone(plan.documentPolicy ?? null),
      workflowFingerprint: plan.workflowFingerprint,
    })
  }
  return freeze({
    version: 3,
    workflowId: plan.id,
    executionModel: plan.executionModel,
    workflow: structuredClone(plan.workflow),
    documentPolicy: structuredClone(plan.documentPolicy ?? null),
    decomposition: structuredClone(plan.decomposition),
    interaction: structuredClone(plan.interaction),
    reviewBudget: structuredClone(plan.reviewBudget),
    workflowFingerprint: plan.workflowFingerprint,
  })
}

export function effectiveWorkflowPlanFromSnapshot(
  snapshot: WorkflowPlanSnapshot,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  if ((snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3)
    || snapshot.workflowId === ''
    || (snapshot.executionModel !== 'phase-manifest' && snapshot.executionModel !== 'step-graph')
    || !/^[0-9a-f]{64}$/.test(snapshot.workflowFingerprint)) {
    throw new DocumentGovernanceBindingError('workflow plan snapshot 形状非法')
  }
  if (snapshot.version === 1 || snapshot.version === 2) {
    return restoreLegacyWorkflowPlan(
      snapshot,
      track,
      documentGovernanceFingerprint,
      (workflow, policy, fingerprint, frozenTrack) => planFromIr(
        snapshot.workflowId,
        snapshot.executionModel,
        workflow,
        frozenTrack,
        policy,
        fingerprint,
      ),
      (message) => { throw new DocumentGovernanceBindingError(message) },
    )
  }
  const legacyReviewBudget = validateV3WorkflowPolicies(
    snapshot,
    (message) => { throw new DocumentGovernanceBindingError(message) },
  )
  const reviewBudget = legacyReviewBudget
    ? structuredClone(DEFAULT_WORKFLOW_REVIEW_BUDGET_POLICY)
    : compileWorkflowReviewBudgetPolicy(snapshot.reviewBudget)
  const workflow: WorkflowIR = {
    ...structuredClone(snapshot.workflow),
    reviewBudget,
  }
  if (legacyReviewBudget) {
    const historical = historicalV3WorkflowFingerprint(
      snapshot.workflowId,
      snapshot.executionModel,
      snapshot.workflow,
      snapshot.documentPolicy,
      documentGovernanceFingerprint,
    )
    if (historical !== snapshot.workflowFingerprint) {
      throw new DocumentGovernanceBindingError(
        `workflow plan snapshot 内容与 fingerprint 不一致`
        + `（expected=${snapshot.workflowFingerprint}, historical=${historical}）`,
      )
    }
    return planFromIr(
      snapshot.workflowId,
      snapshot.executionModel,
      workflow,
      track,
      structuredClone(snapshot.documentPolicy),
      snapshot.workflowFingerprint,
    )
  }
  const plan = planFromIr(
    snapshot.workflowId,
    snapshot.executionModel,
    workflow,
    track,
    structuredClone(snapshot.documentPolicy),
  )
  if (plan.workflowFingerprint === snapshot.workflowFingerprint) return plan

  throw new DocumentGovernanceBindingError(
    `workflow plan snapshot 内容与 fingerprint 不一致`
    + `（expected=${snapshot.workflowFingerprint}, current=${plan.workflowFingerprint}）`,
  )
}

export function compileEffectiveWorkflowPlan(
  id: string,
  provided?: WorkflowDef,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  if (id === 'default') {
    const definition = provided ?? parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    assertValid(definition, 'default')
    return planFromIr(id, 'phase-manifest', compileDefaultWorkflow(definition), track)
  }
  const definition = provided ?? builtinWorkflow(id)
  if (!definition) throw new Error(`workflow '${id}' 未找到`)
  assertValid(definition, 'custom')
  return planFromIr(id, 'step-graph', compileWorkflow(definition), track)
}

export function loadEffectiveWorkflowPlan(
  repoRoot: string,
  id: string,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  // default 也读项目覆盖文件（`.pipeline/workflows/default.yaml`，loadWorkflow 已按 default 契约校验）；
  // 无覆盖时 compileEffectiveWorkflowPlan 回落内建模板。
  const definition = loadWorkflow(repoRoot, id) ?? undefined
  return compileEffectiveWorkflowPlan(id, definition, track)
}

export function effectiveWorkflowPlanFromIr(
  id: string,
  workflow: WorkflowIR,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  return planFromIr(id, 'step-graph', workflow, track)
}

export function resolveEffectiveWorkflowPlan(
  id: string,
  loadCompiled: (name: string) => WorkflowIR | null,
  track?: TrackDefinition,
  /** default 的项目覆盖读取器（返回 null = 无覆盖 → 内建模板）。缺省保持旧行为：恒用内建。 */
  loadDefaultOverride?: () => WorkflowDef | null,
): EffectiveWorkflowPlan | null {
  if (id === 'default') return compileEffectiveWorkflowPlan(id, loadDefaultOverride?.() ?? undefined, track)
  const workflow = loadCompiled(id)
  return workflow === null ? null : effectiveWorkflowPlanFromIr(id, workflow, track)
}

export function effectiveWorkflowPlanBinding(
  plan: EffectiveWorkflowPlan,
): PersistedDocumentGovernanceBinding {
  const policy = plan.documentPolicy
  const profile = profileFor(policy)
  return {
    ...(profile === undefined ? {} : { documentProfile: profile }),
    ...(policy === undefined
      ? {}
      : { documentGovernanceFingerprint: documentGovernanceFingerprint(policy) }),
    workflowPlanFingerprint: plan.workflowFingerprint,
  }
}

export function resolveBoundEffectiveWorkflowPlan(
  id: string,
  binding: PersistedDocumentGovernanceBinding,
  loadCompiled: (name: string) => WorkflowIR | null,
  track?: TrackDefinition,
  snapshot?: WorkflowPlanSnapshot,
): EffectiveWorkflowPlan | null {
  let plan: EffectiveWorkflowPlan | null
  if (snapshot !== undefined) {
    if (snapshot.workflowId !== id) {
      throw new DocumentGovernanceBindingError(
        `workflow plan snapshot identity 不一致：已绑定 '${snapshot.workflowId}'，当前 '${id}'`,
      )
    }
    plan = effectiveWorkflowPlanFromSnapshot(snapshot, track)
  } else {
    plan = resolveEffectiveWorkflowPlan(id, loadCompiled, track)
  }
  const boundProfile = binding.documentProfile
  const boundFingerprint = binding.documentGovernanceFingerprint
  const boundWorkflowFingerprint = binding.workflowPlanFingerprint
  if (boundProfile === undefined) {
    if (boundFingerprint !== undefined) {
      throw new DocumentGovernanceBindingError(
        `workflow '${id}' document governance binding 损坏：fingerprint 缺少 profile`,
      )
    }
    if (boundWorkflowFingerprint !== undefined && plan === null) {
      throw new DocumentGovernanceBindingError(
        `workflow '${id}' 已绑定 workflow plan fingerprint，定义缺失时拒绝运行`,
      )
    }
    if (
      boundWorkflowFingerprint !== undefined
      && plan !== null
      && plan.workflowFingerprint !== boundWorkflowFingerprint
    ) {
      throw new DocumentGovernanceBindingError(
        `workflow '${id}' workflow plan fingerprint 与初始化绑定不一致`,
      )
    }
    return plan
  }
  if (plan === null) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' 已绑定 document governance profile '${boundProfile}'，定义缺失时拒绝运行`,
    )
  }
  const effectiveProfile = profileFor(plan.documentPolicy)
  if (effectiveProfile === undefined) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' 已绑定 document governance profile '${boundProfile}'，不可降级为自由模式`,
    )
  }
  if (effectiveProfile !== boundProfile) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' document governance profile 不可变：已绑定 '${boundProfile}'，当前 '${effectiveProfile}'`,
    )
  }
  const effectivePolicy = plan.documentPolicy
  if (effectivePolicy === undefined) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' 已绑定 document governance profile '${boundProfile}'，当前 policy 缺失`,
    )
  }
  if (
    boundFingerprint !== undefined
    && documentGovernanceFingerprint(effectivePolicy) !== boundFingerprint
  ) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' document governance fingerprint 与初始化绑定不一致`,
    )
  }
  if (
    boundWorkflowFingerprint !== undefined
    && plan.workflowFingerprint !== boundWorkflowFingerprint
  ) {
    throw new DocumentGovernanceBindingError(
      `workflow '${id}' workflow plan fingerprint 与初始化绑定不一致`,
    )
  }
  return plan
}
