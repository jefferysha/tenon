/**
 * 快照 readiness 与 `tenon status <c> --json` 的 `exits` 同一份判定：两处都调 kernel
 * `evaluateStepExitReport`，这里只把 server 的读取能力交进去，再把结果并进已有的 typed readiness。
 *
 * 出边 guard（guard-failed / 构建版本 / agent）在 readinessByTransition 里已有带类型的阻断，保留它们；
 * kernel 报告里其余来源（相位出口规则含 tasks.md、技能、文档、测试、规格迁移）以 `step-exit` 追加。
 * 判定本身抛错时不猜「可前进」：每条出边都挂一条 evaluation-error 的 step-exit 阻断。
 */
import {
  changeStartOfFields,
  changedFilesResultForState,
  createChangedFilesSession,
  integrityDiffInSession,
  protectedChangesSinceChangeStart,
  completedWorkflowSkillsSinceStepEntry,
  evaluateStepExitReport,
  HISTORY_FILE,
  judgeStepSkillsFromHistory,
  makeGuardFileContext,
  userSlug,
  type AgentBlocker,
  type ChangedFilesSource,
  type EffectiveSkillResolver,
  type EffectiveWorkflowPlan,
  type FlowEngine,
  type IntegrityDiff,
  type IntegrityPathFilter,
  type PhaseExitFileContext,
  type PipelineState,
  type ProtectedChange,
  type ReadinessByTransition,
  type RecordChainCache,
  type StepBlocker,
  type TestEvidenceContext,
  type TransitionContext,
  type TransitionReadinessBlocker,
} from '@tenon/kernel'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvidenceUser } from './testEvidenceUser.js'

export interface StepExitSnapshotDeps {
  readonly guardCheck: FlowEngine['guardCheck']
  /** 相位出口规则表的文件面（相对项目根）；undefined = 只判字段面。 */
  readonly fileContext: PhaseExitFileContext | undefined
  readonly testContext: TestEvidenceContext | undefined
  readonly skillResolver: EffectiveSkillResolver | undefined
  /**
   * 自任务起点以来的改动文件（按该任务的 state 起点读）。项目扫描传同一个项目会话的读取器，
   * 这样一个项目里的所有任务共用 git 调用；缺省 = 逐次读取（只读单测、单任务调用）。
   */
  readonly changedFiles?: (state: PipelineState) => Promise<ChangedFilesSource>
  /** 同上，受保护测试配置的改动（评审门步骤的人工确认判定用）；项目扫描传同一个会话的读取器。 */
  readonly protectedChanges?: (state: PipelineState) => Promise<readonly ProtectedChange[]>
  /** 同上，相关测试文件的改动行（测试完整性）；项目扫描传同一个会话的读取器。 */
  readonly integrityDiff?: (state: PipelineState, accept: IntegrityPathFilter) => Promise<IntegrityDiff>
}

export interface StepExitReadinessInput {
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly root: string
  readonly changeDir: string
  readonly changeName: string
  readonly guardContext: Pick<TransitionContext, 'fileExists' | 'gitHeadSha' | 'workspaceFingerprint' | 'assessBuildRevision'>
  readonly agentBlockers: () => Promise<readonly AgentBlocker[]>
  readonly deps: StepExitSnapshotDeps
}

/** 出边 guard 与 agent 在 typed readiness 里已有表达；其余来源才需要追加。 */
function alreadyTyped(blocker: StepBlocker): boolean {
  return (blocker.source === 'guard' && blocker.code === 'guard-failed')
    || blocker.source === 'revision'
    || blocker.source === 'reviewer'
}

function toReadinessBlocker(blocker: StepBlocker): TransitionReadinessBlocker {
  return {
    kind: 'step-exit',
    source: blocker.source,
    code: blocker.code,
    message: blocker.message,
    ...(blocker.items === undefined || blocker.items.length === 0 ? {} : { items: blocker.items }),
  }
}

