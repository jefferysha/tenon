import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  isTenonUser, stateStorageSourcePathSync, TENON_PROJECT_DIR, TERMINAL_ACTIVITY_FILE, userProjectPaths,
  type TenonUserResolution,
} from '@tenon/kernel'
import { mapWithConcurrency } from './concurrentMap.js'
import { dedupeRoots } from './projectRoots.js'
import { repositoryTopologyFingerprint } from './repositoryFingerprint.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

type ActivityReader = (
  changeDir: string,
  changeName: string,
  nowMs: number,
) => Promise<unknown | undefined>

type ChangesDirectoryReader = (changesRoot: string) => Promise<Dirent[]>

/** How many change directories of one project are stat'ed at once; stats are cheap, this only bounds open requests. */
const CHANGE_STAT_CONCURRENCY = 16
/** How many projects are fingerprinted at once. */
const ROOT_CONCURRENCY = 8

/**
 * The viewer's archive store and the repository's commit log: 归档 / 取消归档 change what the Dashboard
 * shows, and the user's own commit changes the 未提交删除 count, so both must push a new snapshot.
 */
async function viewerFingerprintParts(
  readRoot: string,
  viewer: TenonUserResolution | undefined,
): Promise<string[]> {
  // The viewer decides which changes are archived, so a different viewer is a different snapshot even
  // before either archive store exists; the shared snapshot cache keys on this fingerprint.
  const parts: string[] = [`viewer:${readRoot}:${viewer === undefined ? 'none' : isTenonUser(viewer) ? viewer.slug : 'missing'}`]
  const targets = [join(readRoot, '.git', 'logs', 'HEAD')]
  if (viewer !== undefined && isTenonUser(viewer)) targets.push(userProjectPaths(readRoot, viewer.slug).archived)
  for (const target of targets) {
    try {
      const stat = await lstat(target, { bigint: true })
      parts.push(`${target}:${stat.size}:${stat.mtimeNs}`)
    } catch {
      // Absent means the fingerprint simply carries no part for it.
    }
  }
  return parts
}

