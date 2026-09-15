/**
 * `tenon owner take <change>` (接手: the current user becomes owner) and `tenon owner set <change> <id> [--name]`
 * (hand-over, owner only). Both go through the kernel `transferOwner` use case the Dashboard also calls.
 */
import {
  formatUserRef, normalizeUserName, ownerRequiredMessage, stateStorageExistsSync, transferOwner, validateUserId,
  type RecordActor,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { requireActor } from '../userIdentity.js'

async function transfer(deps: CliDeps, name: string, to?: RecordActor): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const actor = requireActor(deps)
  if (actor === null) return 1
  const dir = changeDir(deps.cwd, name)
  if (!stateStorageExistsSync(dir)) {
    deps.io.err(`ERROR: 找不到任务 ${name}`)
    return 1
  }
  try {
    const result = await transferOwner(
      { store: deps.store, history: deps.history, clock: deps.clock },
      { changeDir: dir, change: name, actor, ...(to === undefined ? {} : { to }) },
    )
    if (result.kind === 'owner-required') {
      deps.io.err(`ERROR: ${ownerRequiredMessage(name, result.owner)}`)
      return 1
    }
    if (result.kind === 'changed' && result.historyError !== undefined) {
      deps.io.err(`WARN: history 写入失败: ${errMsg(result.historyError)}`)
    }
    deps.io.out(formatUserRef(result.to))
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}

export function cmdOwnerTake(deps: CliDeps, name: string): Promise<number> {
  return transfer(deps, name)
}

export async function cmdOwnerSet(deps: CliDeps, name: string, id: string, opts: { name?: string } = {}): Promise<number> {
  const valid = validateUserId(id)
  if (valid === null) {
    deps.io.err(`ERROR: 用户邮箱非法: ${id}`)
    return 1
  }
  return transfer(deps, name, { id: valid, name: normalizeUserName(opts.name, valid), trust: 'declared' })
}
