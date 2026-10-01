/**
 * One change of one project, read into a snapshot row.
 *
 * Two tiers share one code path. The list tier is what every row, the progress board and the inbox render;
 * the full tier adds the per-change evidence (documents, skill / agent runs, tests, test policy, the rules'
 * policy block, the tasks text) that only an open task reads. A project scan builds the list tier for every
 * change; the full tier is built for one change on demand, or for every change when a caller still asks for
 * the whole `GET /api/snapshot`.
 *
 * Everything that is the same for all changes of a project lives in the scan context: the git session, the
 * acting user, the candidate fingerprint, the per-plan rules and the resolved plans. A context is one point in
 * time; nothing in it outlives the scan that created it.
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  changeStartOfFields, createChangedFilesSession, createRecordChainCache, creatorOf, integrityDiffInSession, isTenonUser, ownerOf,
  projectPipelineTodo, protectedChangesInSession, stateStorageSourcePathSync, touchedPathClasses, UnsupportedRunStateVersionError,
  type ChangedFilesSession, type EffectiveWorkflowPlan, type PipelineState, type TenonUser, type TrackDefinition,
} from '@tenon/kernel'
import { agentBlockersOf, projectAgentRuns } from './agentRuns.js'
import { projectReviewHandshake } from './reviewHandshake.js'
import { documentEvidence, documentTodoItems, projectArtifactScopeIssue, readTerminalActivity, type SnapshotDeps } from './snapshot.js'
import { projectSkillRuns, resolveSnapshotTrack } from './skillRuns.js'
import { readTasksProjection } from './snapshotTasks.js'
import { defaultResolveUser } from './serverUserRoutes.js'
import { projectStepExitDeps, type StepExitSnapshotDeps } from './stepExitReadiness.js'
import { createCandidateCache } from './testCandidateCache.js'
import { projectTestEvidence } from './testEvidenceSnapshot.js'
import { evidenceUserFor, type EvidenceUser } from './testEvidenceUser.js'
import type { ChangeSnapshot, LegacyWorkflowRulesSnapshot } from './types.js'
import type { ChangeListSnapshot, ListWorkflowRulesSnapshot } from './snapshotListTypes.js'
import { readWorkflowSnapshotAuthority } from './workflowSnapshotAuthority.js'
import {
  legacySnapshotWorkflowRules, resolveSnapshotEffectivePlan, snapshotTodoStages, snapshotWorkflowExecution,
  snapshotWorkflowRulesAtRoot, snapshotWorkflowRulesStructure, type WorkflowSnapshotCapabilityDeps,
} from './workflowSnapshot.js'
import { assertWorkflowRootAnchor, anchorChildProcessPath, type WorkflowRootAnchor } from './workflowRootAnchor.js'

/** 快照扫描里单个 git 命令的超时：一个卡住的仓库最多拖住它自己的项目这么久，其余命令随即放弃。 */
export const SNAPSHOT_GIT_TIMEOUT_MS = 8_000

export type SnapshotTier = 'list' | 'full'

/**
 * Record chains are read on every scan of every change; the chain cache skips re-reading and re-hashing files whose
 * identity (inode, size, mtime, ctime) has not moved. One per process: paths are absolute and the stamps are per file.
 */
const recordChains = createRecordChainCache()

function str(v: string | string[] | undefined): string { return Array.isArray(v) ? v.join(',') : v ?? '' }

export interface ProjectScanContext {
  readonly deps: SnapshotDeps
  readonly root: string
  readonly readRoot: string
  readonly anchor: WorkflowRootAnchor
  readonly nowMs: number
  readonly changesRoot: string
  readonly displayChangesRoot: string
  readonly changedFiles: ChangedFilesSession
  /** The `changesRoot` of a change directory named `name`. */
  changeDir(name: string): string
  /** The user whose test records and archive the snapshot is judged for; undefined when no identity is declared. */
  readonly actingUser: TenonUser | undefined
  trackDefinition(trackId: string, workflowName: string): TrackDefinition | undefined
  /** The frozen plan a change runs on, shared by every change bound to the same plan in this scan. */
  planFor(state: PipelineState, workflowName: string, track: string): EffectiveWorkflowPlan
  /** The plan-derived rules, shared by identity by every change bound to the same plan. */
  listRulesFor(plan: EffectiveWorkflowPlan): ListWorkflowRulesSnapshot
  /** The pre-v1.0.1 rules shape for the project-level compatibility table; full tier only. */
  legacyRulesFor(plan: EffectiveWorkflowPlan): LegacyWorkflowRulesSnapshot
  readonly capabilityDeps: WorkflowSnapshotCapabilityDeps
  readonly candidate: (() => Promise<string | undefined>) | undefined
  readonly stepExitsFor: ((changeName: string, user?: EvidenceUser) => StepExitSnapshotDeps) | undefined
}

