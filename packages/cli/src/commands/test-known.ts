/**
 * `tenon test known add|rm|list` —— 已知失败清单（.tenon/tests/known-failures.yaml，进 git）。
 * 清单内、未过期的用例失败记 known-fail，不挡出口；清单外的失败挡；清单内的用例通过了会提示移出；过期条目按普通失败处理。
 * 每一项带原因、可选链接与到期日；同一 套件 + 用例 再次 add 视为续期 / 改原因。
 */
import { parseCaseRef, knownFailureExpired, SUITE_ID_RE, type KnownFailure } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { readCatalogFile, readKnownFailuresFile, updateKnownFailures } from '../test-system/project-files.js'
import { requireUser } from '../userIdentity.js'

const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

export async function cmdKnownAdd(
  deps: CliDeps,
  opts: { readonly suite?: string; readonly test?: string; readonly reason?: string; readonly expires?: string; readonly link?: string },
): Promise<number> {
  const { suite, test, expires } = opts
  const reason = (opts.reason ?? '').trim()
  if (suite === undefined || test === undefined || expires === undefined || reason === '') {
    return fail(deps, 'known add 需要 --suite、--test "<文件> › <用例名>"、--reason、--expires YYYY-MM-DD')
  }
  if (!SUITE_ID_RE.test(suite)) return fail(deps, `--suite '${suite}' 不是合法的套件 id`)
  if (parseCaseRef(test) === undefined) return fail(deps, `--test '${test}' 非法（<文件> › <用例名>，分隔符是 ' › '）`)
  if (!DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) return fail(deps, `--expires '${expires}' 必须是 YYYY-MM-DD`)
  const today = deps.clock().slice(0, 10)
  if (expires < today) return fail(deps, `--expires ${expires} 已经过去；已知失败必须有未到的到期日`)
  if (Buffer.byteLength(reason) > 1000) return fail(deps, '--reason 不超过 1000 字节')
  if (opts.link !== undefined && !/^https?:\/\/\S+$/.test(opts.link)) return fail(deps, '--link 必须是 http(s) 链接')
  const user = requireUser(deps)
  if (user === null) return 1
  const catalog = await readCatalogFile(deps.cwd)
  if (catalog.state === 'ok' && !catalog.catalog.suites.some((item) => item.id === suite)) {
    return fail(deps, `目录里没有套件 '${suite}'（可选：${catalog.catalog.suites.map((item) => item.id).join(', ') || '无'}）`)
  }
  const entry: KnownFailure = { suite, test, reason, ...(opts.link === undefined ? {} : { link: opts.link }), expires, added_by: user.id }
  const outcome = await updateKnownFailures(deps.cwd, (entries) => {
    const renewed = entries.some((item) => item.suite === suite && item.test === test)
    return { entries: [...entries.filter((item) => !(item.suite === suite && item.test === test)), entry], value: renewed }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  deps.io.out(`[TEST] 已知失败 ${suite} / ${test} ${outcome.value ? '已续期' : '已登记'}，${expires} 前不挡出口`)
  return 0
}

export async function cmdKnownRemove(deps: CliDeps, opts: { readonly suite?: string; readonly test?: string }): Promise<number> {
  if (opts.suite === undefined || opts.test === undefined) return fail(deps, 'known rm 需要 --suite 与 --test')
  const { suite, test } = opts
  const outcome = await updateKnownFailures(deps.cwd, (entries) => {
    if (!entries.some((item) => item.suite === suite && item.test === test)) return `清单里没有 ${suite} / ${test}`
    return { entries: entries.filter((item) => !(item.suite === suite && item.test === test)), value: true }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  deps.io.out(`[TEST] 已从已知失败清单移出 ${suite} / ${test}`)
  return 0
}

export async function cmdKnownList(deps: CliDeps, opts: { readonly json?: boolean }): Promise<number> {
  const file = await readKnownFailuresFile(deps.cwd)
  if (file.state === 'invalid') return fail(deps, `known-failures.yaml 无效：\n${file.issues.slice(0, 5).map((line) => `  ${line}`).join('\n')}`)
  const today = deps.clock().slice(0, 10)
  if (opts.json === true) {
    deps.io.out(JSON.stringify(file.entries.map((entry) => ({ ...entry, expired: knownFailureExpired(entry, today) })), null, 2))
    return 0
  }
  deps.io.out(`[TEST] 已知失败 ${file.entries.length} 项`)
  for (const entry of file.entries) {
    deps.io.out(`  ${knownFailureExpired(entry, today) ? '[已过期] ' : ''}${entry.suite} / ${entry.test}  到期 ${entry.expires}  ${entry.reason}${entry.link === undefined ? '' : `  ${entry.link}`}  (${entry.added_by})`)
  }
  return 0
}
