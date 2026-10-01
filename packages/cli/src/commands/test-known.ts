/**
 * `tenon test known add|rm|list` —— 已知失败清单（.tenon/tests/known-failures.yaml，进 git）。
 * 清单内、未过期的用例失败记 known-fail，不挡出口；清单外的失败挡；清单内的用例通过了会提示移出；过期条目按普通失败处理。
 * 每一项带原因、可选链接与到期日；同一 套件 + 用例 再次 add 视为续期 / 改原因。
 *
 * 清单是「暂时不挡」的例外，不是白名单（R3）：条目必须指向具体用例（`<文件> › <用例名>`，只写文件拒绝），到期日距今最多
 * 30 天；清单文件的改动出现在本任务 diff 里，评审门需要用户确认（tenon review request 会把新增条目逐条列给用户）。
 * 命令写出清单后把文件摘要记进本机封存（之后被命令以外的方式改动会被标为「台账外改动」）。
 */
import {
  KNOWN_FAILURES_REPO_PATH, KNOWN_FAILURE_MAX_DAYS, SUITE_ID_RE, knownFailureExpired, latestKnownFailureExpiry, parseCaseRef,
  protectedFileDigest, sealSharedWrite, userSlug, type KnownFailure,
} from '@tenon/kernel'
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
  const ref = parseCaseRef(test)
  if (ref === undefined) return fail(deps, `--test '${test}' 非法（<文件> › <用例名>，分隔符是 ' › '）`)
  if (ref.title.length === 0) return fail(deps, `--test '${test}' 只指向文件；已知失败必须指向具体用例（<文件> › <用例名>）`)
  if (!DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) return fail(deps, `--expires '${expires}' 必须是 YYYY-MM-DD`)
  const today = deps.clock().slice(0, 10)
  if (expires < today) return fail(deps, `--expires ${expires} 已经过去；已知失败必须有未到的到期日`)
  if (expires > latestKnownFailureExpiry(today)) {
    return fail(deps, `--expires ${expires} 超过上限：已知失败最长 ${KNOWN_FAILURE_MAX_DAYS} 天（最晚 ${latestKnownFailureExpiry(today)}）；到期前还没修好就续期，续期同样要评审确认`)
  }
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
  await sealKnownFailures(deps, user.id)
  deps.io.out(`[TEST] 已知失败 ${suite} / ${test} ${outcome.value ? '已续期' : '已登记'}，${expires} 前不挡出口；清单改动需要你在评审门确认（tenon review request 会列出）`)
  return 0
}

/** 命令写出清单之后，把文件摘要记进本机封存（之后命令以外的改动会被标为「台账外改动」）。 */
async function sealKnownFailures(deps: CliDeps, userId: string): Promise<void> {
  await sealSharedWrite(deps.cwd, userSlug(userId), [{
    path: KNOWN_FAILURES_REPO_PATH, digest: await protectedFileDigest(deps.cwd, KNOWN_FAILURES_REPO_PATH),
  }], deps.clock())
}

export async function cmdKnownRemove(deps: CliDeps, opts: { readonly suite?: string; readonly test?: string }): Promise<number> {
  if (opts.suite === undefined || opts.test === undefined) return fail(deps, 'known rm 需要 --suite 与 --test')
  const { suite, test } = opts
  const user = requireUser(deps)
  if (user === null) return 1
  const outcome = await updateKnownFailures(deps.cwd, (entries) => {
    if (!entries.some((item) => item.suite === suite && item.test === test)) return `清单里没有 ${suite} / ${test}`
    return { entries: entries.filter((item) => !(item.suite === suite && item.test === test)), value: true }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  await sealKnownFailures(deps, user.id)
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