export function createProjectScanContext(
  deps: SnapshotDeps,
  root: string,
  readRoot: string,
  anchor: WorkflowRootAnchor,
  nowMs: number,
): ProjectScanContext {
  // git runs in a child process, so every probe takes the anchor's real path, never readRoot.
  const childProcessRoot = anchorChildProcessPath(anchor)
  const changesRoot = join(readRoot, 'openspec', 'changes')
  let gitHeadPromise: Promise<string> | undefined
  const workspaceFingerprints = new Map<string, Promise<string>>()
  const trackDefinitions = new Map<string, TrackDefinition | undefined>()
  const gitHeadSha = deps.gitHeadSha
  const workspaceFingerprint = deps.workspaceFingerprint
  const capabilityDeps: WorkflowSnapshotCapabilityDeps = {
    childProcessRoot,
    ...(deps.fileExists === undefined ? {} : { fileExists: deps.fileExists }),
    ...(deps.assessBuildRevision === undefined ? {} : { assessBuildRevision: deps.assessBuildRevision }),
    ...(gitHeadSha === undefined
      ? {}
      : {
          gitHeadSha: () => {
            gitHeadPromise ??= gitHeadSha(childProcessRoot)
            return gitHeadPromise
          },
        }),
    ...(workspaceFingerprint === undefined
      ? {}
      : {
          workspaceFingerprint: (_root, changeName) => {
            let pending = workspaceFingerprints.get(changeName)
            if (pending === undefined) {
              pending = workspaceFingerprint(readRoot, changeName)
              workspaceFingerprints.set(changeName, pending)
            }
            return pending
          },
        }),
  }
  // 候选版本对整个 root 只算一次（TTL 内复用）：测试新鲜度判定需要它，但指纹遍历整棵树。
  const resolved = (deps.resolveUser ?? defaultResolveUser)(root)
  const actingUser = isTenonUser(resolved) ? resolved : undefined
  // 能力缺席时不传 candidate（判定跳过候选比对），而不是传一个恒 undefined 的读取器。
  const candidateCache = workspaceFingerprint === undefined
    ? undefined
    : createCandidateCache((target) => workspaceFingerprint(target, ''))
  const candidate = candidateCache === undefined ? undefined : (): Promise<string | undefined> => candidateCache(readRoot)
  // 同一个项目的所有任务共用一个 git 会话：相同的 git 命令只跑一次，超时后其余任务直接失败而不是各等一遍。
  const changedFiles = createChangedFilesSession(childProcessRoot, { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS })
  const stepExitsFor = projectStepExitDeps({
    flow: deps.flow,
    skillResolver: deps.skillResolverFor?.(root),
    fileRoot: childProcessRoot,
    user: actingUser,
    candidate,
    changedFiles: (state) => changedFiles.changedFiles(changeStartOfFields(state.fields)),
    protectedChanges: (state) => protectedChangesInSession(readRoot, changedFiles, changeStartOfFields(state.fields)),
    integrityDiff: (state, accept) => integrityDiffInSession(changedFiles, changeStartOfFields(state.fields))(accept),
    recordChainCache: recordChains,
  })
  const trackDefinition = (trackId: string, workflowName: string): TrackDefinition | undefined => {
    const key = `${workflowName}\u0000${trackId}`
    if (!trackDefinitions.has(key)) trackDefinitions.set(key, resolveSnapshotTrack(readRoot, trackId, workflowName))
    return trackDefinitions.get(key)
  }
  const plans = new Map<string, EffectiveWorkflowPlan>()
  const listRules = new Map<EffectiveWorkflowPlan, ListWorkflowRulesSnapshot>()
  const legacyRules = new Map<EffectiveWorkflowPlan, LegacyWorkflowRulesSnapshot>()
  return {
    deps, root, readRoot, anchor, nowMs, changesRoot, changedFiles, actingUser, capabilityDeps, candidate, stepExitsFor,
    trackDefinition,
    displayChangesRoot: join(root, 'openspec', 'changes'),
    changeDir: (name) => join(changesRoot, name),
    // A plan is a function of its identity (workflow, track, frozen fingerprint, document governance binding), so the
    // many changes of one project that run on the same frozen plan resolve it once. A run without a frozen fingerprint
    // resolves from the live definition and is not shared.
    planFor: (state, workflowName, track) => {
      const meta = state.runMetadata
      const key = [workflowName, track, meta?.workflowPlanFingerprint ?? '', meta?.documentProfile ?? '', meta?.documentGovernanceFingerprint ?? ''].join('\u0000')
      const known = plans.get(key)
      if (known !== undefined) return known
      const plan = resolveSnapshotEffectivePlan(readRoot, workflowName, {
        documentProfile: meta?.documentProfile,
        documentGovernanceFingerprint: meta?.documentGovernanceFingerprint,
        workflowPlanFingerprint: meta?.workflowPlanFingerprint,
        workflowPlanSnapshot: meta?.workflowPlanSnapshot,
      }, undefined, trackDefinition(track, workflowName))
      if (meta?.workflowPlanFingerprint !== undefined) plans.set(key, plan)
      return plan
    },
    listRulesFor: (plan) => {
      let rules = listRules.get(plan)
      if (rules === undefined) {
        rules = snapshotWorkflowRulesStructure(plan)
        listRules.set(plan, rules)
      }
      return rules
    },
    legacyRulesFor: (plan) => {
      let rules = legacyRules.get(plan)
      if (rules === undefined) {
        rules = legacySnapshotWorkflowRules(plan)
        legacyRules.set(plan, rules)
      }
      return rules
    },
  }
}

