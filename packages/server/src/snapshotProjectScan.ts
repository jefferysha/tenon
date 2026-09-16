import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { creatorOf, isTenonUser, ownerOf, readTaskArchiveOf, stateStorageSourcePathSync, projectPipelineTodo, type EffectiveWorkflowPlan, type SkillTable, type StateStore, type TaskArchive, type TrackDefinition, UnsupportedRunStateVersionError } from '@tenon/kernel'
import type { ArchivedChangeSnapshot, ProjectSnapshot, ChangeSnapshot } from './types.js'
import { readRepositoryIdentity } from './repositoryIdentity.js'
import { resolveSnapshotTrack, projectSkillRuns } from './skillRuns.js'
import { readWorkflowSnapshotAuthority } from './workflowSnapshotAuthority.js'
import { legacySnapshotWorkflowRules, resolveSnapshotEffectivePlan, snapshotTodoStages, snapshotWorkflowExecution, snapshotWorkflowRulesAtRoot, type WorkflowSnapshotCapabilityDeps } from './workflowSnapshot.js'
import { projectReviewHandshake } from './reviewHandshake.js'
import { documentEvidence, documentTodoItems, type SnapshotDeps } from './snapshot.js'
import { projectArtifactScopeIssue, readTerminalActivity } from './snapshot.js'
import { assertWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'
import { readTasksProjection } from './snapshotTasks.js'
import { createCandidateCache } from './testCandidateCache.js'
import { projectTestEvidence } from './testEvidenceSnapshot.js'
import { defaultResolveUser } from './serverUserRoutes.js'
const MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES = 100
function str(v: string | string[] | undefined): string { return Array.isArray(v) ? v.join(',') : v ?? '' }

/** Read the viewer's archive once per project; no viewer or a malformed store hides nothing. */
async function viewerArchive(deps: SnapshotDeps, readRoot: string, root: string): Promise<TaskArchive | undefined> {
  const viewer = deps.viewer?.(root)
  if (viewer === undefined || !isTenonUser(viewer)) return undefined
  const read = await readTaskArchiveOf(readRoot, viewer.slug)
  return read.kind === 'ok' ? read.archive : undefined
}

/**
 * `readRoot` may be the anchor's `/proc/self/fd/<n>` handle, which only this process can resolve; a spawned
 * git would fail on it. The count therefore probes the anchor's real path, the one a child process can use.
 */
async function uncommittedDeletions(deps: SnapshotDeps, anchor: WorkflowRootAnchor): Promise<number | undefined> {
  const count = await deps.countDeletions?.(anchor.realPath)
  return count === undefined || count === null ? undefined : count
}

export async function scanAnchoredProject(
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
    const deletions = await uncommittedDeletions(deps, anchor)
    return {
      root, ok: true, changes: [], workflowRules: {},
      ...(deletions === undefined ? {} : { uncommittedDeletions: deletions }),
      ...(repository === undefined ? {} : { repository }),
    }
  }
  assertWorkflowRootAnchor(anchor)

  const archive = await viewerArchive(deps, readRoot, root)
  const changes: ChangeSnapshot[] = []
  const archived: ArchivedChangeSnapshot[] = []
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
  // 候选版本对整个 root 只算一次（TTL 内复用）：测试新鲜度判定需要它，但指纹遍历整棵树。
  const resolved = (deps.resolveUser ?? defaultResolveUser)(root)
  const actingUser = isTenonUser(resolved) ? resolved : undefined
  // 能力缺席时不传 candidate（判定跳过候选比对），而不是传一个恒 undefined 的读取器。
  const candidate = workspaceFingerprint === undefined
    ? undefined
    : createCandidateCache((target) => workspaceFingerprint(target, ''))
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
      const [documents, terminalActivity, authority, skillRuns, artifactScope, testEvidence] = await Promise.all([
        documentEvidence(readRoot, changeDir, plan, phase),
        readTerminalActivity(changeDir, e.name, nowMs),
        readWorkflowSnapshotAuthority(changeDir, state, plan),
        projectSkillRuns(changeDir, plan, phase, trackDefinition(track, workflowName), deps.mandatorySkills),
        projectArtifactScopeIssue(deps, changeDir, anchor),
        projectTestEvidence({
          root: readRoot,
          changeDir,
          changeName: e.name,
          plan,
          user: actingUser,
          ...(candidate === undefined ? {} : { candidate: () => candidate(readRoot) }),
        }),
      ])
      if (artifactScope.compatibilityIssue !== undefined) {
        if (compatibilityIssues.length < MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES) {
          compatibilityIssues.push({ severity: 'warning', kind: 'legacy-scope-unmerged', change: e.name, legacyScopePath: artifactScope.compatibilityIssue.legacyScopePath, action: 'merge-or-remove-legacy-scope' })
        } else compatibilityIssueOverflow += 1
      }
      const tasksProjection = await readTasksProjection(changeDir, {}, anchor)
      const todo = projectPipelineTodo({
        phase,
        tasksMarkdown: tasksProjection?.source,
        trustedCanonicalProjection: tasksProjection?.trustedCanonicalProjection,
        stages: snapshotTodoStages(plan, phase),
        additionalItemsByStage: documentTodoItems(plan, documents),
      })
      const snapshot: ChangeSnapshot = {
        name: e.name,
        path: join(displayChangesRoot, e.name),
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
        ...(testEvidence.tests === undefined ? {} : { tests: testEvidence.tests }),
        ...(testEvidence.diagnostics === undefined ? {} : { testDiagnostics: testEvidence.diagnostics }),
        ...(terminalActivity === undefined ? {} : { terminalActivity }),
      }
      const entry = archive?.changes[e.name]
      if (entry === undefined) changes.push(snapshot)
      else archived.push({ ...snapshot, archive: { archivedAt: entry.archivedAt, phase: entry.phase, actor: entry.actor } })
    } catch (error) {
      if (error instanceof UnsupportedRunStateVersionError) {
        if (compatibilityIssues.length < MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES) {
          compatibilityIssues.push({
            severity: 'blocking',
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
  archived.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const deletions = await uncommittedDeletions(deps, anchor)
  compatibilityIssues.sort((a, b) => (
    a.change < b.change ? -1 : a.change > b.change ? 1 : 0
  ))
  return {
    root,
    ok: errors.length === 0 && compatibilityIssues.every((issue) => issue.severity === 'warning'),
    changes,
    ...(archived.length === 0 ? {} : { archived }),
    ...(deletions === undefined ? {} : { uncommittedDeletions: deletions }),
    ...(repository === undefined ? {} : { repository }),
    ...(compatibilityIssues.length === 0 ? {} : { compatibilityIssues }),
    ...(compatibilityIssueOverflow === 0 ? {} : { compatibilityIssuesTruncated: true as const }),
    workflowRules: legacyWorkflowRules,
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
  }
}
