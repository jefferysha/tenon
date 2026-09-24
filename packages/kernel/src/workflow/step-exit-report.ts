/**
 * 当前步骤每条出边的就绪判定，结构化版本——`tenon status <c> --json` 的 `exits`、`tenon check`
 * 的预览与 Dashboard 快照的 readiness 读的是这一份实现。
 *
 * 判定源与 transition 完全相同（guard 求值器、相位出口规则表、技能门、文档台账、测试证据、agent
 * 台账、规格迁移回执），这里只把「过 / 不过」摊成 per-exit blocker 列表。各宿主只提供读取能力
 * （文件面、身份、历史、agent 投影），组合规则只在这里：两处各写一遍，就会出现 CLI 说有 5 个阻断、
 * 工作台却说「可进入下一阶段」。
 */
import { evaluateDefaultEventPreconditions } from '../flow/default-event-policy.js'
import type { TransitionContext } from '../flow/transition-table.js'
import { evaluateDocumentEvidence, type DocumentEvidenceReport } from '../state/document-evidence.js'
import {
  documentRecordsInCurrentStepVisit, judgeStepSkillSlots, missingStepSkillMessages, type StepSkillSlotProgress,
} from '../state/skill-document-binding.js'
import { evaluateSpecMigrationEvidence } from '../state/spec-migration-evidence.js'
import { evaluateTestEvidence, type TestEvidenceContext } from '../test-evidence/evaluate.js'
import type { TestEvidenceReader } from '../test-evidence/transition-gate.js'
import type { FlowEngine, PipelineState } from '../types.js'
import { isForwardExit, renderAgentBlocker, type AgentBlocker } from './agent-verdict.js'
import { isDocumentContractPhase, type DocumentContractPhase } from './document-contract-model.js'
import { isDocumentPolicyStep } from './document-contract.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import { resolveRequiredSkillSlots, type EffectiveSkillResolver } from './effective-skill-resolver.js'
import { resolveStep } from './engine.js'
import { effectiveLifecyclePolicy } from './governed-lifecycle-policy.js'
import { stepExitTransitions } from './implicit-completion.js'
import { phaseExitGuardContext, unfinishedTaskItems, type PhaseExitFileContext } from './phase-exit-context.js'
import { evaluateWorkflowIrStepGuards } from './stepGuard.js'

export type StepBlockerSource = 'guard' | 'document' | 'skill' | 'test' | 'reviewer' | 'revision' | 'spec' | 'tasks'

export interface StepBlocker {
  readonly source: StepBlockerSource
  readonly code: string
  readonly message: string
  /** 仅 `source: tasks`：截至本步仍未勾选的任务原文（tasks.md 顺序）。 */
  readonly items?: readonly string[]
}

export interface StepExit {
  readonly event: string
  readonly to: string
  readonly direction: 'forward' | 'back' | 'completion'
  readonly ready: boolean
  readonly blockers: readonly StepBlocker[]
}

export interface StepSkillJudgement {
  /** 本次进入该步骤之后已调用的技能 id（`tenon` 是否已加载也从这里读）。 */
  readonly completedSkillIds: ReadonlySet<string>
  readonly slots: readonly StepSkillSlotProgress[]
}

export interface StepExitReport {
  readonly exits: readonly StepExit[]
  readonly documents: DocumentEvidenceReport | undefined
  readonly tests: readonly string[]
  readonly reviewers: readonly StepBlocker[]
  /** 本步未满足的必需技能槽；transition 用同一份判定拒绝离开本步。 */
  readonly skills: readonly StepBlocker[]
  readonly completedSkillIds: ReadonlySet<string>
  readonly skillSlots: readonly StepSkillSlotProgress[]
}

export interface StepExitReportInput {
  readonly repoRoot: string
  readonly changeName: string
  readonly changeDir: string
  readonly state: PipelineState
  readonly plan: EffectiveWorkflowPlan
  /** 相位出口规则表（kernel flow/guard.ts）；宿主注入同一个 FlowEngine。 */
  readonly guardCheck: FlowEngine['guardCheck']
  /** 出边 guard 的读取能力；缺席的能力按 guard 既有语义降级。 */
  readonly guardContext: Pick<TransitionContext, 'fileExists' | 'gitHeadSha' | 'workspaceFingerprint' | 'assessBuildRevision'>
  /** 相位出口规则表的文件面；undefined = 只判字段面。 */
  readonly fileContext: PhaseExitFileContext | undefined
  /** OpenSpec 文档证据的替换读取器（仅单测）；缺省读权威台账。 */
  readonly documentEvidence?: (root: string, changeDir: string, phase: DocumentContractPhase) => Promise<DocumentEvidenceReport>
  readonly testEvidence: { readonly reader?: TestEvidenceReader; readonly context: TestEvidenceContext | undefined }
  readonly skills: () => Promise<StepSkillJudgement>
  readonly agentBlockers: () => Promise<readonly AgentBlocker[]>
}

const IMPLICIT_COMPLETION_EVENT = 'archived'

function blocker(source: StepBlockerSource, code: string, message: string): StepBlocker {
  return { source, code, message }
}

