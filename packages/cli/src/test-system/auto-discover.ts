/**
 * 识别结果落进目录的共用逻辑：`tenon test discover --write` 与 `tenon init` 的自动识别都经这里。
 *   · usableDiscovery：识别 + 丢掉通不过目录校验的建议套件（原因进 notes）；
 *   · autoDiscoverCatalog：项目还没有目录时识别并写入。已有目录（含无效的）一律不动——无效的目录要人先修，
 *     已有的目录要靠 `tenon test discover --write` 显式追加，绝不在 init 里悄悄改。
 */
import {
  formatCatalogIssues, parseTestCatalog, serializeTestCatalog, type CatalogSuite,
} from '@tenon/kernel'
import { discoverTests, type DiscoveredSuite } from './discover.js'
import { emptyCatalog, readCatalogFile, updateCatalog } from './project-files.js'

function invalidReason(suite: CatalogSuite): string | undefined {
  const parsed = parseTestCatalog(serializeTestCatalog({ ...emptyCatalog(), suites: [suite] }))
  return parsed.ok ? undefined : formatCatalogIssues(parsed.issues).slice(0, 2).join('；')
}

export interface UsableDiscovery {
  readonly suites: readonly DiscoveredSuite[]
  readonly notes: readonly string[]
}

export async function usableDiscovery(repoRoot: string): Promise<UsableDiscovery> {
  const result = await discoverTests(repoRoot)
  const notes = [...result.notes]
  const suites = result.suites.filter((found) => {
    const problem = invalidReason(found.suite)
    if (problem !== undefined) notes.push(`跳过建议套件 ${found.suite.id}：${problem}`)
    return problem === undefined
  })
  return { suites, notes }
}

export type AutoDiscoverOutcome =
  | { readonly state: 'existing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'none'; readonly notes: readonly string[] }
  | { readonly state: 'written'; readonly suites: readonly string[]; readonly notes: readonly string[] }
  | { readonly state: 'failed'; readonly message: string }

/** 项目还没有测试目录时：识别并写入。没有识别到任何套件时不写（不留一份空目录）。 */
export async function autoDiscoverCatalog(repoRoot: string): Promise<AutoDiscoverOutcome> {
  const current = await readCatalogFile(repoRoot)
  if (current.state === 'ok') return { state: 'existing' }
  if (current.state === 'invalid') return { state: 'invalid' }
  const found = await usableDiscovery(repoRoot)
  if (found.suites.length === 0) return { state: 'none', notes: found.notes }
  const outcome = await updateCatalog(repoRoot, (catalog) => ({
    catalog: { ...catalog, suites: [...catalog.suites, ...found.suites.map((item) => item.suite)] },
    value: found.suites.map((item) => item.suite.id),
  }))
  return outcome.ok
    ? { state: 'written', suites: outcome.value, notes: found.notes }
    : { state: 'failed', message: outcome.message }
}
