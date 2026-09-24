/**
 * 快照 readiness 与 `tenon status <c> --json` 的 `exits` 同一份判定：两处都调 kernel
 * `evaluateStepExitReport`，这里只把 server 的读取能力交进去，再把结果并进已有的 typed readiness。
 *
 * 出边 guard（guard-failed / 构建版本 / agent）在 readinessByTransition 里已有带类型的阻断，保留它们；
 * kernel 报告里其余来源（相位出口规则含 tasks.md、技能、文档、测试、规格迁移）以 `step-exit` 追加。
 * 判定本身抛错时不猜「可前进」：每条出边都挂一条 evaluation-error 的 step-exit 阻断。
 */
import {
  completedWorkflowSkillsSinceStepEntry,
  evaluateStepExitReport,
  HISTORY_FILE,
  judgeStepSkillsFromHistory,
  makeGuardFileContext,
  userSlug,
  type AgentBlocker,
  type EffectiveSkillResolver,
  type EffectiveWorkflowPlan,
  type FlowEngine,
  type PhaseExitFileContext,
  type PipelineState,
  type ReadinessByTransition,
  type StepBlocker,
  type TenonUser,
  type TestEvidenceContext,
  type TransitionContext,
  type TransitionReadinessBlocker,
} from '@tenon/kernel'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StepExitSnapshotDeps {
  readonly guardCheck: FlowEngine['guardCheck']
  /** 相位出口规则表的文件面（相对项目根）；undefined = 只判字段面。 */
  readonly fileContext: PhaseExitFileContext | undefined
  readonly testContext: TestEvidenceContext | undefined
  readonly skillResolver: EffectiveSkillResolver | undefined
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
      testEvidence: { context: input.deps.testContext },
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
 */
export function projectStepExitDeps(input: {
  readonly flow: Pick<FlowEngine, 'guardCheck'> | undefined
  readonly skillResolver: EffectiveSkillResolver | undefined
  readonly fileRoot: string
  readonly user: TenonUser | undefined
  readonly candidate: (() => Promise<string | undefined>) | undefined
}): ((changeName: string) => StepExitSnapshotDeps) | undefined {
  const flow = input.flow
  if (flow === undefined) return undefined
  const files = makeGuardFileContext(input.fileRoot, { automationRunner: false })
  const user = input.user
  const readCandidate = input.candidate
  const testContext: TestEvidenceContext | undefined = user === undefined
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
      }
  return (changeName) => ({
    guardCheck: (state, ctx) => flow.guardCheck(state, ctx),
    fileContext: files(changeName),
    testContext,
    skillResolver: input.skillResolver,
  })
}
