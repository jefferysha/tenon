/**
 * `tenon test discover [--write] [--json]` —— 识别项目里的测试工具，给出建议的目录套件。
 * 不带 --write 只打印差异；带 --write 把目录里还没有的套件追加进 .tenon/tests/catalog.yaml，已存在的 id 不覆盖。
 */
import type { CliDeps } from '../deps.js'
import { usableDiscovery } from '../test-system/auto-discover.js'
import { readCatalogFile, updateCatalog } from '../test-system/project-files.js'

export async function cmdTestDiscover(
  deps: CliDeps,
  opts: { readonly write?: boolean; readonly json?: boolean } = {},
): Promise<number> {
  const current = await readCatalogFile(deps.cwd)
  if (current.state === 'invalid') {
    deps.io.err(`ERROR: catalog.yaml 无效，先修好：\n${current.issues.slice(0, 5).map((line) => `  ${line}`).join('\n')}`)
    deps.io.err('  执行 tenon test catalog validate 查看全部问题')
    return 1
  }
  const existing = new Set(current.state === 'ok' ? current.catalog.suites.map((suite) => suite.id) : [])
  const { suites: usable, notes } = await usableDiscovery(deps.cwd)
  const fresh = usable.filter((found) => !existing.has(found.suite.id))
  let written = false
  if (opts.write === true && fresh.length > 0) {
    const outcome = await updateCatalog(deps.cwd, (catalog) => ({
      catalog: { ...catalog, suites: [...catalog.suites, ...fresh.map((found) => found.suite)] },
      value: undefined,
    }))
    if (!outcome.ok) {
      deps.io.err(`ERROR: ${outcome.message}`)
      return 1
    }
    written = true
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      catalog: current.state,
      written,
      suites: usable.map((found) => ({
        id: found.suite.id, state: existing.has(found.suite.id) ? 'exists' : written ? 'added' : 'new',
        source: found.source, suite: found.suite,
      })),
      notes,
    }, null, 2))
    return 0
  }
  deps.io.out(`[TEST] discover：识别到 ${usable.length} 个套件（${fresh.length} 个不在目录里${written ? '，已写入' : ''}）`)
  for (const found of usable) {
    const mark = existing.has(found.suite.id) ? '=' : written ? '+' : '·'
    deps.io.out(`  ${mark} ${found.suite.id}  ${found.suite.kind}/${found.suite.runner}  cwd=${found.suite.cwd}  ${found.suite.command}  (${found.source})`)
  }
  for (const note of notes) deps.io.out(`  提示：${note}`)
  if (fresh.length > 0 && !written) deps.io.out('  加 --write 把上面标 · 的套件写进 .tenon/tests/catalog.yaml（已存在的 id 不覆盖）')
  if (written || fresh.length === 0) deps.io.out('  下一步：tenon test plan <change> --seed 登记本任务的测试计划')
  return 0
}
