/**
 * `tenon test catalog not-applicable <kind> --reason <原因> | --rm` —— 声明某个测试种类在本项目不适用。
 *
 * 声明写进 `.tenon/tests/catalog.yaml` 的 `not_applicable`（带原因）。它不会立刻生效：下一次 `tenon review request`
 * 把它连同计划豁免一起列给用户，用户的确认（`tenon review acknowledge`，人工确认、非 `--delegated`）批准后，
 * 策略对所有任务不再要求这个种类，`approved_by` 记录批准人。批准前策略照旧要求，判定给 `waiver-unapproved`。
 * 改理由会让批准清零（批准的是旧理由）。
 */
import {
  TEST_KINDS, catalogNotApplicable, isTestKind, withNotApplicable, withoutNotApplicable,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { updateCatalog } from '../test-system/project-files.js'

const MAX_REASON_BYTES = 1000

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

export async function cmdCatalogNotApplicable(
  deps: CliDeps,
  kind: string,
  opts: { readonly reason?: string; readonly rm?: boolean },
): Promise<number> {
  if (!isTestKind(kind)) return fail(deps, `种类 '${kind}' 不合法（可选：${TEST_KINDS.join('/')}）`)
  if (opts.rm === true) {
    if (opts.reason !== undefined) return fail(deps, '--rm 撤销声明，不需要 --reason')
    const outcome = await updateCatalog(deps.cwd, (catalog) => {
      const removed = withoutNotApplicable(catalog, kind)
      return removed.removed ? { catalog: removed.catalog, value: undefined } : `目录里没有 ${kind} 的不适用声明`
    })
    if (!outcome.ok) return fail(deps, outcome.message)
    deps.io.out(`[TEST] 已撤销 ${kind} 的不适用声明（策略重新要求这个种类）`)
    return 0
  }
  const reason = (opts.reason ?? '').trim()
  if (reason === '' || Buffer.byteLength(reason) > MAX_REASON_BYTES || /[\r\n\0]/.test(reason)) {
    return fail(deps, `--reason 必填：一行、不超过 ${MAX_REASON_BYTES} 字节，写清楚为什么本项目不适用`)
  }
  let suites: readonly string[] = []
  const outcome = await updateCatalog(deps.cwd, (catalog) => {
    suites = catalog.suites.filter((suite) => suite.kind === kind).map((suite) => suite.id)
    const next = withNotApplicable(catalog, kind, reason)
    return { catalog: next, value: catalogNotApplicable(next, kind) }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  const entry = outcome.value
  if (entry !== undefined && entry.approved_by !== null) {
    deps.io.out(`[TEST] ${kind} 已声明不适用且已批准（${entry.approved_by}）：${entry.reason}`)
    return 0
  }
  deps.io.out(`[TEST] 已声明 ${kind} 在本项目不适用：${reason}`)
  deps.io.out('  尚未批准：下一次 tenon review request 会把它列给用户，用户的确认（非 --delegated）批准后对所有任务生效；批准前策略仍要求这个种类')
  if (suites.length > 0) deps.io.out(`  注意：目录里已有 ${kind} 套件（${suites.join('、')}）；计划里登记了套件就仍会运行它`)
  return 0
}
