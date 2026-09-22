/**
 * 归档 is per user: an 已归档 task disappears from this user's listings and refuses progress until
 * 取消归档, while every other user keeps working on it. Reads fail open — a missing identity or a
 * malformed store never hides a task and never blocks a command.
 */
import { isArchivedForUser, isTenonUser, readTaskArchive, taskArchivedMessage } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

export async function archivedChangesForUser(deps: Pick<CliDeps, 'cwd' | 'user'>): Promise<ReadonlySet<string>> {
  const user = deps.user()
  if (!isTenonUser(user)) return new Set()
  const read = await readTaskArchive(deps.cwd, user)
  return read.kind === 'ok' ? new Set(Object.keys(read.archive.changes)) : new Set()
}

/**
 * The single archived-Change refusal for every command that acts on a Change. `true` means refused and
 * the caller returns 1 without writing anything. `get` stays open, because reading a hidden task is how
 * the user decides whether to bring it back; the repair path is `tenon task unarchive`. The field
 * writers (`set` / `set-many` / `cas`) are refused like every other mutation: leaving them open made
 * them the one way to keep changing a task the user had already put away.
 */
export async function refuseArchived(deps: Pick<CliDeps, 'cwd' | 'user' | 'io'>, name: string): Promise<boolean> {
  if (!(await isArchivedForUser(deps.cwd, deps.user(), name))) return false
  deps.io.err(`ERROR: ${taskArchivedMessage(name)}`)
  return true
}
