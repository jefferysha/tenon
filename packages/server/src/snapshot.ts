/**
 * snapshot 域 —— 聚合本机所有注册 Project 的 canonical state → JSON（GET /api/snapshot）。
 * server 是 kernel 消费方：用 StateStore.read（→ parsePipeline）读盘，绝不自造解析器。
 * 对位老仓 dashboard-generator.build_data 的「聚合所有 Project 的活跃 change」核心面。
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  evaluateDocumentEvidence,
  isDocumentPolicyStep,
  liveTerminalActivity,
  loadWorkflow,
  parseTerminalActivityRecord,
  projectPipelineTodo,
  stateStorageSourcePathSync,
  UnsupportedRunStateVersionError,
  TERMINAL_ACTIVITY_FILE,
  type EffectiveWorkflowPlan,
  type SkillTable,
  type StateStore,
  type TrackDefinition,
} from '@tenon/kernel'
import type {
  ChangeSnapshot,
  DocumentEvidenceSnapshot,
  ProjectSnapshot, ProjectRepositoryIdentity,
  Snapshot,
  TerminalActivitySnapshot,
} from './types.js'
import { projectReviewHandshake } from './reviewHandshake.js'
import { projectSkillRuns, resolveSnapshotTrack } from './skillRuns.js'
import { readWorkflowSnapshotAuthority } from './workflowSnapshotAuthority.js'
import {
  legacySnapshotWorkflowRules,
  resolveSnapshotEffectivePlan,
  snapshotTodoStages,
  snapshotWorkflowExecution,
  snapshotWorkflowRulesAtRoot,
  type WorkflowSnapshotCapabilityDeps,
} from './workflowSnapshot.js'
import { readBounded } from './contextBundleTrustedReader.js'
import { dedupeRoots } from './projectRoots.js'
import { readTasksProjection } from './snapshotTasks.js'
import { mapWithConcurrency } from './concurrentMap.js'
import { normalizeRepositoryLabels, readRepositoryIdentity } from './repositoryIdentity.js'
import { computeSnapshotFingerprint } from './snapshotFingerprint.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  type WorkflowRootAnchor,
} from './workflowRootAnchor.js'
import type { ArtifactService } from './serverArtifactRoutes.js'
export { dedupeRoots } from './projectRoots.js'
export { readTasksMarkdown } from './snapshotTasks.js'
const MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES = 100
export interface SnapshotDeps extends WorkflowSnapshotCapabilityDeps {
  registry: () => string[]
  store: StateStore
  version: string
  clock: () => string
  /**
   * 额外能力声明（GOAL B6）：与基线能力合并后写入 snapshot.capabilities。
   * 由 server 按真实接线情况注入（afk 数据端始终 true；traffic 仅注入 traceStore 时 true）。
   */
  capabilities?: Record<string, boolean>
  /** Epoch source for the short-lived terminal activity lease; injectable so expiry is testable. */
  now?: () => number
  repositoryIdentity?: (root: string) => Promise<ProjectRepositoryIdentity | undefined>
  readChangesDirectory?: (changesRoot: string) => Promise<Dirent[]>
  /**
   * Resolve the server's long-lived inode anchor for a registered root. When present, an absent
   * anchor is an authorization failure and must never be replaced with a new point-in-time trust.
   */
  rootAnchor?: (root: string) => WorkflowRootAnchor | undefined
  /** Machine-level manifest mandatory table; only used for frozen plans without an embedded track matrix. */
  mandatorySkills?: SkillTable
  /** Resolve the durable artifact service for one change directory. */
  artifactServiceForRoot?: (root: string, anchor: WorkflowRootAnchor) => ArtifactService | undefined | Promise<ArtifactService | undefined>
}

export function snapshotDepsFactory(
  base: Omit<SnapshotDeps, 'now'>,
): (nowMs?: number) => SnapshotDeps {
  return (nowMs) => ({ ...base, ...(nowMs === undefined ? {} : { now: () => nowMs }) })
}
function str(v: string | string[] | undefined): string { return Array.isArray(v) ? v.join(',') : v ?? '' }

