/**
 * 归档 is per user: an 已归档 task disappears from this user's listings and refuses progress until
 * 取消归档, while every other user keeps working on it. Reads fail open — a missing identity or a
 * malformed store never hides a task and never blocks a command.
 */
import { isTenonUser, readTaskArchive } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

export async function archivedChangesForUser(deps: Pick<CliDeps, 'cwd' | 'user'>): Promise<ReadonlySet<string>> {
  const user = deps.user()
  if (!isTenonUser(user)) return new Set()
  const read = await readTaskArchive(deps.cwd, user)
  return read.kind === 'ok' ? new Set(Object.keys(read.archive.changes)) : new Set()
}