async function historyRaw(changeDir: string): Promise<string> {
  try {
    return await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function mergeBlockers(
  current: readonly TransitionReadinessBlocker[],
  extra: readonly TransitionReadinessBlocker[],
): readonly TransitionReadinessBlocker[] {
  const seen = new Set(current.map((item) => JSON.stringify(item)))
  const out = [...current]
  for (const item of extra) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export async function withStepExitReadiness(
  readiness: ReadinessByTransition,
  input: StepExitReadinessInput,
): Promise<ReadinessByTransition> {
  const phase = input.state.fields.phase
  const stepId = Array.isArray(phase) ? phase.join(',') : (phase ?? '')
  const current = readiness[stepId]
  if (current === undefined) return readiness
  let extraByEvent: ReadonlyMap<string, readonly TransitionReadinessBlocker[]>
  try {
    const report = await evaluateStepExitReport({
      repoRoot: input.root,
      changeName: input.changeName,
      changeDir: input.changeDir,
      state: input.state,
      plan: input.plan,
      guardCheck: input.deps.guardCheck,
      guardContext: input.guardContext,
      fileContext: input.deps.fileContext,
      // 与 CLI 的 testEvidenceContextFor 同源：自任务起点以来的改动文件（读不到时门禁以 files-diff-unavailable 阻塞）。
      testEvidence: {
        context: input.deps.testContext === undefined
          ? undefined
          : {
              ...input.deps.testContext,
              changedFiles: input.deps.testContext.changedFiles
                ?? (() => (input.deps.changedFiles ?? ((state) => changedFilesResultForState(input.root, state)))(input.state)),
              protectedChanges: input.deps.testContext.protectedChanges
                ?? (() => (input.deps.protectedChanges
                  ?? ((state) => protectedChangesSinceChangeStart(input.root, changeStartOfFields(state.fields))))(input.state)),
              integrityDiff: input.deps.testContext.integrityDiff
                ?? ((accept) => (input.deps.integrityDiff
                  ?? ((state, filter) => integrityDiffInSession(createChangedFilesSession(input.root), changeStartOfFields(state.fields))(filter)))(input.state, accept)),
            },
      },
      skills: async () => judgeStepSkillsFromHistory({
        resolver: input.deps.skillResolver,
        capability: input.plan.capabilities.skills,
        stepId,
        changeDir: input.changeDir,
        completed: new Set(completedWorkflowSkillsSinceStepEntry(await historyRaw(input.changeDir), stepId)),
        documentPolicy: input.plan.capabilities.documents.policy,
      }),
      agentBlockers: input.agentBlockers,
    })
    extraByEvent = new Map(report.exits.map((exit) => [
      exit.event,
      exit.blockers.filter((blocker) => !alreadyTyped(blocker)).map(toReadinessBlocker),
    ]))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed: TransitionReadinessBlocker = { kind: 'step-exit', source: 'guard', code: 'evaluation-error', message }
    extraByEvent = new Map(Object.keys(current).map((event) => [event, [failed]]))
  }
  const merged: Record<string, { ready: boolean; blockers: readonly TransitionReadinessBlocker[] }> = {}
  for (const [event, value] of Object.entries(current)) {
    const blockers = mergeBlockers(value.blockers, extraByEvent.get(event) ?? [])
    merged[event] = { ready: blockers.length === 0, blockers }
  }
  return { ...readiness, [stepId]: merged }
}

/**
 * 一个项目的 step-exit 读取能力：文件面相对项目真实路径（有界读取要校验祖先目录，进程内 fd 句柄路径过不了），
 * 身份与候选版本与测试投影同源。没有注入 flow（只读单测）时返回 undefined，readiness 只判出边 guard。
 * 按谁的记录判定由调用方逐任务传入（负责人优先，见 testEvidenceUser.ts）；不传则用 `input.user`。
 */
export function projectStepExitDeps(input: {
  readonly flow: Pick<FlowEngine, 'guardCheck'> | undefined
  readonly skillResolver: EffectiveSkillResolver | undefined
  readonly fileRoot: string
  readonly user: EvidenceUser | undefined
  readonly candidate: (() => Promise<string | undefined>) | undefined
  readonly changedFiles?: (state: PipelineState) => Promise<ChangedFilesSource>
  readonly protectedChanges?: (state: PipelineState) => Promise<readonly ProtectedChange[]>
  readonly integrityDiff?: (state: PipelineState, accept: IntegrityPathFilter) => Promise<IntegrityDiff>
  /** Skip re-reading and re-hashing record files whose identity has not moved (snapshot reads only). */
  readonly recordChainCache?: RecordChainCache
}): ((changeName: string, user?: EvidenceUser) => StepExitSnapshotDeps) | undefined {
  const flow = input.flow
  if (flow === undefined) return undefined
  const files = makeGuardFileContext(input.fileRoot, { automationRunner: false })
  const readCandidate = input.candidate
  const contextFor = (user: EvidenceUser | undefined): TestEvidenceContext | undefined => user === undefined
    ? undefined
    : {
        user: { id: user.id, name: user.name, slug: userSlug(user.id) },
        ...(readCandidate === undefined ? {} : {
          currentCandidate: async (): Promise<string> => {
            const candidate = await readCandidate()
            if (candidate === undefined) throw new Error('workspace fingerprint unavailable')
            return candidate
          },
        }),
        ...(input.recordChainCache === undefined ? {} : { recordChainCache: input.recordChainCache }),
      }
  return (changeName, user) => ({
    guardCheck: (state, ctx) => flow.guardCheck(state, ctx),
    fileContext: files(changeName),
    testContext: contextFor(user ?? input.user),
    skillResolver: input.skillResolver,
    ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
    ...(input.protectedChanges === undefined ? {} : { protectedChanges: input.protectedChanges }),
    ...(input.integrityDiff === undefined ? {} : { integrityDiff: input.integrityDiff }),
  })
}