/** What scanning one change directory produced; a directory can yield a row and errors at once. */
export interface ChangeScanOutcome<C> {
  /** Absent when the directory is not a pipeline change, or its state cannot be decoded. */
  readonly change?: C
  /** Project-level errors this change contributed (unreadable state, projection drift). */
  readonly errors: readonly string[]
  /** This runtime refuses to decode the change's canonical state. */
  readonly unsupported?: { readonly foundVersion: number; readonly supportedVersion: number }
  /** The change's artifact scope is an unmerged legacy scope. */
  readonly legacyScope?: { readonly legacyScopePath: string }
  /** The frozen rules in the pre-v1.0.1 shape, for the project-level compatibility table (full tier only). */
  readonly legacyRules?: { readonly workflow: string; readonly rules: LegacyWorkflowRulesSnapshot }
}

const SKIPPED: ChangeScanOutcome<never> = { errors: [] }

async function hasTasksFile(changeDir: string): Promise<boolean> {
  try {
    const entry = await lstat(join(changeDir, 'tasks.md'))
    return entry.isFile()
  } catch {
    return false
  }
}

export function scanChange(ctx: ProjectScanContext, name: string, tier: 'full'): Promise<ChangeScanOutcome<ChangeSnapshot>>
export function scanChange(ctx: ProjectScanContext, name: string, tier: 'list'): Promise<ChangeScanOutcome<ChangeListSnapshot>>
export async function scanChange(
  ctx: ProjectScanContext,
  name: string,
  tier: SnapshotTier,
): Promise<ChangeScanOutcome<ChangeSnapshot | ChangeListSnapshot>> {
  const { deps, readRoot, anchor, nowMs } = ctx
  assertWorkflowRootAnchor(anchor)
  const changeDir = ctx.changeDir(name)
  let source: string | undefined
  try {
    source = stateStorageSourcePathSync(changeDir)
  } catch (error) {
    return { errors: [`${name}: 状态来源检查失败（${error instanceof Error ? error.message : String(error)}）`] }
  }
  // 普通目录不是 pipeline change，仍允许跳过；一旦 canonical/legacy 状态入口存在，其损坏就
  // 必须进入项目错误面，不能伪装成“这里没有 change”。
  if (source === undefined) return SKIPPED
  const errors: string[] = []
  try {
    const projection = await deps.store.inspectProjection(changeDir)
    if (projection.status === 'missing' || projection.status === 'stale'
      || projection.status === 'legacy-compatible') {
      // 只自动前滚能由 revision metadata 证明的 adapter 状态；unknown drift 永不静默覆盖。
      await deps.store.repairProjection(changeDir)
    } else if (projection.status === 'drift') {
      errors.push(`${name}: YAML projection drift（${projection.reason}）`)
    }
    const state = await deps.store.read(changeDir)
    const f = state.fields
    const phase = str(f.phase)
    const workflowName = str(f.workflow) || 'default'
    const track = str(f.track)
    // 测试状态按负责人的记录判定（真机验收 F15），没有负责人才退回查看者。
    const evidenceUser = evidenceUserFor(f, ctx.actingUser)
    const plan = ctx.planFor(state, workflowName, track)
    const [terminalActivity, artifactScope, agentRuns] = await Promise.all([
      readTerminalActivity(changeDir, name, nowMs),
      projectArtifactScopeIssue(deps, changeDir, anchor),
      projectAgentRuns({
        changeDir,
        plan,
        state,
        phase,
        ...(ctx.candidate === undefined ? {} : { candidate: ctx.candidate }),
        touchedClasses: async () => touchedPathClasses(await ctx.changedFiles.pathChanges(changeStartOfFields(state.fields), [])),
      }),
    ])
    const legacyScope = artifactScope.compatibilityIssue === undefined
      ? undefined
      : { legacyScopePath: artifactScope.compatibilityIssue.legacyScopePath }
    const workflowExecution = await snapshotWorkflowExecution(plan, state, readRoot, changeDir, name, {
      ...ctx.capabilityDeps,
      // readiness 的 agent 面与工作台读同一份投影：这里只把已算好的阻断交出去。
      stepAgents: async () => agentBlockersOf(agentRuns, plan, phase),
      ...(ctx.stepExitsFor === undefined ? {} : { stepExits: ctx.stepExitsFor(name, evidenceUser) }),
    })
    const common = {
      name,
      path: join(ctx.displayChangesRoot, name),
      phase,
      phase_status: str(f.phase_status),
      track,
      preset: str(f.preset),
      archived: str(f.archived),
      updated_at: str(f.updated_at),
      fields: f,
      owner: ownerOf(f),
      creator: creatorOf(f),
      workflowPlanFingerprint: plan.workflowFingerprint,
      workflowExecution,
      reviewHandshake: projectReviewHandshake(state, plan, phase),
      ...(terminalActivity === undefined ? {} : { terminalActivity }),
    }
    if (tier === 'list') {
      // The stage statuses depend only on the phase; the task texts are detail-tier data, so the file is not read.
      const todo = projectPipelineTodo({
        phase,
        tasksMarkdown: await hasTasksFile(changeDir) ? '' : undefined,
        stages: snapshotTodoStages(plan, phase),
      })
      const change: ChangeListSnapshot = { ...common, workflowRules: ctx.listRulesFor(plan), todo }
      return { change, errors, ...(legacyScope === undefined ? {} : { legacyScope }) }
    }
    const [documents, authority, skillRuns, testEvidence, tasksProjection] = await Promise.all([
      documentEvidence(readRoot, changeDir, plan, phase),
      readWorkflowSnapshotAuthority(changeDir, state, plan),
      projectSkillRuns(changeDir, plan, phase, ctx.trackDefinition(track, workflowName), deps.mandatorySkills),
      projectTestEvidence({
        root: readRoot,
        changeDir,
        changeName: name,
        plan,
        user: evidenceUser,
        ...(ctx.candidate === undefined ? {} : { candidate: ctx.candidate }),
        changedFiles: () => ctx.changedFiles.changedFiles(changeStartOfFields(state.fields)),
        protectedChanges: () => protectedChangesInSession(readRoot, ctx.changedFiles, changeStartOfFields(state.fields)),
        integrityDiff: integrityDiffInSession(ctx.changedFiles, changeStartOfFields(state.fields)),
        recordChainCache: recordChains,
      }),
      readTasksProjection(changeDir, {}, anchor),
    ])
    const todo = projectPipelineTodo({
      phase,
      tasksMarkdown: tasksProjection?.source,
      trustedCanonicalProjection: tasksProjection?.trustedCanonicalProjection,
      stages: snapshotTodoStages(plan, phase),
      additionalItemsByStage: documentTodoItems(plan, documents),
    })
    const change: ChangeSnapshot = {
      ...common,
      workflowRules: snapshotWorkflowRulesAtRoot(plan, readRoot, workflowName, authority),
      todo,
      documents,
      skillRuns,
      ...(agentRuns.length === 0 ? {} : { agentRuns }),
      ...(testEvidence.tests === undefined ? {} : { tests: testEvidence.tests }),
      ...(testEvidence.testPolicy === undefined ? {} : { testPolicy: testEvidence.testPolicy }),
      ...(testEvidence.testPlan === undefined ? {} : { testPlan: testEvidence.testPlan, testUser: testEvidence.testUser }),
      ...(testEvidence.diagnostics === undefined ? {} : { testDiagnostics: testEvidence.diagnostics }),
    }
    return {
      change,
      errors,
      legacyRules: { workflow: workflowName, rules: ctx.legacyRulesFor(plan) },
      ...(legacyScope === undefined ? {} : { legacyScope }),
    }
  } catch (error) {
    if (error instanceof UnsupportedRunStateVersionError) {
      return { errors, unsupported: { foundVersion: error.foundVersion, supportedVersion: error.supportedVersion } }
    }
    return {
      errors: [...errors, `${name}: 状态损坏或不可读 [${source}]（${error instanceof Error ? error.message : String(error)}）`],
    }
  }
}