/** 没有宿主回执时的技能判定：history 里的受理记录 + 本次访问已登记的文档。 */
export async function judgeStepSkillsFromHistory(input: {
  readonly resolver: EffectiveSkillResolver | undefined
  readonly capability: EffectiveWorkflowPlan['capabilities']['skills']
  readonly stepId: string
  readonly changeDir: string
  readonly completed: ReadonlySet<string>
  readonly documentPolicy: EffectiveWorkflowPlan['capabilities']['documents']['policy']
}): Promise<StepSkillJudgement> {
  const visitRecords = input.documentPolicy === undefined
    ? []
    : await documentRecordsInCurrentStepVisit(input.changeDir)
  return {
    completedSkillIds: input.completed,
    slots: judgeStepSkillSlots({
      slots: resolveRequiredSkillSlots(input.resolver, input.capability, input.stepId),
      completed: input.completed,
      policy: input.documentPolicy,
      stepId: input.stepId,
      visitRecords,
    }),
  }
}

async function documentEvidence(input: StepExitReportInput, stepId: string): Promise<DocumentEvidenceReport | undefined> {
  const policy = input.plan.capabilities.documents.policy
  if (policy === undefined || !isDocumentPolicyStep(policy, stepId)) return undefined
  if (policy.id === 'openspec-v1' && input.documentEvidence && isDocumentContractPhase(stepId)) {
    return input.documentEvidence(input.repoRoot, input.changeDir, stepId)
  }
  return evaluateDocumentEvidence(input.repoRoot, input.changeDir, stepId, {}, policy)
}

async function guardBlockers(
  input: StepExitReportInput,
  stepId: string,
  event: string,
  to: string,
): Promise<readonly StepBlocker[]> {
  const { plan, state } = input
  const context = {
    ...input.guardContext,
    specMigrationStatus: () => evaluateSpecMigrationEvidence(input.repoRoot, input.changeDir, input.changeName),
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
    changeDirAbs: input.changeDir,
    ...context,
  })
  return result.failures.map((failure) => blocker('guard', 'guard-failed', failure))
}

/**
 * 一条边的证据面。退回边只要求那条边自己的 guard 与技能门：修问题的路必须一直开着，否则失败的
 * 验证就没有回到实现的通道（同 `tenon check` 与 transition 的既有口径）。
 */
export async function evaluateStepExitReport(input: StepExitReportInput): Promise<StepExitReport> {
  const { plan, state } = input
  const phase = state.fields.phase
  const stepId = Array.isArray(phase) ? phase.join(',') : (phase ?? '')
  const documents = await documentEvidence(input, stepId)
  const testReport = await (input.testEvidence.reader ?? evaluateTestEvidence)({
    repoRoot: input.repoRoot,
    changeDir: input.changeDir,
    changeName: input.changeName,
    plan,
    stepId,
    context: input.testEvidence.context,
  })
  // 技能门对退回边同样生效（rejectOnStepGates 不分方向），所以它进 perExit 而非 shared。
  const judgement = await input.skills()
  const skills = missingStepSkillMessages(judgement.slots)
    .map((message) => blocker('skill', 'skill-incomplete', `尚未完成声明的 skill：${message}`))
  const reviewers = (await input.agentBlockers()).map((item) =>
    blocker('reviewer', item.kind, renderAgentBlocker(item, input.changeName)))
  const migration = stepId === 'ship' && plan.capabilities.documents.governed
    ? await evaluateSpecMigrationEvidence(input.repoRoot, input.changeDir, input.changeName)
    : undefined
  // default 轨的相位出口规则表是「离开本相位」的条件，只加给前进边。
  const phaseManifest = plan.capabilities.execution.model === 'phase-manifest'
  const exitContext = phaseManifest ? await phaseExitGuardContext(input.fileContext, input.changeDir) : undefined
  const phaseExit = phaseManifest
    ? input.guardCheck(state, { ...exitContext, coverageProfile: plan.capabilities.track.coverageProfile })
    : { pass: true, failures: [] as readonly string[] }
  const openTasks = unfinishedTaskItems(exitContext, input.fileContext?.changeDirRel, stepId)
  const shared: readonly StepBlocker[] = [
    // tasks.md 的勾选是本步的工作项，不是一个可填的字段：单列成 `tasks` 来源，`next` 才能把它排在
    // 自由文本字段（pr_url 等）之前。
    ...phaseExit.failures.map((item) => item.includes('tasks.md')
      ? { ...blocker('tasks', 'tasks-incomplete', item), items: openTasks }
      : blocker('guard', 'phase-exit', item)),
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
    const guards = await guardBlockers(input, stepId, transition.event, transition.to)
    const blockers = forward ? [...guards, ...skills, ...shared] : [...guards, ...skills]
    exits.push({ event: transition.event, to: transition.to, direction, ready: blockers.length === 0, blockers })
  }
  return {
    exits, documents, tests: testReport.blockers, reviewers, skills,
    completedSkillIds: judgement.completedSkillIds, skillSlots: judgement.slots,
  }
}
