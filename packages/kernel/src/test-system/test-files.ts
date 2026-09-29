/**
 * 全量登记强制（纯函数）：diff 里新增 / 修改的测试文件必须全部进计划。
 *   · 匹配任一目录套件 `files` 的文件，不在计划 `files` 里 → 未登记（test-file-unregistered）；
 *   · 看起来像测试（`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.go`、`*.bench.*`、`e2e/**`）却没有套件认领、
 *     也没有登记 → 孤儿（test-file-orphan），先在目录里加套件。
 * 输入的 diff 文件列表由宿主给出（相对 change 起点、仓库相对、正斜杠），本模块不碰 git。
 */
import { suiteFileGlobs } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { matchesAnyGlob } from './globs.js'
import type { TestPlan } from './plan.js'
import { looksLikeTestFile } from './vocabulary.js'

export interface UnregisteredTestFile {
  readonly path: string
  /** 认领该文件的目录套件（登记命令的建议值）。 */
  readonly suites: readonly string[]
}

export interface TestFileRegistration {
  readonly unregistered: readonly UnregisteredTestFile[]
  readonly orphans: readonly string[]
}

export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function suitesOwningFile(catalog: TestCatalog, path: string): readonly string[] {
  return catalog.suites.filter((suite) => matchesAnyGlob(path, suiteFileGlobs(suite))).map((suite) => suite.id)
}

export function testFileRegistration(input: {
  readonly changedFiles: readonly string[]
  readonly catalog: TestCatalog
  readonly plan: TestPlan | undefined
}): TestFileRegistration {
  const registered = new Set((input.plan?.files ?? []).map((file) => normalizeRepoPath(file.path)))
  const unregistered: UnregisteredTestFile[] = []
  const orphans: string[] = []
  for (const path of [...new Set(input.changedFiles.map(normalizeRepoPath))].sort()) {
    if (path === '' || registered.has(path)) continue
    const suites = suitesOwningFile(input.catalog, path)
    if (suites.length > 0) unregistered.push({ path, suites })
    else if (looksLikeTestFile(path)) orphans.push(path)
  }
  return { unregistered, orphans }
}
