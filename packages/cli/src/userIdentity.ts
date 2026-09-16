/** One identity guard for every CLI write: missing identity prints the setup hint and blocks the write. */
import { actorOf, isTenonUser, USER_MISSING_HINT, type RecordActor, type TenonUser } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

export function requireUser(deps: Pick<CliDeps, 'user' | 'io'>): TenonUser | null {
  const resolved = deps.user()
  if (isTenonUser(resolved)) return resolved
  deps.io.err(`ERROR: ${USER_MISSING_HINT}`)
  return null
}

export function requireActor(deps: Pick<CliDeps, 'user' | 'io'>): RecordActor | null {
  const user = requireUser(deps)
  return user === null ? null : actorOf(user)
}
