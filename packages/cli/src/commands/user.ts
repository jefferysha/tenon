/**
 * `tenon user [--json]` shows the declared identity; `tenon user set <id> [--name]` writes the machine-local
 * `user.json`. Identity is self-declared: nothing here authenticates a person.
 */
import { formatUserRef, userResolutionView, validateUserId, writeUserConfig } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { requireUser } from '../userIdentity.js'

export async function cmdUser(deps: CliDeps, opts: { json?: boolean } = {}): Promise<number> {
  if (opts.json) deps.io.out(JSON.stringify(userResolutionView(deps.user())))
  const user = requireUser(deps)
  if (user === null) return 1
  if (!opts.json) deps.io.out(`${formatUserRef(user)} ${user.source}`)
  return 0
}

export async function cmdUserSet(deps: CliDeps, id: string, opts: { name?: string } = {}): Promise<number> {
  if (validateUserId(id) === null) {
    deps.io.err(`ERROR: 用户邮箱非法: ${id}`)
    return 1
  }
  try {
    await writeUserConfig(deps.userConfigPath(), { id, ...(opts.name === undefined ? {} : { name: opts.name }) })
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  if ((deps.env?.('TENON_USER') ?? '').trim() !== '') deps.io.err('WARN: TENON_USER 覆盖本机配置')
  return cmdUser(deps)
}
