/**
 * Per-user archive store `<repo>/.tenon/users/<slug>/local/archived.json` — the Changes the acting user
 * hides (归档). It is a display preference, never workflow state: an absent, unreadable or malformed file
 * reads as empty so progress never stops, while a write refuses to overwrite a malformed one. The
 * serializer keeps every Change on its own 4-space key line, the ABI `hooks/task-archive.sh` greps.
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '../state/lock.js'
import { ensureUserLocalDir, isPlainDirectory, userProjectPaths, writeUserLocalFile } from '../users/user-paths.js'
import { decodeRecordActor, isTenonUser } from '../users/user.js'
import type { RecordActor, TenonUser, TenonUserResolution } from '../users/user.js'

const MAX_ARCHIVE_BYTES = 1_048_576
const CHANGE_NAME = /^[A-Za-z0-9_-]+$/u
/** OpenSpec's own archive directory; never a Change of its own. */
const RESERVED_CHANGE_DIR = 'archive'

export interface TaskArchiveEntry {
  readonly archivedAt: string
  readonly phase: string
  readonly actor: RecordActor
}

export interface TaskArchive {
  readonly version: 1
  readonly changes: Readonly<Record<string, TaskArchiveEntry>>
}

export type TaskArchiveRead =
  | { readonly kind: 'ok'; readonly archive: TaskArchive }
  | { readonly kind: 'corrupt'; readonly path: string }

export type TaskArchiveUpdate =
  | { readonly kind: 'ok'; readonly archive: TaskArchive; readonly changed: boolean; readonly written: boolean }
  | { readonly kind: 'corrupt'; readonly path: string }

export const EMPTY_TASK_ARCHIVE: TaskArchive = { version: 1, changes: {} }

export function isTaskLifecycleName(name: string): boolean {
  return CHANGE_NAME.test(name) && name !== RESERVED_CHANGE_DIR
}

export function taskChangeDir(repoRoot: string, change: string): string {
  return join(repoRoot, 'openspec', 'changes', change)
}

export function taskArchivePath(repoRoot: string, user: TenonUser): string {
  return userProjectPaths(repoRoot, user.slug).archived
}

function entryOf(value: unknown): TaskArchiveEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 3 || keys[0] !== 'actor' || keys[1] !== 'archived_at' || keys[2] !== 'phase') return null
  const actor = decodeRecordActor(record.actor)
  if (actor === undefined || actor === null) return null
  if (typeof record.archived_at !== 'string' || !Number.isFinite(Date.parse(record.archived_at))) return null
  if (typeof record.phase !== 'string' || record.phase === '') return null
  return { archivedAt: record.archived_at, phase: record.phase, actor }
}

function archiveOf(text: string): TaskArchive | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'changes' || keys[1] !== 'version' || record.version !== 1) return null
  if (typeof record.changes !== 'object' || record.changes === null || Array.isArray(record.changes)) return null
  const changes: Record<string, TaskArchiveEntry> = {}
  for (const [name, raw] of Object.entries(record.changes)) {
    const entry = entryOf(raw)
    if (!isTaskLifecycleName(name) || entry === null) return null
    changes[name] = entry
  }
  return { version: 1, changes }
}

/** A Change removed from disk is dropped, so 删除 can never leave a ghost row in the 已归档 view. */
async function pruneMissing(repoRoot: string, archive: TaskArchive): Promise<TaskArchive> {
  const changes: Record<string, TaskArchiveEntry> = {}
  for (const [name, entry] of Object.entries(archive.changes)) {
    if (await isPlainDirectory(taskChangeDir(repoRoot, name))) changes[name] = entry
  }
  return { version: 1, changes }
}

export function serializeTaskArchive(archive: TaskArchive): string {
  const changes: Record<string, unknown> = {}
  for (const name of Object.keys(archive.changes).sort()) {
    const entry = archive.changes[name]
    if (entry !== undefined) changes[name] = { archived_at: entry.archivedAt, phase: entry.phase, actor: entry.actor }
  }
  return `${JSON.stringify({ version: 1, changes }, null, 2)}\n`
}