async function projectArtifactAttempts(
  deps: SnapshotDeps,
  changeDir: string,
  anchor: WorkflowRootAnchor,
): Promise<ReadonlyArray<{ stageId: string; stageAttemptId: string }>> {
  if (deps.artifactServiceForRoot === undefined) return []
  const service = await deps.artifactServiceForRoot(changeDir, anchor)
  if (service === undefined || service.attempts === undefined) return []
  const attempts = await service.attempts()
  const latest = new Map<string, { stageId: string; stageAttemptId: string; startedAt: string }>()
  for (const attempt of attempts) {
    const prior = latest.get(attempt.stageId)
    if (prior === undefined || prior.startedAt.localeCompare(attempt.startedAt) < 0) latest.set(attempt.stageId, attempt)
  }
  return [...latest.values()]
    .sort((left, right) => left.stageId.localeCompare(right.stageId))
    .map(({ stageId, stageAttemptId }) => ({ stageId, stageAttemptId }))
}

/**
 * Read a strictly local, hook-written liveness sidecar.  This is intentionally fail-closed for
 * display: a symlink, oversized file, malformed payload, stale heartbeat, or mismatched Change
 * simply means no terminal is currently claimed to be running.
 */
export async function readTerminalActivity(
  changeDir: string,
  changeName: string,
  nowMs: number,
): Promise<TerminalActivitySnapshot | undefined> {
  const target = join(changeDir, TERMINAL_ACTIVITY_FILE)
  let fd: number | undefined
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > 4096) return undefined
    const assertStable = (): boolean => {
      const current = lstatSync(target)
      return current.isFile()
        && !current.isSymbolicLink()
        && current.dev === opened.dev
        && current.ino === opened.ino
        && current.size === opened.size
    }
    if (!assertStable()) return undefined
    const bytes = readBounded(fd, 4096)
    if (bytes.byteLength > 4096 || !assertStable()) return undefined
    const parsed = parseTerminalActivityRecord(JSON.parse(bytes.toString('utf8')))
    if (parsed === null || parsed.change !== changeName) return undefined
    const live = liveTerminalActivity(parsed, nowMs)
    if (live === null) return undefined
    return {
      sessionId: live.sessionId,
      heartbeatAt: live.heartbeatAt,
      expiresAt: live.expiresAt,
      ...(live.turnId === undefined ? {} : { turnId: live.turnId }),
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export async function documentEvidence(
  root: string,
  changeDir: string,
  plan: EffectiveWorkflowPlan | undefined,
  phase: string,
): Promise<DocumentEvidenceSnapshot> {
  const policy = plan?.capabilities.documents.policy
  if (!policy) return { governed: false, blockers: [], items: [] }
  if (!isDocumentPolicyStep(policy, phase)) {
    return {
      governed: true,
      phase,
      ledgerPresent: false,
      pass: false,
      blockers: [`受 document contract 治理的 workflow 当前 step 非法（当前 '${phase || '空'}'）`],
      items: [],
    }
  }
  const report = await evaluateDocumentEvidence(root, changeDir, phase, {}, policy)
  return {
    governed: true,
    phase,
    ledgerPresent: report.hasLedger,
    pass: report.pass,
    blockers: [...report.blockers],
    items: report.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      requiredRead: item.requiredRead,
      paths: [...item.paths],
      producers: [...item.producers],
      timeline: item.timeline.map((entry) => ({ ...entry })),
    })),
  }
}

export function documentTodoItems(
  plan: EffectiveWorkflowPlan | undefined,
  evidence: DocumentEvidenceSnapshot,
): Readonly<Record<string, readonly { text: string; completed: boolean }[]>> {
  const policy = plan?.capabilities.documents.policy
  if (!policy) return {}
  const status = new Map(evidence.items.map((item) => [item.kind, item.status]))
  return Object.fromEntries(policy.steps.map((step) => [
    step,
    (policy.outputsByStep[step] ?? []).map((requirement) => ({
      text: `[document] ${requirement.kind}`,
      completed: status.get(requirement.kind) === 'recorded',
    })),
  ]))
}

