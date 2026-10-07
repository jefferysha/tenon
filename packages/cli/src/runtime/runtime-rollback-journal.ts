import { link, lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeActivationCheckpoint } from './installer-contract.js'
import { ManagedRuntimeIndeterminateError } from './installer-contract.js'
import type { RuntimePaths, RuntimeSelection } from './types.js'

export interface RuntimeRollbackJournal {
  readonly version: 1
  readonly transactionId: string
  readonly beforeSelection: RuntimeSelection
  readonly target: {
    readonly revision: number
    readonly activeRelease: string
    readonly previousRelease: string | null
  }
  readonly launchers: RuntimeActivationCheckpoint['launchers']
}

export function rollbackJournalPath(paths: RuntimePaths): string {
  return join(paths.managedTransactionRoot, 'runtime-rollback.json')
}

function isLauncherSnapshot(value: unknown): value is RuntimeActivationCheckpoint['launchers'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'hook,tenon') return false
  return (['tenon', 'hook'] as const).every((name) => {
    const item = record[name]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const file = item as Record<string, unknown>
    if (Object.keys(file).sort().join(',') !== 'path,state' || typeof file.path !== 'string') return false
    const state = file.state
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return false
    const snapshot = state as Record<string, unknown>
    return snapshot.kind === 'missing'
      ? Object.keys(snapshot).join(',') === 'kind'
      : snapshot.kind === 'file'
        && Object.keys(snapshot).sort().join(',') === 'content,kind,mode'
        && typeof snapshot.content === 'string'
        && Number.isSafeInteger(snapshot.mode)
        && (snapshot.mode as number) >= 0
        && (snapshot.mode as number) <= 0o777
  })
}

export function decodeRollbackJournal(raw: string): RuntimeRollbackJournal {
  let value: unknown
  try { value = JSON.parse(raw) } catch {
    throw new ManagedRuntimeIndeterminateError('runtime rollback journal 不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManagedRuntimeIndeterminateError('runtime rollback journal schema 非法')
  }
  const record = value as Record<string, unknown>
  const before = record.beforeSelection as RuntimeSelection | undefined
  const target = record.target as RuntimeRollbackJournal['target'] | undefined
  if (Object.keys(record).sort().join(',') !== 'beforeSelection,launchers,target,transactionId,version'
    || record.version !== 1
    || typeof record.transactionId !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.transactionId)
    || typeof before !== 'object' || before === null
    || Object.keys(before).sort().join(',') !== 'activeRelease,previousRelease,revision,updatedAt,version'
    || before.version !== 1 || !Number.isSafeInteger(before.revision) || before.revision < 0
    || (before.activeRelease !== null && typeof before.activeRelease !== 'string')
    || (before.previousRelease !== null && typeof before.previousRelease !== 'string')
    || typeof before.updatedAt !== 'string'
    || typeof target !== 'object' || target === null
    || Object.keys(target).sort().join(',') !== 'activeRelease,previousRelease,revision'
    || !Number.isSafeInteger(target.revision) || target.revision !== before.revision + 1
    || typeof target.activeRelease !== 'string' || target.activeRelease === ''
    || target.activeRelease !== before.previousRelease || target.previousRelease !== before.activeRelease
    || !isLauncherSnapshot(record.launchers)) {
    throw new ManagedRuntimeIndeterminateError('runtime rollback journal identity 非法')
  }
  return {
    version: 1,
    transactionId: record.transactionId,
    beforeSelection: before,
    target,
    launchers: record.launchers,
  }
}

export async function readRollbackJournal(paths: RuntimePaths): Promise<RuntimeRollbackJournal | null> {
  try {
    return decodeRollbackJournal(await readFile(rollbackJournalPath(paths), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The private copy a bootstrap rollback moves a launcher to while it publishes the target launcher. The name is part of the
 * bootstrap's format (`convergeRollbackLauncher` in runtime/tenon-bootstrap.mjs), keyed by the journal's transaction id.
 */
export function rollbackPrivateLauncherPath(launcherPath: string, transactionId: string): string {
  return `${launcherPath}.tenon-rollback-${transactionId}.previous`
}

async function readRegularFile(path: string): Promise<{ readonly content: string; readonly mode: number } | null> {
  try {
    const item = await lstat(path)
    if (!item.isFile() || item.isSymbolicLink()) return null
    return { content: await readFile(path, 'utf8'), mode: item.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Drop a rollback journal whose rollback never took effect (the selection is still its start), together with the private
 * launcher copies its transaction may have left. A copy is touched only when it is byte-for-byte the journal's recorded
 * checkpoint, so nothing that merely carries the transaction id is deleted. If the launcher itself is gone, the copy is the
 * only remaining original: it goes back to the launcher path before it is dropped. The journal goes last, so an interrupted
 * discard is repeated by the next one.
 */
export async function discardUnflippedRollbackJournal(paths: RuntimePaths, journal: RuntimeRollbackJournal): Promise<void> {
  for (const name of ['tenon', 'hook'] as const) {
    const checkpoint = journal.launchers[name]
    if (checkpoint.state.kind !== 'file') continue
    const privatePath = rollbackPrivateLauncherPath(checkpoint.path, journal.transactionId)
    const copy = await readRegularFile(privatePath)
    if (copy === null || copy.content !== checkpoint.state.content || copy.mode !== checkpoint.state.mode) continue
    const launcherGone = await lstat(checkpoint.path).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true
      throw error
    })
    if (launcherGone) await link(privatePath, checkpoint.path)
    await rm(privatePath)
  }
  await rm(rollbackJournalPath(paths), { force: true })
}

export function selectionMatchesRollbackTarget(
  selection: RuntimeSelection,
  target: RuntimeRollbackJournal['target'],
): boolean {
  return selection.version === 1
    && selection.revision === target.revision
    && selection.activeRelease === target.activeRelease
    && selection.previousRelease === target.previousRelease
}
