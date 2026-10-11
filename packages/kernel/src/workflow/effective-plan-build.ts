/**
 * 生效计划的构造：把编译好的工作流 + 任务所在轨道折成一份冻结的 `EffectiveWorkflowPlan`。
 * 计划只认工作流自己的分支（`tracks.<id>` 的 spec / route / automation），不查任何独立的轨道登记表；
 * 新计划恒为 step-graph，phase-manifest 只给重建旧快照用。快照读写、绑定核对在 effective-plan.ts。
 */
import { sha256Hex } from '../sha256.js'
import type { DocumentProfileId } from '../types.js'
import { documentGovernancePolicy, type DocumentGovernancePolicy } from './document-contract.js'
import { documentGovernanceFingerprint } from './document-governance-fingerprint.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { WorkflowIR } from './ir.js'
import { legacyPlanTrack } from './legacy-phase-manifest/legacy-track-policy.js'
import { resolveRunTrack, type TrackBranch } from './resolve-track.js'
import type { TrackAutomation } from './types.js'

export type ExecutionModel = EffectiveWorkflowPlan['executionModel']

/** 编译一份生效计划的选项。 */
export interface PlanOptions {
  /** 任务所在轨道：有分支的工作流必须给（缺省或不存在 → UnknownTrackError），平铺工作流忽略。 */
  readonly track?: string
  /** 只有重建旧快照形状的计划时才给；缺省（新计划）恒为 step-graph。 */
  readonly executionModel?: ExecutionModel
}

export function profileFor(policy: DocumentGovernancePolicy | undefined): DocumentProfileId | undefined {
  return policy?.id === 'openspec-v1' ? 'legacy-full' : policy?.id === 'document-v1' ? 'document-v1' : undefined
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const skillPolicyOf = (executionModel: ExecutionModel): EffectiveWorkflowPlan['skillPolicy'] =>
  executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared'
const reviewStepsOf = (steps: WorkflowIR['steps']): string[] => steps.filter((step) => step.gate === 'review').map((step) => step.id)
const projectionStepsOf = (steps: WorkflowIR['steps']): Array<{ id: string; label: string }> => steps.map((step) => ({ id: step.id, label: step.label }))

/** 计划指纹：只由工作流自己的行为决定（任务所在轨道不进指纹，分支内容随整份定义进指纹）。 */
export function planFingerprint(
  id: string,
  executionModel: ExecutionModel,
  compiled: WorkflowIR,
  documentPolicy: DocumentGovernancePolicy | undefined,
): string {
  return sha256Hex(JSON.stringify({
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
    skillPolicy: skillPolicyOf(executionModel),
    reviewSteps: reviewStepsOf(compiled.steps),
    projectionSteps: projectionStepsOf(compiled.steps),
  }))
}

/**
 * 选中分支后的运行时 pipeline：分支的步骤与文档契约提到顶层，`openspec` 按分支的 spec 折算，tracks 去掉。
 * `branch === null` = 工作流级视图（没有任务语境的快照核对）：不带步骤，策略与指纹都是冻结值。
 */
function branchPipeline(compiled: WorkflowIR, branch: TrackBranch | null): WorkflowIR {
  const { tracks: _tracks, documentContract: _documentContract, openspec: _openspec, ...rest } = compiled
  if (branch === null) return { ...rest, steps: [] }
  return {
    ...rest,
    ...(branch.spec === 'openspec' ? { openspec: true as const } : {}),
    ...(branch.documentContract === undefined ? {} : { documentContract: branch.documentContract }),
    steps: branch.steps,
  }
}

/** 分支在 YAML 里**写了**的 automation（没写 = undefined）；旧引擎计划靠它覆盖旧表。 */
function declaredAutomation(compiled: WorkflowIR, trackId: string | undefined): TrackAutomation | undefined {
  const tracks = compiled.tracks
  if (tracks === undefined || trackId === undefined || !Object.hasOwn(tracks, trackId)) return undefined
  return tracks[trackId]?.automation
}

/**
 * 新计划的自动化设置只读分支声明；没声明 = 不可进入 AFK（失败关闭）。`default` 与别的工作流同一规则：
 * 它的 pm / frontend / backend 在 default.yaml 里自己写着 `automation`。
 */
function branchAutomation(branch: TrackBranch | null): EffectiveWorkflowPlan['capabilities']['automation'] {
  if (branch === null) return { eligible: false, autoEnqueueOnSpecComplete: false }
  return { eligible: branch.automation.eligible, autoEnqueueOnSpecComplete: branch.automation.enqueueAfterSpec }
}

export function planFromIr(
  id: string,
  executionModel: ExecutionModel,
  compiled: WorkflowIR,
  track: string | undefined,
  frozenDocumentPolicy?: DocumentGovernancePolicy | null,
  frozenWorkflowFingerprint?: string,
  /** 没有任务语境的快照核对：有分支的冻结定义不选分支，拿工作流级视图。 */
  workflowLevel = false,
): EffectiveWorkflowPlan {
  const trackId = track === '' ? undefined : track
  const hasBranches = Object.keys(compiled.tracks ?? {}).length > 0
  const branch = workflowLevel && trackId === undefined && hasBranches ? null : resolveRunTrack(compiled, trackId)
  const workflow = branchPipeline(compiled, branch)
  const documentPolicy = frozenDocumentPolicy === undefined
    ? documentGovernancePolicy(id, compiled, trackId)
    : frozenDocumentPolicy ?? undefined
  const skillPolicy = skillPolicyOf(executionModel)
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
        ...(ref.host === undefined ? {} : { host: ref.host }),
      })),
    }))
  const projectionSteps = projectionStepsOf(workflow.steps)
  const stepLabelSource = executionModel === 'phase-manifest' ? 'localized-builtin' : 'workflow-defined'
  const workflowFingerprint = frozenWorkflowFingerprint ?? planFingerprint(id, executionModel, compiled, documentPolicy)
  const documentProfile = profileFor(documentPolicy)
  const legacy = executionModel === 'phase-manifest' ? legacyPlanTrack(trackId, declaredAutomation(compiled, trackId)) : undefined
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
            dependsOnDeclared: skill.depends_on !== undefined,
          })),
        })),
      },
      documents: {
        governed: documentPolicy !== undefined,
        ...(documentProfile === undefined ? {} : { profile: documentProfile }),
        ...(documentPolicy === undefined ? {} : { policy: documentPolicy }),
      },
      review: { steps: reviewSteps },
      agents: { steps: agentSteps },
      automation: legacy?.automation ?? branchAutomation(branch),
      track: {
        id: trackId ?? null,
        coverageProfile: legacy?.coverageProfile ?? 'none',
        routingEnabled: branch?.route !== undefined,
      },
    },
    projection: {
      steps: projectionSteps,
      stepLabelSource,
    },
  })
}
