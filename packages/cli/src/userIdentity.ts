/** One identity guard for every CLI write: missing identity prints the setup hint and blocks the write. */
import { actorOf, isTenonUser, type RecordActor, type TenonUser } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { msg } from './i18n/messages.js'

export function requireUser(deps: Pick<CliDeps, 'user' | 'io' | 'locale'>): TenonUser | null {
  const resolved = deps.user()
  if (isTenonUser(resolved)) return resolved
  deps.io.err(`ERROR: ${msg(deps, 'user.missing')}`)
  return null
}

export function requireActor(deps: Pick<CliDeps, 'user' | 'io' | 'locale'>): RecordActor | null {
  const user = requireUser(deps)
  return user === null ? null : actorOf(user)
}
