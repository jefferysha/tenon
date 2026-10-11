/**
 * 任务结束 = 目录移进 `openspec/changes/archive/`；没有「隐藏」，任务要么在进行、要么已结束。
 * 已结束的任务不再接受推进：
 *   · 已终止（规范状态里 `task_result=terminated`）：状态机没走完，写入口一律拒绝并指向「新建任务 + depends_on」；
 *   · 目录被 `openspec archive` 抢在 `tenon transition <c> archived` 之前搬走、没有任务结果记录（手工操作的
 *     中间态）：说清楚出了什么事、为什么、怎么恢复；
 *   · 完结 / 已升级（`archived=true`）：搬进归档目录是正常终态，这里不拦，字段写入由 refuseFinished 按状态拒绝。
 */
import { relative } from 'node:path'
import { readTaskResult } from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { relocatedChangeDir } from './paths.js'
import { msg } from './i18n/messages.js'

/**
 * The single ended-Change refusal for every command that acts on a Change. `true` means refused and the
 * caller returns 1 without writing anything. Reads (`get`, `status`) never call it.
 */
export async function refuseArchived(
  deps: Pick<CliDeps, 'cwd' | 'io' | 'store' | 'locale'>,
  name: string,
): Promise<boolean> {
  const relocated = relocatedChangeDir(deps.cwd, name)
  if (relocated === null) return false
  const dated = relative(deps.cwd, relocated)
  if (await readTaskResult(relocated, deps.store) === 'terminated') {
    deps.io.err(`ERROR: ${msg(deps, 'change.terminated', { name, dated })}`)
    return true
  }
  return refuseUnfinishedRelocation(deps, name, relocated, dated)
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
  deps: Pick<CliDeps, 'io' | 'store' | 'locale'>,
  name: string,
  relocated: string,
  dated: string,
): Promise<boolean> {
  let fields
  try {
    fields = (await deps.store.read(relocated)).fields
  } catch {
    // 读不出来就不在这儿拦：让命令自己的错误路径去说它读不到什么。
    return false
  }
  const archived = fields.archived
  if ((Array.isArray(archived) ? archived.join(',') : (archived ?? '')) === 'true') return false
  deps.io.err(`ERROR: ${msg(deps, 'change.relocated', { name, dated })}`)
  deps.io.err(msg(deps, 'change.relocatedRecover', { name, dated }))
  return true
}

/**
 * 「已完结」是另一件事：`archived=true` 说明这条 Change 的状态机已经走完，全项目可见。此前只有收起表会拒写，
 * 于是 `tenon set <完结任务> branch_status pass` 照样 exit 0——完结任务的交付证据仍可被随手改写。
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