/** Absent, non-regular or unreadable → empty; a malformed payload → `corrupt` with its path. */
export async function readTaskArchiveOf(repoRoot: string, slug: string): Promise<TaskArchiveRead> {
  const path = userProjectPaths(repoRoot, slug).archived
  let text: string
  try {
    const item = await lstat(path)
    if (!item.isFile() || item.size > MAX_ARCHIVE_BYTES) return { kind: 'corrupt', path }
    text = await readFile(path, 'utf8')
  } catch {
    return { kind: 'ok', archive: EMPTY_TASK_ARCHIVE }
  }
  const archive = archiveOf(text)
  return archive === null ? { kind: 'corrupt', path } : { kind: 'ok', archive: await pruneMissing(repoRoot, archive) }
}

export async function readTaskArchive(repoRoot: string, user: TenonUser): Promise<TaskArchiveRead> {
  return readTaskArchiveOf(repoRoot, user.slug)
}

/** Serialize under `withLock(localDir)`, the same critical section the lifecycle application re-assesses in. */
export async function withTaskArchiveLock<T>(repoRoot: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const paths = await ensureUserLocalDir(repoRoot, slug)
  return withLock(paths.localDir, fn)
}

/** Writes only when the canonical bytes differ, so pruning a deleted Change also lands. */
export async function writeTaskArchiveOf(repoRoot: string, slug: string, archive: TaskArchive): Promise<boolean> {
  const path = userProjectPaths(repoRoot, slug).archived
  const text = serializeTaskArchive(archive)
  let current: string | null = null
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = null
  }
  if (current === text) return false
  await writeUserLocalFile(path, text)
  return true
}

/**
 * Read-modify-write under the store lock. `edit` returns `null` for "no entry change"; the file is still
 * rewritten when pruning changed its bytes. A malformed store is reported, never overwritten.
 */
export async function updateTaskArchiveOf(
  repoRoot: string,
  slug: string,
  edit: (archive: TaskArchive) => TaskArchive | null,
): Promise<TaskArchiveUpdate> {
  return withTaskArchiveLock(repoRoot, slug, async () => {
    const current = await readTaskArchiveOf(repoRoot, slug)
    if (current.kind === 'corrupt') return current
    const edited = edit(current.archive)
    const archive = edited ?? current.archive
    const written = await writeTaskArchiveOf(repoRoot, slug, archive)
    return { kind: 'ok', archive, changed: edited !== null, written }
  })
}

export function withoutTaskArchiveEntry(archive: TaskArchive, change: string): TaskArchive | null {
  if (archive.changes[change] === undefined) return null
  const changes = { ...archive.changes }
  delete changes[change]
  return { version: 1, changes }
}

/**
 * 这条说的是 per-user 的「先收起来」，不是任务已完结。两件事都曾只说「已归档」，读的人分不出
 * 自己撞的是哪一个，也就不知道该 unarchive 还是该新建任务——所以这里点名是谁的收起列表。
 */
export function taskArchivedMessage(change: string): string {
  return `任务 '${change}' 已归档（当前用户的收起列表，不是任务已完结）；先执行 tenon task unarchive ${change}`
}

export class TaskArchivedError extends Error {
  readonly code = 'task-archived' as const

  constructor(readonly change: string) {
    super(taskArchivedMessage(change))
    this.name = 'TaskArchivedError'
  }
}

/** Fail-open: a missing identity or a malformed store reports "not archived". */
export async function isArchivedForUser(
  repoRoot: string,
  user: TenonUserResolution,
  change: string,
): Promise<boolean> {
  if (!isTenonUser(user) || !isTaskLifecycleName(change)) return false
  const read = await readTaskArchiveOf(repoRoot, user.slug)
  return read.kind === 'ok' && read.archive.changes[change] !== undefined
}

/**
 * The single archived-Change refusal every command acting on a Change calls first (transition, advance,
 * review, document record, artifact register, and later `tenon test` / `tenon agent`).
 */
export async function assertTaskNotArchived(
  repoRoot: string,
  user: TenonUserResolution,
  change: string,
): Promise<void> {
  if (await isArchivedForUser(repoRoot, user, change)) throw new TaskArchivedError(change)
}
