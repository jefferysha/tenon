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
import { ArtifactScopeMigrationError, type ArtifactService } from '@tenon/automation'
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
  /** Declared identity for a root; the tests projection reads only this user's records. */
  resolveUser?: (root: string) => import('@tenon/kernel').TenonUserResolution
  /** Resolve the durable artifact service for one change directory; only the scope check is projected. */
  artifactServiceForRoot?: (root: string, anchor: WorkflowRootAnchor) => ArtifactService | undefined | Promise<ArtifactService | undefined>
}

export function snapshotDepsFactory(
  base: Omit<SnapshotDeps, 'now'>,
): (nowMs?: number) => SnapshotDeps {
  return (nowMs) => ({ ...base, ...(nowMs === undefined ? {} : { now: () => nowMs }) })
}
function str(v: string | string[] | undefined): string { return Array.isArray(v) ? v.join(',') : v ?? '' }

/**
 * Open the change's artifact scope only to surface an unmerged legacy scope as a compatibility issue.
 * Runtime artifacts themselves have no dashboard surface, so nothing else is projected.
 */
export async function projectArtifactScopeIssue(
  deps: SnapshotDeps,
  changeDir: string,
  anchor: WorkflowRootAnchor,
): Promise<{ compatibilityIssue?: { kind: 'legacy-scope-unmerged'; legacyScopePath: string } }> {
  if (deps.artifactServiceForRoot === undefined) return {}
  try {
    await deps.artifactServiceForRoot(changeDir, anchor)
  } catch (error) {
    if (error instanceof ArtifactScopeMigrationError || (error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'legacy-scope-unmerged')) {
      const legacyScopePath = error instanceof ArtifactScopeMigrationError ? error.legacyPath : typeof (error as { legacyPath?: unknown }).legacyPath === 'string' ? (error as { legacyPath: string }).legacyPath : 'runtime-artifacts'
      return { compatibilityIssue: { kind: 'legacy-scope-unmerged', legacyScopePath } }
    }
    throw error
  }
  return {}
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
      ...(item.reason === undefined ? {} : { reason: item.reason }),
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

import { scanAnchoredProject } from './snapshotProjectScan.js'

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
