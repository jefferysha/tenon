import { readdir } from 'node:fs/promises'
import { isTenonUser, readTaskArchiveOf, type TaskArchive } from '@tenon/kernel'
import type {
  ArchivedChangeSnapshot, ChangeListSnapshot, ChangeSnapshot, LegacyWorkflowRulesSnapshot, ProjectListSnapshot, ProjectSnapshot,
} from './types.js'
import { readRepositoryIdentity } from './repositoryIdentity.js'
import type { SnapshotDeps } from './snapshot.js'
import { createProjectScanContext, scanChange, type ChangeScanOutcome, type ProjectScanContext } from './snapshotChangeScan.js'
import { mapWithConcurrency } from './concurrentMap.js'
import { anchorChildProcessPath, assertWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'

const MAX_CANONICAL_STATE_COMPATIBILITY_ISSUES = 100
/** Changes of one project scanned at once; their reads overlap, the shared git session and plan memo do not care. */
const CHANGE_SCAN_CONCURRENCY = 4

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
  const count = await deps.countDeletions?.(anchorChildProcessPath(anchor))
  return count === undefined || count === null ? undefined : count
}

type Archived<C> = C & { archive: ArchivedChangeSnapshot['archive'] }

interface ScannedChanges<C> {
  readonly changes: C[]
  readonly archived: Archived<C>[]
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
  archive: TaskArchive | undefined,
  scan: (name: string) => Promise<ChangeScanOutcome<C>>,
): Promise<ScannedChanges<C>> {
  const sorted = [...names].sort(byName)
  const outcomes = await mapWithConcurrency(sorted, CHANGE_SCAN_CONCURRENCY, (name) => scan(name))
  const out: ScannedChanges<C> = { changes: [], archived: [], compatibilityIssues: [], overflow: 0, legacyWorkflowRules: {}, errors: [] }
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
    if (outcome.change === undefined) continue
    const entry = archive?.changes[name]
    if (entry === undefined) out.changes.push(outcome.change)
    else out.archived.push({ ...outcome.change, archive: { archivedAt: entry.archivedAt, phase: entry.phase, actor: entry.actor } })
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
) {
  return {
    root,
    ok: scanned.errors.length === 0 && scanned.compatibilityIssues.every((issue) => issue.severity === 'warning'),
    ...(deletions === undefined ? {} : { uncommittedDeletions: deletions }),
    ...(repository === undefined ? {} : { repository }),
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

  const archive = await viewerArchive(deps, readRoot, root)
  const names = entries.filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name)
  if (tier === 'list') {
    const scanned = await scanChanges<ChangeListSnapshot>(ctx, names, archive, (name) => scanChange(ctx, name, 'list'))
    const deletions = await uncommittedDeletions(deps, anchor)
    return {
      ...projectEnvelope(root, scanned, deletions, repository),
      changes: scanned.changes,
      ...(scanned.archived.length === 0 ? {} : { archived: scanned.archived }),
    }
  }
  const scanned = await scanChanges<ChangeSnapshot>(ctx, names, archive, (name) => scanChange(ctx, name, 'full'))
  const deletions = await uncommittedDeletions(deps, anchor)
  return {
    ...projectEnvelope(root, scanned, deletions, repository),
    changes: scanned.changes,
    ...(scanned.archived.length === 0 ? {} : { archived: scanned.archived }),
    workflowRules: scanned.legacyWorkflowRules,
  }
}

export interface ScannedChange {
  readonly change: ChangeSnapshot
  /** Present when the viewer has archived this change. */
  readonly archive?: ArchivedChangeSnapshot['archive']
}

/** One change with all its evidence, for the task detail read; `undefined` when the directory holds no readable change. */
export async function scanAnchoredChange(
  deps: SnapshotDeps,
  root: string,
  readRoot: string,
  anchor: WorkflowRootAnchor,
  nowMs: number,
  name: string,
): Promise<ScannedChange | undefined> {
  const ctx = createProjectScanContext(deps, root, readRoot, anchor, nowMs)
  const outcome = await scanChange(ctx, name, 'full')
  if (outcome.change === undefined) return undefined
  const archive = (await viewerArchive(deps, readRoot, root))?.changes[name]
  assertWorkflowRootAnchor(anchor)
  return archive === undefined
    ? { change: outcome.change }
    : { change: outcome.change, archive: { archivedAt: archive.archivedAt, phase: archive.phase, actor: archive.actor } }
}
