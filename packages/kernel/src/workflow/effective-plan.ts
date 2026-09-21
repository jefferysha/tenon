import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { sha256Hex } from '../sha256.js'
import type { DocumentProfileId } from '../types.js'
import type { TrackDefinition } from '../tracks/types.js'
import { builtinWorkflow } from './builtin-workflows.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { documentGovernancePolicy, type DocumentGovernancePolicy } from './document-contract.js'
import { documentGovernanceFingerprint } from './document-governance-fingerprint.js'
export { documentGovernanceFingerprint } from './document-governance-fingerprint.js'
import { loadWorkflow } from './loadWorkflow.js'
import type { WorkflowIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import {
  restoreLegacyWorkflowPlan,
  historicalV3PolicyWorkflowFingerprint,
  historicalV3WorkflowFingerprint,
  legacyWorkflowForSnapshot,
  validateSnapshotPolicies,
  validateV3WorkflowPolicies,
} from './effective-plan-snapshot-compat.js'
import type { WorkflowDef } from './types.js'
import { WorkflowTrackBranchError } from './validate.js'
import { validateWorkflow } from './validate.js'
import { isDefaultWorkflowName } from './identifier.js'
import type { WorkflowPlanSnapshot } from './workflow-plan-snapshot-types.js'
import type {
  EffectiveWorkflowPlan,
  PersistedDocumentGovernanceBinding,
} from './effective-plan-types.js'
export type { EffectiveWorkflowPlan, PersistedDocumentGovernanceBinding } from './effective-plan-types.js'
export type {
  LegacyWorkflowIR, WorkflowPlanSnapshot, WorkflowPlanSnapshotV1,
  WorkflowPlanSnapshotV2, WorkflowPlanSnapshotV3, WorkflowPlanSnapshotV4,
} from './workflow-plan-snapshot-types.js'
export class DocumentGovernanceBindingError extends Error {
  readonly _tag = 'DocumentGovernanceBindingError'
}
function profileFor(policy: DocumentGovernancePolicy | undefined): DocumentProfileId | undefined {
  return policy?.id === 'openspec-v1' ? 'legacy-full' : policy?.id === 'document-v1' ? 'document-v1' : undefined
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
/** 按 track 选中分支 IR（同 selectTrackBranch 口径）：有 tracks 时未给 track → 第一条分支；给了却没有 → 抛错。分支契约提到顶层。 */
export function selectTrackBranchIr(workflow: WorkflowIR, track: string | undefined): WorkflowIR {
  const { tracks, ...rest } = workflow
  const entries = Object.entries(tracks ?? {})
  if (entries.length === 0) return rest
  const branch = track === undefined || track === '' ? entries[0]?.[1] : tracks?.[track]
  if (branch === undefined) throw new WorkflowTrackBranchError(workflow.name, track ?? ''); const { documentContract: _documentContract, ...single } = rest
  return { ...single, ...(branch.documentContract === undefined ? {} : { documentContract: branch.documentContract }), steps: branch.steps }
}
function planFromIr(
  id: string,
  executionModel: EffectiveWorkflowPlan['executionModel'],
  compiled: WorkflowIR,
  track?: TrackDefinition,
  frozenDocumentPolicy?: DocumentGovernancePolicy | null,
  frozenWorkflowFingerprint?: string,
): EffectiveWorkflowPlan {
  const workflow = selectTrackBranchIr(compiled, track?.id)
  const documentPolicy = frozenDocumentPolicy === undefined
    ? documentGovernancePolicy(id, compiled, track?.id)
    : frozenDocumentPolicy ?? undefined
  const skillPolicy = executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared'
  const reviewStepsOf = (steps: WorkflowIR['steps']): string[] => steps.filter((step) => step.gate === 'review').map((step) => step.id)
  const projectionStepsOf = (steps: WorkflowIR['steps']): Array<{ id: string; label: string }> => steps.map((step) => ({ id: step.id, label: step.label }))
  const reviewSteps = reviewStepsOf(workflow.steps)
  // agent 内容冻结在 Change 边车里，不进指纹；这里只投影声明本身。
  const agentSteps = workflow.steps
    .filter((step) => step.agents !== undefined)
    .map((step) => ({
      stepId: step.id,
      executors: (step.agents?.executors ?? []).map((ref) => ({ agent: ref.agent, dependsOn: [...(ref.depends_on ?? [])] })),
      reviewers: (step.agents?.reviewers ?? []).map((ref) => ({
        agent: ref.agent,
        required: ref.required,
        blockAt: ref.block_at,
        dependsOn: [...(ref.depends_on ?? [])],
        readsTests: [...(ref.reads_tests ?? [])],
      })),
    }))
  const projectionSteps = projectionStepsOf(workflow.steps)
  const stepLabelSource = executionModel === 'phase-manifest' ? 'localized-builtin' : 'workflow-defined'
  const workflowFingerprint = frozenWorkflowFingerprint ?? sha256Hex(JSON.stringify({
    schema: 'effective-workflow-plan-v4',
    id,
    executionModel,
    workflow: compiled,
    decomposition: compiled.decomposition,
    interaction: compiled.interaction,
    documentPolicy: documentPolicy === undefined
      ? null
      : {
          id: documentPolicy.id,
          fingerprint: documentGovernanceFingerprint(documentPolicy),
        },
    skillPolicy,
    reviewSteps: reviewStepsOf(compiled.steps),
    projectionSteps: projectionStepsOf(compiled.steps),
  }))
  const trackPolicy = track?.policyProfile
  const documentProfile = profileFor(documentPolicy)
  return freeze({
    id,
    executionModel,
    definition: compiled,
    workflow,
    decomposition: workflow.decomposition,
    interaction: workflow.interaction,
    ...(documentPolicy === undefined ? {} : { documentPolicy }),
    skillPolicy,
    reviewSteps,
    workflowFingerprint,
    capabilities: {
      execution: { model: executionModel },
      skills: {
        source: skillPolicy,
        steps: workflow.steps.map((step) => ({
          stepId: step.id,
          requiredSkillIds: step.skills.map((skill) => skill.id),
          declared: step.skills.map((skill) => ({
            id: skill.id,
            dependsOn: [...(skill.depends_on ?? [])],
          })),
        })),
        trackOverlay: {
          matrix: trackPolicy?.skills.matrix ?? false,
          profile: trackPolicy?.skills.profile ?? '_all',
        },
      },
      documents: {
        governed: documentPolicy !== undefined,
        ...(documentProfile === undefined ? {} : { profile: documentProfile }),
        ...(documentPolicy === undefined ? {} : { policy: documentPolicy }),
      },
      review: { steps: reviewSteps },
      agents: { steps: agentSteps },
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
  const definition = plan.definition ?? plan.workflow
  const current = planFromIr(
    plan.id,
    plan.executionModel,
    definition,
    undefined,
    plan.documentPolicy ?? null,
  )
  if (current.workflowFingerprint !== plan.workflowFingerprint) {
    // 从旧快照恢复出来的计划再落盘时保持它原来的版本；生产路径只在 Change 创建时落盘，
    // 走的都是上面那条 v4 分支。
    if (historicalV3WorkflowFingerprint(
      plan.id,
      plan.executionModel,
      definition,
      plan.documentPolicy ?? null,
      documentGovernanceFingerprint,
    ) === plan.workflowFingerprint) {
      return freeze({
        version: 3,
        workflowId: plan.id,
        executionModel: plan.executionModel,
        workflow: structuredClone(definition),
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
    version: 4,
    workflowId: plan.id,
    executionModel: plan.executionModel,
    workflow: structuredClone(definition),
    documentPolicy: structuredClone(plan.documentPolicy ?? null),
    decomposition: structuredClone(plan.decomposition),
    interaction: structuredClone(plan.interaction),
    workflowFingerprint: plan.workflowFingerprint,
  })
}
export function effectiveWorkflowPlanFromSnapshot(
  snapshot: WorkflowPlanSnapshot,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  if (![1, 2, 3, 4].includes(snapshot.version)
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
  if (snapshot.version === 4) {
    validateSnapshotPolicies(snapshot, (message) => { throw new DocumentGovernanceBindingError(message) })
    const plan = planFromIr(
      snapshot.workflowId,
      snapshot.executionModel,
      structuredClone(snapshot.workflow),
      track,
      structuredClone(snapshot.documentPolicy),
    )
    if (plan.workflowFingerprint === snapshot.workflowFingerprint) return plan
    throw new DocumentGovernanceBindingError(
      `workflow plan snapshot 内容与 fingerprint 不一致`
      + `（expected=${snapshot.workflowFingerprint}, current=${plan.workflowFingerprint}）`,
    )
  }
  // V3 的指纹输入取决于它有没有 reviewBudget：没有走 schema v2 那支，有就逐字复算 schema v3。
  // 两支都只用来核对已冻结的指纹，恢复出来的 IR 不再携带该键。
  const legacyReviewBudget = validateV3WorkflowPolicies(
    snapshot,
    (message) => { throw new DocumentGovernanceBindingError(message) },
  )
  const historical = legacyReviewBudget
    ? historicalV3WorkflowFingerprint(
        snapshot.workflowId, snapshot.executionModel, snapshot.workflow,
        snapshot.documentPolicy, documentGovernanceFingerprint,
      )
    : historicalV3PolicyWorkflowFingerprint(
        snapshot.workflowId, snapshot.executionModel, snapshot.workflow,
        snapshot.documentPolicy, documentGovernanceFingerprint,
      )
  if (historical !== snapshot.workflowFingerprint) {
    throw new DocumentGovernanceBindingError(
      `workflow plan snapshot 内容与 fingerprint 不一致`
      + `（expected=${snapshot.workflowFingerprint}, historical=${historical}）`,
    )
  }
  const { reviewBudget: _reviewBudget, ...workflow } = structuredClone(snapshot.workflow)
  return planFromIr(
    snapshot.workflowId,
    snapshot.executionModel,
    workflow,
    track,
    structuredClone(snapshot.documentPolicy),
    snapshot.workflowFingerprint,
  )
}
export function compileEffectiveWorkflowPlan(
  id: string,
  provided?: WorkflowDef,
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  if (isDefaultWorkflowName(id)) {
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
  if (isDefaultWorkflowName(id)) return compileEffectiveWorkflowPlan(id, loadDefaultOverride?.() ?? undefined, track)
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
