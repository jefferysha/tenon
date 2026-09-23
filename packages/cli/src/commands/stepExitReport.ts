/**
 * 当前步骤每条出边的就绪判定，结构化版本。
 *
 * 判定源与 `tenon check` / transition 完全相同（guard 求值器、技能门、文档台账、测试证据、
 * agent 台账、规格迁移回执），这里只把「过 / 不过」摊成 skill 能照做的 per-exit blocker 列表。
 */
import {
  evaluateDefaultEventPreconditions, evaluateDocumentEvidence, evaluateSpecMigrationEvidence,
  evaluateWorkflowIrStepGuards, effectiveLifecyclePolicy, isDocumentContractPhase,
  isDocumentPolicyStep, isForwardExit, renderAgentBlocker, resolveStep, stepExitTransitions,
  type DocumentEvidenceReport, type EffectiveWorkflowPlan, type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { phaseExitGuardContext } from './phaseExitGuard.js'
import { stepAgentBlockersFor } from '../agentGate.js'
import { judgeStepSkills, missingStepSkillMessages, type StepSkillSlotProgress } from '../stepSkillGate.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { resolveBuildRevisionAssessor } from './buildRevisionAssessor.js'

export type BlockerSource = 'guard' | 'document' | 'skill' | 'test' | 'reviewer' | 'revision' | 'spec'

export interface StepBlocker {
  readonly source: BlockerSource
  readonly code: string
  readonly message: string
}

export interface StepExit {
  readonly event: string
  readonly to: string
  readonly direction: 'forward' | 'back' | 'completion'
  readonly ready: boolean
  readonly blockers: readonly StepBlocker[]
}

export interface StepExitReport {
  readonly exits: readonly StepExit[]
  readonly documents: DocumentEvidenceReport | undefined
  readonly tests: readonly string[]
  readonly reviewers: readonly StepBlocker[]
  /** 本步未满足的必需技能槽；transition 用同一份判定拒绝离开本步。 */
  readonly skills: readonly StepBlocker[]
  /** 本次进入该步骤之后已调用的技能 id（`tenon` 是否已加载从这里读）。 */
  readonly completedSkillIds: ReadonlySet<string>
  /** 每个必需技能槽的完成度（调用 + 本步绑定的文档）；status 的技能分块据此排状态。 */
  readonly skillSlots: readonly StepSkillSlotProgress[]
}

const IMPLICIT_COMPLETION_EVENT = 'archived'

function blocker(source: BlockerSource, code: string, message: string): StepBlocker {
  return { source, code, message }
}

async function documentEvidence(
  deps: CliDeps,
  dir: string,
  stepId: string,
  plan: EffectiveWorkflowPlan,
): Promise<DocumentEvidenceReport | undefined> {
  const policy = plan.capabilities.documents.policy
  if (policy === undefined || !isDocumentPolicyStep(policy, stepId)) return undefined
  if (policy.id === 'openspec-v1' && deps.documentEvidence && isDocumentContractPhase(stepId)) {
    return deps.documentEvidence(deps.cwd, dir, stepId)
  }
  return evaluateDocumentEvidence(deps.cwd, dir, stepId, {}, policy)
}

async function guardBlockers(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  event: string,
  to: string,
): Promise<readonly StepBlocker[]> {
  const fileContext = deps.guardCtx?.(name)
  const workspaceFingerprint = deps.workspaceFingerprint
  const context = {
    fileExists: fileContext?.fileExists,
    gitHeadSha: deps.gitHeadSha,
    workspaceFingerprint: workspaceFingerprint === undefined
      ? undefined
      : () => workspaceFingerprint(name),
    specMigrationStatus: () => evaluateSpecMigrationEvidence(deps.cwd, dir, name),
    assessBuildRevision: resolveBuildRevisionAssessor(deps, name, dir),
  }
  if (plan.capabilities.execution.model === 'phase-manifest') {
    const result = await evaluateDefaultEventPreconditions(
      event as Parameters<typeof evaluateDefaultEventPreconditions>[0],
      state,
      context,
      { stopOnFirstFailure: false },
    )
    if (result === null) return []
    const revision = (result.blockers ?? []).map((item) =>
      blocker('revision', item.code, `${item.reason}；${item.remediation}`))
    return [
      ...result.lines.map((line) => blocker('guard', 'guard-failed', line)),
      ...revision,
    ]
  }
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
  const result = await evaluateWorkflowIrStepGuards(state, { ...step, guards }, {
    changeDirAbs: dir,
    ...context,
  })
  return result.failures.map((failure) => blocker('guard', 'guard-failed', failure))
}

/**
 * 一条边的证据面。退回边只要求那条边自己的 guard：修问题的路必须一直开着，否则失败的验证就没有
 * 回到实现的通道（同 `tenon check` 与 transition 的既有口径）。
 */
export async function evaluateStepExitReport(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
): Promise<StepExitReport> {
  const stepId = str(state.fields.phase)
  const documents = await documentEvidence(deps, dir, stepId, plan)
  const testReport = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd,
    changeDir: dir,
    changeName: name,
    plan,
    stepId,
    context: testEvidenceContextFor(deps, name),
  })
  // 技能门对退回边同样生效（rejectOnStepGates 不分方向），所以它进 perExit 而非 shared。
  const judgement = await judgeStepSkills({
    deps, changeDir: dir, stepId, capability: plan.capabilities.skills, recordEvidence: false,
    documentPolicy: plan.capabilities.documents.policy,
  })
  const skills = missingStepSkillMessages(judgement.slots)
    .map((message) => blocker('skill', 'skill-incomplete', `尚未完成声明的 skill：${message}`))
  const agentBlockers = await stepAgentBlockersFor({ deps, name, dir, stepId, plan, state })
  const reviewers = agentBlockers.map((item) =>
    blocker('reviewer', item.kind, renderAgentBlocker(item, name)))
  const migration = stepId === 'ship' && plan.capabilities.documents.governed
    ? await evaluateSpecMigrationEvidence(deps.cwd, dir, name)
    : undefined
  // default 轨的相位出口规则表（kernel flow/guard.ts）此前只有 `tenon check` 评估：同一份状态上
  // check 说 FAIL exit 2，这里的 `ready` 却是 true、blockers 空，于是 `next` 发的是 transition 而
  // 不是带真实文案的 fix。规则是「离开本相位」的条件，只加给前进边。
  const phaseExit = plan.capabilities.execution.model === 'phase-manifest'
    ? deps.flow.guardCheck(state, {
      ...await phaseExitGuardContext(deps.guardCtx?.(name), dir),
      coverageProfile: plan.capabilities.track.coverageProfile,
    })
    : { pass: true, failures: [] as readonly string[] }
  const shared: readonly StepBlocker[] = [
    ...phaseExit.failures.map((item) => blocker('guard', 'phase-exit', item)),
    ...(documents?.blockers ?? []).map((item) => blocker('document', 'document-evidence', item)),
    ...testReport.blockers.map((item) => blocker('test', 'test-evidence', item)),
    ...reviewers,
    ...(migration?.kind === 'invalid' ? [blocker('spec', 'migration', migration.reason)] : []),
  ]

  const exits: StepExit[] = []
  for (const transition of stepExitTransitions(plan, stepId, state)) {
    const forward = isForwardExit(plan, stepId, transition.to, transition.event)
    const direction = transition.event === IMPLICIT_COMPLETION_EVENT && transition.to === stepId
      ? 'completion'
      : forward ? 'forward' : 'back'
    const guards = await guardBlockers(
      deps, name, dir, state, plan, stepId, transition.event, transition.to)
    const blockers = forward ? [...guards, ...skills, ...shared] : [...guards, ...skills]
    exits.push({
      event: transition.event,
      to: transition.to,
      direction,
      ready: blockers.length === 0,
      blockers,
    })
  }
  return {
    exits, documents, tests: testReport.blockers, reviewers, skills,
    completedSkillIds: judgement.completedSkillIds, skillSlots: judgement.slots,
  }
}
