/**
 * `pr_url` 的取值闸。
 *
 * 真机验收（D8）：ship 步唯一的 `next` 是 `set-field pr_url`（没有 allowed / recommended），而仓库
 * 没有远端——这一步做不完；`pr_url` 又接受任意字符串（"not a url"），于是唯一「能过」的写法是编造。
 * 设计（data-driven-runner §3.7 / §9.1）说 `pr_url` 只填真值、绝不编造；这里把「真值」落成两种：
 *
 *   · 一个 http(s) URL（有主机名）；
 *   · `no-remote`：本地交付、没有 PR——只有仓库确实没有任何 git 远端时才接受。
 *
 * 选这一种而不是「无远端时 guard 不要求 pr_url」：出口规则表（kernel flow/guard.ts）与老内核
 * 双跑对齐（oracle），改 guard 会让新旧两侧的出口判定分家；一个可核对的诚实取值不动 guard，
 * 也让「这次交付没有 PR」成为记录在案的事实，而不是一条缺失。
 */
import type { FieldName } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

export const PR_URL_NO_REMOTE = 'no-remote'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/** 仓库确实没有远端时 `no-remote` 才是真值；判定不了（git 跑不起来）按「有远端」处理。 */
export async function repositoryHasNoRemote(deps: CliDeps): Promise<boolean> {
  const remotes = await (deps.gitRemotes?.() ?? Promise.resolve(null))
  return remotes !== null && remotes.length === 0
}

/** true = 已拒写并打印原因。空值（清空）照旧放行。 */
export async function refuseInvalidPrUrl(
  deps: CliDeps,
  field: FieldName,
  value: string | string[],
): Promise<boolean> {
  if (field !== 'pr_url') return false
  const raw = Array.isArray(value) ? value.join(',') : value
  if (raw === '' || raw === 'null' || isHttpUrl(raw)) return false
  if (raw === PR_URL_NO_REMOTE) {
    const remotes = await (deps.gitRemotes?.() ?? Promise.resolve(null))
    if (remotes !== null && remotes.length === 0) return false
    deps.io.err(remotes === null
      ? `ERROR: 字段 'pr_url' 取 '${PR_URL_NO_REMOTE}' 需要确认仓库没有 git 远端，但 git remote 无法执行`
      : `ERROR: 字段 'pr_url' 不能取 '${PR_URL_NO_REMOTE}'：仓库配置了远端（${remotes.join(', ')}）；推送并开 PR 后填它的 URL`)
    return true
  }
  deps.io.err(`ERROR: 字段 'pr_url' 必须是 http(s) URL，或在仓库没有 git 远端时取 '${PR_URL_NO_REMOTE}'（当前='${raw}'）`)
  return true
}
