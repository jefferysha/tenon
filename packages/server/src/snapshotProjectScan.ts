import { readdir } from 'node:fs/promises'
import type { ChangeSnapshot, LegacyWorkflowRulesSnapshot, ProjectSnapshot } from './types.js'
import type { ChangeListSnapshot, ProjectListSnapshot } from './snapshotListTypes.js'
import { readRepositoryIdentity } from './repositoryIdentity.js'
import type { SnapshotDeps } from './snapshot.js'
import { createProjectScanContext, scanChange, type ChangeScanOutcome, type ProjectScanContext, type ScanArea } from './snapshotChangeScan.js'
import { mapWithConcurrency } from './concurrentMap.js'
import { createEndedTaskCache, listEndedTasks, type EndedTaskCache, type EndedTaskList } from './endedTasks.js'
import { anchorChildProcessPath, assertWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'

const MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES = 100
/** Changes of one project scanned at once; their reads overlap, the shared git session and plan memo do not care. */
const CHANGE_SCAN_CONCURRENCY = 4

/**
 * An ended task's directory never changes, so what one scan read of a project is what the next one reuses. One
 * cache per registered root and process; the oldest root's cache goes first once more roots than this were seen.
 */
const MAX_ENDED_CACHES = 256
const endedCaches = new Map<string, EndedTaskCache>()

function endedCacheFor(root: string): EndedTaskCache {
  const known = endedCaches.get(root)
  if (known !== undefined) return known
  const created = createEndedTaskCache()
  endedCaches.set(root, created)
  if (endedCaches.size > MAX_ENDED_CACHES) {
    const oldest = endedCaches.keys().next().value
    if (oldest !== undefined) endedCaches.delete(oldest)
  }
  return created
}

/**
 * `readRoot` may be the anchor's `/proc/self/fd/<n>` handle, which only this process can resolve; a spawned
 * git would fail on it. The count therefore probes the anchor's real path, the one a child process can use.
 */
async function uncommittedDeletions(deps: SnapshotDeps, anchor: WorkflowRootAnchor): Promise<number | undefined> {
  const count = await deps.countDeletions?.(anchorChildProcessPath(anchor))
  return count === undefined || count === null ? undefined : count
}

interface ScannedChanges<C> {
  readonly changes: C[]
  readonly compatibilityIssues: NonNullable<ProjectSnapshot['compatibilityIssues']>
  readonly overflow: number
  readonly legacyWorkflowRules: Record<string, LegacyWorkflowRulesSnapshot>
  readonly errors: string[]
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Scan every change directory (changes of one project overlap) and fold the outcomes in name order. */
async function scanChanges<C extends { readonly name: string }>(
  ctx: ProjectScanContext,
  names: readonly string[],
  scan: (name: string) => Promise<ChangeScanOutcome<C>>,
): Promise<ScannedChanges<C>> {
  const sorted = [...names].sort(byName)
  const outcomes = await mapWithConcurrency(sorted, CHANGE_SCAN_CONCURRENCY, (name) => scan(name))
  const out: ScannedChanges<C> = { changes: [], compatibilityIssues: [], overflow: 0, legacyWorkflowRules: {}, errors: [] }
  let overflow = 0
  for (const [index, name] of sorted.entries()) {
    const outcome = outcomes[index]
    if (outcome === undefined) continue
    out.errors.push(...outcome.errors)
    if (outcome.legacyRules !== undefined) out.legacyWorkflowRules[outcome.legacyRules.workflow] ??= outcome.legacyRules.rules
    if (outcome.legacyScope !== undefined) {
      if (out.compatibilityIssues.length < MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES) {
        out.compatibilityIssues.push({ severity: 'warning', kind: 'legacy-scope-unmerged', change: name, legacyScopePath: outcome.legacyScope.legacyScopePath, action: 'merge-or-remove-legacy-scope' })
      } else overflow += 1
    }
    if (outcome.unsupported !== undefined) {
      if (out.compatibilityIssues.length < MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES) {
        out.compatibilityIssues.push({
          severity: 'blocking',
          kind: 'unsupported-canonical-version',
          change: name,
          foundVersion: outcome.unsupported.foundVersion,
          supportedVersion: outcome.unsupported.supportedVersion,
          action: 'upgrade-runtime',
        })
      } else overflow += 1
    }
    if (outcome.change !== undefined) out.changes.push(outcome.change)
  }
  out.compatibilityIssues.sort((a, b) => byName(a.change, b.change))
  return { ...out, overflow }
}

/** The fields both tiers share once the changes are scanned. */
function projectEnvelope<C>(
  root: string,
  scanned: ScannedChanges<C>,
  deletions: number | undefined,
  repository: ProjectSnapshot['repository'],
  ended: EndedTaskList,
) {
  return {
    root,
    ok: scanned.errors.length === 0 && scanned.compatibilityIssues.every((issue) => issue.severity === 'warning'),
    ...(deletions === undefined ? {} : { uncommittedDeletions: deletions }),
    ...(repository === undefined ? {} : { repository }),
    ...(ended.tasks.length === 0 ? {} : { ended: ended.tasks }),
    ...(ended.total > ended.tasks.length ? { endedTotal: ended.total } : {}),
    ...(scanned.compatibilityIssues.length === 0 ? {} : { compatibilityIssues: scanned.compatibilityIssues }),
    ...(scanned.overflow === 0 ? {} : { compatibilityIssuesTruncated: true as const }),
    ...(scanned.errors.length === 0 ? {} : { error: scanned.errors.join('; ') }),
  }
}

export function scanAnchoredProject(
  deps: SnapshotDeps, root: string, readRoot: string, anchor: WorkflowRootAnchor, nowMs: number, tier: 'full',
): Promise<ProjectSnapshot>
export function scanAnchoredProject(
  deps: SnapshotDeps, root: string, readRoot: string, anchor: WorkflowRootAnchor, nowMs: number, tier: 'list',
): Promise<ProjectListSnapshot>
export async function scanAnchoredProject(
  deps: SnapshotDeps,
  root: string,
  readRoot: string,
  anchor: WorkflowRootAnchor,
  nowMs: number,
  tier: 'full' | 'list',
): Promise<ProjectSnapshot | ProjectListSnapshot> {
  // git runs in a child process, so every probe below takes the anchor's real path, never readRoot.
  const repository = await readRepositoryIdentity(anchorChildProcessPath(anchor), deps.repositoryIdentity)
  assertWorkflowRootAnchor(anchor)

  const ctx = createProjectScanContext(deps, root, readRoot, anchor, nowMs)
  let entries
  try {
    entries = deps.readChangesDirectory === undefined
      ? await readdir(ctx.changesRoot, { withFileTypes: true })
      : await deps.readChangesDirectory(ctx.changesRoot)
  } catch (error) {
    assertWorkflowRootAnchor(anchor)
    if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') throw error
    // 已注册但尚无 openspec/changes —— 合法空项目
    const deletions = await uncommittedDeletions(deps, anchor)
    const empty = {
      root, ok: true, changes: [],
      ...(deletions === undefined ? {} : { uncommittedDeletions: deletions }),
      ...(repository === undefined ? {} : { repository }),
    }
    return tier === 'full' ? { ...empty, workflowRules: {} } : empty
  }
  assertWorkflowRootAnchor(anchor)

  const names = entries.filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name)
  // The ended tasks are read beside the active ones; they never fail the project (see listEndedTasks).
  const endedTasks = listEndedTasks(readRoot, endedCacheFor(root))
  if (tier === 'list') {
    const scanned = await scanChanges<ChangeListSnapshot>(ctx, names, (name) => scanChange(ctx, name, 'list'))
    const deletions = await uncommittedDeletions(deps, anchor)
    return {
      ...projectEnvelope(root, scanned, deletions, repository, await endedTasks),
      changes: scanned.changes,
    }
  }
  const scanned = await scanChanges<ChangeSnapshot>(ctx, names, (name) => scanChange(ctx, name, 'full'))
  const deletions = await uncommittedDeletions(deps, anchor)
  return {
    ...projectEnvelope(root, scanned, deletions, repository, await endedTasks),
    changes: scanned.changes,
    workflowRules: scanned.legacyWorkflowRules,
  }
}

export interface ScannedChange {
  readonly change: ChangeSnapshot
}

/**
 * One change with all its evidence, for the task detail read; `undefined` when the directory holds no readable change.
 * `area: 'archive'` reads an ended task out of `openspec/changes/archive/<name>`, read-only.
 */
export async function scanAnchoredChange(
  deps: SnapshotDeps,
  root: string,
  readRoot: string,
  anchor: WorkflowRootAnchor,
  nowMs: number,
  name: string,
  area: ScanArea = 'active',
): Promise<ScannedChange | undefined> {
  const ctx = createProjectScanContext(deps, root, readRoot, anchor, nowMs, area)
  const outcome = await scanChange(ctx, name, 'full')
  if (outcome.change === undefined) return undefined
  assertWorkflowRootAnchor(anchor)
  return { change: outcome.change }
}