async function userSlugs(readRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(readRoot, TENON_PROJECT_DIR, 'users'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function statPart(target: string): Promise<string | undefined> {
  try {
    const stat = await lstat(target, { bigint: true })
    return `${target}:${stat.size}:${stat.mtimeNs}`
  } catch {
    // An absent optional input is represented by its absence from the fingerprint.
    return undefined
  }
}

/** Every fingerprint part one change directory contributes. */
async function changeParts(
  changesRoot: string,
  readRoot: string,
  slugs: readonly string[],
  name: string,
  nowMs: number,
  readTerminalActivity: ActivityReader,
): Promise<string[]> {
  const changeDir = join(changesRoot, name)
  const source = stateStorageSourcePathSync(changeDir)
  if (source === undefined) return []
  const activity = join(changeDir, TERMINAL_ACTIVITY_FILE)
  // 新的测试记录与运行中标记必须推一次 SSE，否则工作台的测试页签只在别的输入变化时才刷新。
  const targets = [
    source,
    join(changeDir, 'tasks.md'),
    join(changeDir, '.pipeline-documents.json'),
    ...slugs.flatMap((slug) => [
      join(readRoot, TENON_PROJECT_DIR, 'users', slug, 'tests', name),
      join(readRoot, TENON_PROJECT_DIR, 'users', slug, 'local', 'running', name),
    ]),
  ]
  const [stats, activityStat] = await Promise.all([
    Promise.all(targets.map(statPart)),
    lstat(activity, { bigint: true }).catch(() => undefined),
  ])
  const parts = stats.filter((part): part is string => part !== undefined)
  if (activityStat !== undefined) {
    try {
      const live = await readTerminalActivity(changeDir, name, nowMs)
      parts.push(`${activity}:${activityStat.size}:${activityStat.mtimeNs}:${live === undefined ? 'stale' : 'live'}`)
    } catch {
      // An unreadable liveness sidecar contributes nothing; the normal idle state has no sidecar either.
    }
  }
  return parts
}

/** What one registered project contributes to the input fingerprint. */
export interface RootFingerprintParts {
  readonly root: string
  /** Project-level parts plus every change's parts; order is not significant. */
  readonly parts: readonly string[]
  /** The parts each change directory contributed, keyed by change name. */
  readonly changes: ReadonlyMap<string, readonly string[]>
}

/** Collect the input fingerprint parts of one registered root while retaining the same anchor as snapshots. */
export async function collectRootFingerprint(
  root: string,
  nowMs: number,
  rootAnchor: ((root: string) => WorkflowRootAnchor | undefined) | undefined,
  readTerminalActivity: ActivityReader,
  readChangesDirectory?: ChangesDirectoryReader,
  viewer?: (root: string) => TenonUserResolution,
): Promise<RootFingerprintParts> {
  const parts: string[] = [`registry:${root}`]
  const changes = new Map<string, readonly string[]>()
  let anchor: WorkflowRootAnchor | undefined
  let ownsAnchor = false
  try {
    if (rootAnchor !== undefined) {
      anchor = rootAnchor(root)
      if (anchor === undefined) throw new Error('registered root 没有可信目录锚')
    } else {
      anchor = captureWorkflowRootAnchor(root)
      ownsAnchor = true
    }
    assertWorkflowRootAnchor(anchor)
    const readRoot = anchor.fdPath ?? anchor.realPath
    parts.push(`root:${root}:${anchor.dev}:${anchor.ino}`)
    parts.push(...await repositoryTopologyFingerprint(readRoot))
    parts.push(...await viewerFingerprintParts(readRoot, viewer?.(root)))
    const changesRoot = join(readRoot, 'openspec', 'changes')
    let entries: Dirent[]
    try {
      entries = readChangesDirectory === undefined
        ? await readdir(changesRoot, { withFileTypes: true })
        : await readChangesDirectory(changesRoot)
    } catch (error) {
      assertWorkflowRootAnchor(anchor)
      if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') throw error
      entries = []
    }
    assertWorkflowRootAnchor(anchor)
    const names = entries.filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name)
    const slugs = names.length === 0 ? [] : await userSlugs(readRoot)
    const perChange = await mapWithConcurrency(names, CHANGE_STAT_CONCURRENCY, (name) => changeParts(
      changesRoot, readRoot, slugs, name, nowMs, readTerminalActivity,
    ))
    for (const [index, name] of names.entries()) {
      const contributed = perChange[index] ?? []
      changes.set(name, contributed)
      parts.push(...contributed)
    }
    assertWorkflowRootAnchor(anchor)
  } catch {
    parts.push(`unreadable:${root}`)
  } finally {
    if (ownsAnchor && anchor !== undefined) closeWorkflowRootAnchor(anchor)
  }
  return { root, parts, changes }
}

/** Build the SSE input fingerprint while retaining the same registered-root anchor as snapshots. */
export async function computeSnapshotFingerprint(
  roots: string[],
  nowMs: number,
  rootAnchor: ((root: string) => WorkflowRootAnchor | undefined) | undefined,
  readTerminalActivity: ActivityReader,
  readChangesDirectory?: ChangesDirectoryReader,
  viewer?: (root: string) => TenonUserResolution,
): Promise<string> {
  const collected = await mapWithConcurrency(dedupeRoots(roots), ROOT_CONCURRENCY, (root) => collectRootFingerprint(
    root, nowMs, rootAnchor, readTerminalActivity, readChangesDirectory, viewer,
  ))
  return collected.flatMap((entry) => entry.parts).sort().join('|')
}

function digest(parts: readonly string[], length: number): string {
  return createHash('sha1').update([...parts].sort().join('|')).digest('hex').slice(0, length)
}

/** A compact, comparable identity of one project's snapshot inputs, and of each change's. */
export interface RootFingerprint {
  readonly root: string
  /** Identity of every input this project contributes; a different key means the project must be rebuilt. */
  readonly key: string
  /** Identity of the inputs one change contributes; it also tells a detail reader that the change moved on. */
  readonly revs: ReadonlyMap<string, string>
}

export function rootFingerprintOf(parts: RootFingerprintParts): RootFingerprint {
  return {
    root: parts.root,
    key: digest(parts.parts, 20),
    revs: new Map([...parts.changes].map(([name, contributed]) => [name, digest(contributed, 12)])),
  }
}

/** The per-project fingerprints of every registered root, in registry order. */
export async function computeRootFingerprints(
  roots: readonly string[],
  nowMs: number,
  rootAnchor: ((root: string) => WorkflowRootAnchor | undefined) | undefined,
  readTerminalActivity: ActivityReader,
  readChangesDirectory?: ChangesDirectoryReader,
  viewer?: (root: string) => TenonUserResolution,
): Promise<RootFingerprint[]> {
  const collected = await mapWithConcurrency(dedupeRoots([...roots]), ROOT_CONCURRENCY, (root) => collectRootFingerprint(
    root, nowMs, rootAnchor, readTerminalActivity, readChangesDirectory, viewer,
  ))
  return collected.map(rootFingerprintOf)
}
