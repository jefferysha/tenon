/**
 * 删除 internals. The Change directory is renamed into the acting user's gitignored `local/deleting/`
 * tombstone — atomic on one filesystem — and only then removed, so a failure writes nothing and no scan
 * ever meets a half-deleted Change. Git history and the index are never touched; the user commits the
 * removal themselves. Every removal is contained inside the repository and never follows a symlink.
 */
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { clearReviewMarkerOfChange, REVIEW_MARKER_FILE } from '../state/markers.js'
import { GATE_MARKERS } from '../types.js'
import { TENON_PROJECT_DIR, userProjectPaths } from '../users/user-paths.js'
import { updateTaskArchiveOf, withoutTaskArchiveEntry } from './task-archive.js'
import { TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL } from './terminal-activity.js'

const MAX_POINTER_BYTES = 4096
/** The review marker is cleared by Change identity; the other two belong to the acting user's session. */
const SESSION_MARKERS = GATE_MARKERS.filter((name) => name !== REVIEW_MARKER_FILE)

export interface TaskDeleteCleanup {
  readonly removed: readonly string[]
  /** Archive stores that could not be pruned; the deletion stands and the entry is left as is. */
  readonly archiveCorrupt: readonly string[]
}

function repoRelative(repoRoot: string, target: string): string | null {
  const rel = relative(resolve(repoRoot), resolve(target))
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel
}

/** Removes only inside the repository, never through a symlink; returns the repo-relative path removed. */
async function removeInside(repoRoot: string, target: string): Promise<string | null> {
  const rel = repoRelative(repoRoot, target)
  if (rel === null) return null
  let item
  try {
    item = await lstat(target)
  } catch {
    return null
  }
  if (item.isSymbolicLink()) return null
  try {
    await rm(target, { recursive: item.isDirectory(), force: true })
  } catch {
    return null
  }
  return rel
}

async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function readPointer(path: string): Promise<string | null> {
  try {
    const item = await lstat(path)
    if (!item.isFile() || item.size > MAX_POINTER_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Per-user directories present in this checkout; an unparsable directory name is skipped. */
async function checkoutSlugs(repoRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(repoRoot, TENON_PROJECT_DIR, 'users'), { withFileTypes: true })
  } catch {
    return []
  }
  const slugs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      userProjectPaths(repoRoot, entry.name)
      slugs.push(entry.name)
    } catch {
      continue
    }
  }
  return slugs
}

function bindsChange(text: string, change: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return record.protocol === TERMINAL_SESSION_PROTOCOL && record.change === change
  } catch {
    return false
  }
}

async function removeSessionBindings(repoRoot: string, change: string): Promise<string[]> {
  const dir = join(repoRoot, TERMINAL_SESSION_BINDINGS_DIR)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const text = await readPointer(join(dir, entry.name))
    if (text === null || !bindsChange(text, change)) continue
    const rel = await removeInside(repoRoot, join(dir, entry.name))
    if (rel !== null) removed.push(rel)
  }
  return removed
}

/** Leftovers of an interrupted delete by the same user; swept before a new one is staged. */
export async function sweepTaskTombstones(deletingDir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(deletingDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    await rm(join(deletingDir, entry.name), { recursive: true, force: true }).catch(() => {})
  }
}

/** One `rename` moves the whole Change — state, history, documents, ledgers and the lock directory. */
export async function stageTaskForDelete(
  changeDir: string,
  deletingDir: string,
  change: string,
  nowMs: number,
): Promise<string> {
  await mkdir(deletingDir, { recursive: true, mode: 0o700 })
  const tombstone = join(deletingDir, `${change}-${nowMs}`)
  await rename(changeDir, tombstone)
  return tombstone
}

/**
 * Everything outside the Change directory that named it: per-user active pointers and authority
 * projections, the acting user's session markers, the review marker, host session bindings, per-user test
 * records and run artifacts, and every archive entry. Each step is best effort — a Change is already gone.
 */
export async function cleanupDeletedChangeReferences(
  repoRoot: string,
  change: string,
  actingSlug: string,
): Promise<TaskDeleteCleanup> {
  const removed: string[] = []
  const archiveCorrupt: string[] = []
  let clearedOwnPointer = false
  for (const slug of await checkoutSlugs(repoRoot)) {
    const paths = userProjectPaths(repoRoot, slug)
    const pointer = await readPointer(paths.activeChange)
    if (pointer !== null && pointer.replace(/\n+$/u, '') === change) {
      const rel = await removeInside(repoRoot, paths.activeChange)
      if (rel !== null) removed.push(rel)
      if (slug === actingSlug) clearedOwnPointer = true
    }
    const authority = await readPointer(paths.authority)
    if (authority !== null && authority.split('\n').includes(`change=${change}`)) {
      const rel = await removeInside(repoRoot, paths.authority)
      if (rel !== null) removed.push(rel)
    }
    for (const dir of [join(paths.testsDir, change), join(paths.artifactsDir, change)]) {
      const rel = await removeInside(repoRoot, dir)
      if (rel !== null) removed.push(rel)
    }
    // Only an existing store is pruned; a user who never archived anything gets no file created.
    if (!(await isPlainFile(paths.archived))) continue
    const update = await updateTaskArchiveOf(repoRoot, slug, (archive) => withoutTaskArchiveEntry(archive, change))
    if (update.kind === 'corrupt') archiveCorrupt.push(update.path)
    else if (update.written) removed.push(repoRelative(repoRoot, paths.archived) ?? paths.archived)
  }
  if (clearedOwnPointer) {
    for (const marker of SESSION_MARKERS) {
      const rel = await removeInside(repoRoot, join(repoRoot, marker))
      if (rel !== null) removed.push(rel)
    }
  }
  if (await clearReviewMarkerOfChange(repoRoot, change).catch(() => false)) removed.push(REVIEW_MARKER_FILE)
  removed.push(...await removeSessionBindings(repoRoot, change))
  return { removed, archiveCorrupt }
}
