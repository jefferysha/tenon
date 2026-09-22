/**
 * 归档 is per user: an 已归档 task disappears from this user's listings and refuses progress until
 * 取消归档, while every other user keeps working on it. Reads fail open — a missing identity or a
 * malformed store never hides a task and never blocks a command.
 */
import { relative } from 'node:path'
import { isArchivedForUser, isTenonUser, readTaskArchive, taskArchivedMessage } from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { relocatedChangeDir } from './paths.js'

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
export async function refuseArchived(
  deps: Pick<CliDeps, 'cwd' | 'user' | 'io' | 'store'>,
  name: string,
): Promise<boolean> {
  if (await isArchivedForUser(deps.cwd, deps.user(), name)) {
    deps.io.err(`ERROR: ${taskArchivedMessage(name)}`)
    return true
  }
  return refuseUnfinishedRelocation(deps, name)
}

/**
 * `openspec archive` 抢在 `tenon transition <c> archived` 前面跑过：change 目录已经被搬进
 * `openspec/changes/archive/<日期>-<name>`，而 `archived` 还是 false。
 *
 * 这个状态里没有一条命令能把它推完：change 作用域的文档（tasks / delta-spec / applied-spec）都
 * 按 `openspec/changes/<name>/...` 登记，跟着目录一起搬走之后再也对不上 digest，delta-spec 的
 * capability 槽位还按目录名认身份，而归档目录名多了日期前缀。从前这里只抛一句
 * `ENOENT ... mkdir '.../.pipeline.lock.claim-<uuid>'`——一个只会出现在锁实现里的字符串，既不说
 * 发生了什么，也不说怎么办。现在把这三件事都说清楚：出了什么事、为什么、怎么恢复。
 */
async function refuseUnfinishedRelocation(
  deps: Pick<CliDeps, 'cwd' | 'io' | 'store'>,
  name: string,
): Promise<boolean> {
  const relocated = relocatedChangeDir(deps.cwd, name)
  if (relocated === null) return false
  let fields
  try {
    fields = (await deps.store.read(relocated)).fields
  } catch {
    // 读不出来就不在这儿拦：让命令自己的错误路径去说它读不到什么。
    return false
  }
  const archived = fields.archived
  if ((Array.isArray(archived) ? archived.join(',') : (archived ?? '')) === 'true') return false
  const dated = relative(deps.cwd, relocated)
  deps.io.err(
    `ERROR: change '${name}' 的目录已被 openspec archive 搬到 ${dated}，但它还没完结（archived=false）；`
    + `归档必须排在 tenon transition ${name} archived 之后`,
  )
  deps.io.err(
    `  恢复：mv ${dated} openspec/changes/${name} && tenon transition ${name} archived`
    + ` && openspec archive ${name} --skip-specs --yes`,
  )
  return true
}

/**
 * 「已完结」是另一件事：`archived=true` 说明这条 Change 的状态机已经走完，全项目可见，没有
 * unarchive 这回事。此前只有 per-user 收起表会拒写，于是 `tenon set <完结任务> branch_status pass`
 * 照样 exit 0——完结任务的交付证据仍可被随手改写。两条拒绝的文案必须能分辨：一条指向
 * `tenon task unarchive`，一条指向新建任务。
 */
export function changeFinishedMessage(change: string): string {
  return `任务 '${change}' 已完结（archived=true，状态机已走完）；完结的任务不再接受状态写入，要继续做就新建任务`
}

/** 锁内判定：刚读到的 state 说这条 Change 已完结就拒写。`true` = 已拒绝，调用方不落盘。 */
export function refuseFinished(
  deps: Pick<CliDeps, 'io'>,
  change: string,
  fields: PipelineState['fields'],
): boolean {
  const archived = fields.archived
  if ((Array.isArray(archived) ? archived.join(',') : (archived ?? '')) !== 'true') return false
  deps.io.err(`ERROR: ${changeFinishedMessage(change)}`)
  return true
}
