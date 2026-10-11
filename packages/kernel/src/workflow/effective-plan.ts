import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { compileDefaultWorkflow, compileWorkflow } from './compile.js'
import { documentGovernanceFingerprint } from './document-governance-fingerprint.js'
export { documentGovernanceFingerprint } from './document-governance-fingerprint.js'
import { loadWorkflow } from './loadWorkflow.js'
import type { WorkflowIR } from './ir.js'
import { parseWorkflow } from './parse.js'
import { freeze, planFingerprint, planFromIr, profileFor, type PlanOptions } from './effective-plan-build.js'
import {
  restoreLegacyWorkflowPlan,
  historicalV3PolicyWorkflowFingerprint,
  historicalV3WorkflowFingerprint,
  legacyWorkflowForSnapshot,
  validateSnapshotPolicies,
  validateV3WorkflowPolicies,
} from './effective-plan-snapshot-compat.js'
import type { WorkflowDef } from './types.js'
import { validateWorkflow } from './validate.js'
import { isDefaultWorkflowName } from './identifier.js'
import type { WorkflowPlanSnapshot } from './workflow-plan-snapshot-types.js'
import type {
  AutomationPolicyBits,
  EffectiveWorkflowPlan,
  PersistedDocumentGovernanceBinding,
} from './effective-plan-types.js'
export type { PlanOptions } from './effective-plan-build.js'
export type { AutomationPolicyBits, EffectiveWorkflowPlan, PersistedDocumentGovernanceBinding } from './effective-plan-types.js'
export type {
  LegacyWorkflowIR, WorkflowPlanSnapshot, WorkflowPlanSnapshotV1,
  WorkflowPlanSnapshotV2, WorkflowPlanSnapshotV3, WorkflowPlanSnapshotV4,
} from './workflow-plan-snapshot-types.js'
export class DocumentGovernanceBindingError extends Error {
  readonly _tag = 'DocumentGovernanceBindingError'
}

function assertValid(definition: WorkflowDef, origin: 'custom' | 'default'): void {
  const errors = validateWorkflow(definition, { origin })
  if (errors.length > 0) throw new Error(`effective workflow 无效：\n${errors.map((error) => `  - ${error}`).join('\n')}`)
}

export function workflowPlanSnapshot(plan: EffectiveWorkflowPlan): WorkflowPlanSnapshot {
  const definition = plan.definition ?? plan.workflow
  const currentFingerprint = planFingerprint(plan.id, plan.executionModel, definition, plan.documentPolicy)
  if (currentFingerprint !== plan.workflowFingerprint) {
    // 从旧快照恢复出来的计划再落盘时保持它原来的版本；生产路径只在 Change 创建时落盘，
    // 走的都是下面那条 v4 分支。
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
/**
 * 从冻结快照恢复计划：执行模型与指纹都取快照记着的值（旧快照保留 phase-manifest）。
 * `track` 是任务所在轨道；不给且冻结定义有分支时（只核对冻结内容、读工作流级策略的调用方）得到工作流级视图——
 * 不带步骤，策略与指纹仍是快照冻结的值。
 */
export function effectiveWorkflowPlanFromSnapshot(
  snapshot: WorkflowPlanSnapshot,
  track?: string,
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
        true,
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
      undefined,
      true,
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
    true,
  )
}
/** 新计划恒为 step-graph；`executionModel` 选项只给重建旧快照形状的计划用。 */
export function compileEffectiveWorkflowPlan(
  id: string,
  provided?: WorkflowDef,
  opts: PlanOptions = {},
): EffectiveWorkflowPlan {
  const executionModel = opts.executionModel ?? 'step-graph'
  if (isDefaultWorkflowName(id)) {
    // default 的编译契约允许 effective-phase-skills（default.yaml 的 phase policy 声明）；与执行模型无关。
    const definition = provided ?? parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    assertValid(definition, 'default')
    return planFromIr(id, executionModel, compileDefaultWorkflow(definition), opts.track)
  }
  if (provided === undefined) throw new Error(`workflow '${id}' 未找到`)
  assertValid(provided, 'custom')
  return planFromIr(id, executionModel, compileWorkflow(provided), opts.track)
}
export function loadEffectiveWorkflowPlan(
  repoRoot: string,
  id: string,
  opts: PlanOptions = {},
): EffectiveWorkflowPlan {
  const definition = loadWorkflow(repoRoot, id) ?? undefined
  return compileEffectiveWorkflowPlan(id, definition, opts)
}
export function effectiveWorkflowPlanFromIr(
  id: string,
  workflow: WorkflowIR,
  opts: PlanOptions = {},
): EffectiveWorkflowPlan {
  return planFromIr(id, opts.executionModel ?? 'step-graph', workflow, opts.track)
}
export function resolveEffectiveWorkflowPlan(
  id: string,
  loadCompiled: (name: string) => WorkflowIR | null,
  opts: PlanOptions = {},
  /** default 的项目覆盖读取器（返回 null = 无覆盖 → 内建模板）。缺省保持旧行为：恒用内建。 */
  loadDefaultOverride?: () => WorkflowDef | null,
): EffectiveWorkflowPlan | null {
  if (isDefaultWorkflowName(id)) return compileEffectiveWorkflowPlan(id, loadDefaultOverride?.() ?? undefined, opts)
  const workflow = loadCompiled(id)
  return workflow === null ? null : effectiveWorkflowPlanFromIr(id, workflow, opts)
}
/**
 * 已存在的任务（`track` 来自任务状态）的生效计划，给 AFK 资格 / 挂队这类授权用途：冻结快照优先
 * （执行模型与分支都取自它——快照足以支撑在途任务走完），没有快照才读现行定义。
 * 工作流不存在 → 抛错；有分支的工作流里没有任务的轨道 → UnknownTrackError。不核对文档治理绑定。
 */
export function requireRunPlan(
  workflowName: string,
  track: string,
  snapshot: WorkflowPlanSnapshot | undefined,
  loadCompiled: (name: string) => WorkflowIR | null,
): EffectiveWorkflowPlan {
  if (snapshot !== undefined && snapshot.workflowId !== workflowName) {
    throw new DocumentGovernanceBindingError(
      `workflow plan snapshot identity 不一致：已绑定 '${snapshot.workflowId}'，当前 '${workflowName}'`,
    )
  }
  if (snapshot !== undefined) return effectiveWorkflowPlanFromSnapshot(snapshot, track)
  const compiled = loadCompiled(workflowName)
  if (compiled === null) throw new Error(`workflow '${workflowName}' 未找到`)
  return effectiveWorkflowPlanFromIr(workflowName, compiled, { track })
}
/** 计划里的自动化设置，换成 AFK 队列与规格完成自动入队读取的策略位形状。 */
export function planAutomationPolicy(plan: EffectiveWorkflowPlan): AutomationPolicyBits {
  const { eligible, autoEnqueueOnSpecComplete } = plan.capabilities.automation
  return { automationEligible: eligible, autoEnqueueOnSpecComplete }
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
  track?: string,
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
    plan = resolveEffectiveWorkflowPlan(id, loadCompiled, { track })
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