async function scanAnchoredProject(
  deps: SnapshotDeps,
  root: string,
  readRoot: string,
  anchor: WorkflowRootAnchor,
  nowMs: number,
): Promise<ProjectSnapshot> {
  const { store } = deps
  const repository = await readRepositoryIdentity(readRoot, deps.repositoryIdentity)
  assertWorkflowRootAnchor(anchor)

  const changesRoot = join(readRoot, 'openspec', 'changes')
  const displayChangesRoot = join(root, 'openspec', 'changes')
  let entries
  try {
    entries = deps.readChangesDirectory === undefined
      ? await readdir(changesRoot, { withFileTypes: true })
      : await deps.readChangesDirectory(changesRoot)
  } catch (error) {
    assertWorkflowRootAnchor(anchor)
    if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') throw error
    // 已注册但尚无 openspec/changes —— 合法空项目
    return { root, ok: true, changes: [], workflowRules: {}, ...(repository === undefined ? {} : { repository }) }
  }
  assertWorkflowRootAnchor(anchor)

  const changes: ChangeSnapshot[] = []
  const compatibilityIssues: NonNullable<ProjectSnapshot['compatibilityIssues']> = []
  const legacyWorkflowRules: ProjectSnapshot['workflowRules'] = {}
  const errors: string[] = []
  let gitHeadPromise: Promise<string> | undefined
  const workspaceFingerprints = new Map<string, Promise<string>>()
  const trackDefinitions = new Map<string, TrackDefinition | undefined>()
  const trackDefinition = (trackId: string, workflowName: string): TrackDefinition | undefined => {
    const key = `${workflowName}\u0000${trackId}`
    if (!trackDefinitions.has(key)) trackDefinitions.set(key, resolveSnapshotTrack(readRoot, trackId, workflowName))
    return trackDefinitions.get(key)
  }
  const gitHeadSha = deps.gitHeadSha
  const workspaceFingerprint = deps.workspaceFingerprint
  const capabilityDeps: WorkflowSnapshotCapabilityDeps = {
    ...(deps.fileExists === undefined ? {} : { fileExists: deps.fileExists }),
    ...(deps.assessBuildRevision === undefined ? {} : { assessBuildRevision: deps.assessBuildRevision }),
    ...(gitHeadSha === undefined
      ? {}
      : {
          gitHeadSha: () => {
            gitHeadPromise ??= gitHeadSha(readRoot)
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
  let compatibilityIssueOverflow = 0
  for (const e of [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (!e.isDirectory() || e.name === 'archive') continue
    assertWorkflowRootAnchor(anchor)
    const changeDir = join(changesRoot, e.name)
    let source: string | undefined
    try {
      source = stateStorageSourcePathSync(changeDir)
    } catch (error) {
      errors.push(`${e.name}: 状态来源检查失败（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    // 普通目录不是 pipeline change，仍允许跳过；一旦 canonical/legacy 状态入口存在，其损坏就
    // 必须进入项目错误面，不能伪装成“这里没有 change”。
    if (source === undefined) continue
    try {
      const projection = await store.inspectProjection(changeDir)
      if (projection.status === 'missing' || projection.status === 'stale'
        || projection.status === 'legacy-compatible') {
        // 只自动前滚能由 revision metadata 证明的 adapter 状态；unknown drift 永不静默覆盖。
        await store.repairProjection(changeDir)
      } else if (projection.status === 'drift') {
        errors.push(`${e.name}: YAML projection drift（${projection.reason}）`)
      }
      const state = await store.read(changeDir)
      const f = state.fields
      const phase = str(f.phase)
      const workflowName = str(f.workflow) || 'default'
      const track = str(f.track)
      const plan = resolveSnapshotEffectivePlan(readRoot, workflowName, {
        documentProfile: state.runMetadata?.documentProfile,
        documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
        workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
        workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
      }, undefined, trackDefinition(track, workflowName))
      legacyWorkflowRules[workflowName] ??= legacySnapshotWorkflowRules(plan)
      const [documents, terminalActivity, authority, skillRuns, artifactAttempts] = await Promise.all([
        documentEvidence(readRoot, changeDir, plan, phase),
        readTerminalActivity(changeDir, e.name, nowMs),
        readWorkflowSnapshotAuthority(changeDir, state, plan),
        projectSkillRuns(changeDir, plan, phase, trackDefinition(track, workflowName), deps.mandatorySkills),
        projectArtifactAttempts(deps, changeDir, anchor),
      ])
      const tasksProjection = await readTasksProjection(changeDir, {}, anchor)
      const todo = projectPipelineTodo({
        phase,
        tasksMarkdown: tasksProjection?.source,
        trustedCanonicalProjection: tasksProjection?.trustedCanonicalProjection,
        stages: snapshotTodoStages(plan, phase),
        additionalItemsByStage: documentTodoItems(plan, documents),
      })
      changes.push({
        name: e.name,
        path: join(displayChangesRoot, e.name),
        phase,
        phase_status: str(f.phase_status),
        track,
        preset: str(f.preset),
        archived: str(f.archived),
        updated_at: str(f.updated_at),
        fields: f,
        workflowPlanFingerprint: plan.workflowFingerprint,
        workflowRules: snapshotWorkflowRulesAtRoot(plan, readRoot, workflowName, authority),
        workflowExecution: await snapshotWorkflowExecution(
          plan,
          state,
          readRoot,
          changeDir,
          e.name,
          capabilityDeps,
        ),
        reviewHandshake: projectReviewHandshake(state, plan, phase),
        todo,
        documents,
        skillRuns,
        ...(artifactAttempts.length === 0 ? {} : { artifactAttempts }),
        ...(terminalActivity === undefined ? {} : { terminalActivity }),
      })
    } catch (error) {
      if (error instanceof UnsupportedRunStateVersionError) {
        if (compatibilityIssues.length < MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES) {
          compatibilityIssues.push({
            kind: 'unsupported-canonical-version',
            change: e.name,
            foundVersion: error.foundVersion,
            supportedVersion: error.supportedVersion,
            action: 'upgrade-runtime',
          })
        } else {
          compatibilityIssueOverflow += 1
        }
        continue
      }
      errors.push(
        `${e.name}: 状态损坏或不可读 [${source}]（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }
  changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  compatibilityIssues.sort((a, b) => (
    a.change < b.change ? -1 : a.change > b.change ? 1 : 0
  ))
  return {
    root,
    ok: errors.length === 0 && compatibilityIssues.length === 0,
    changes,
    ...(repository === undefined ? {} : { repository }),
    ...(compatibilityIssues.length === 0 ? {} : { compatibilityIssues }),
    ...(compatibilityIssueOverflow === 0 ? {} : { compatibilityIssuesTruncated: true as const }),
    workflowRules: legacyWorkflowRules,
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
  }
}

async function scanProject(deps: SnapshotDeps, root: string, nowMs: number): Promise<ProjectSnapshot> {
  let anchor: WorkflowRootAnchor | undefined
  let ownsAnchor = false
  try {
    if (deps.rootAnchor !== undefined) {
      anchor = deps.rootAnchor(root)
      if (anchor === undefined) throw new Error('registered root 没有可信目录锚')
    } else {
      anchor = captureWorkflowRootAnchor(root)
      ownsAnchor = true
    }
    assertWorkflowRootAnchor(anchor)
    // Linux 用 fd-relative 根彻底固定 lookup；Darwin/Node 没有可遍历 fd path 时使用捕获时的
    // canonical 路径，避免词法路径任一祖先 symlink 换位把后续异步读取改道。
    const project = await scanAnchoredProject(deps, root, anchor.fdPath ?? anchor.realPath, anchor, nowMs)
    assertWorkflowRootAnchor(anchor)
    return project
  } catch {
    return { root, ok: false, changes: [], workflowRules: {}, error: 'root 不存在、不可达或已被替换' }
  } finally {
    if (ownsAnchor && anchor !== undefined) closeWorkflowRootAnchor(anchor)
  }
}

export async function buildSnapshot(deps: SnapshotDeps): Promise<Snapshot> {
  const roots = dedupeRoots(deps.registry())
  const nowMs = deps.now?.() ?? Date.now()
  const projects = normalizeRepositoryLabels(await mapWithConcurrency(roots, 4, (root) => scanProject(deps, root, nowMs)))
  const change_count = projects.reduce((n, p) => n + p.changes.length, 0)
  return {
    snapshot_protocol: 'tenon-snapshot/v2',
    version: deps.version,
    generated_at: deps.clock(),
    // 能力声明（GOAL B6）：基线 4 域恒 true；afk/traffic 等由 server 按真实接线注入合并（未接线不谎报）。
    capabilities: { snapshot: true, health: true, stream: true, transition: true, ...(deps.capabilities ?? {}) },
    project_count: projects.length,
    change_count,
    projects,
  }
}

/**
 * 变更指纹 —— SSE 推送的触发源。每个 change 选择 canonical current（仅其不存在时兼容
 * legacy YAML），取 path:size:mtimeNs（纳秒精度，挡同毫秒内两次写）拼接排序；任一 canonical
 * commit → 指纹变 → 推新快照。损坏 current 仍拥有优先权，不借 YAML 掩盖。
 */
export async function computeFingerprint(
  roots: string[],
  nowMs = Date.now(),
  rootAnchor?: (root: string) => WorkflowRootAnchor | undefined,
  readChangesDirectory?: SnapshotDeps['readChangesDirectory'],
): Promise<string> {
  return computeSnapshotFingerprint(roots, nowMs, rootAnchor, readTerminalActivity, readChangesDirectory)
}
