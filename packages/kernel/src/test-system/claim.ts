/**
 * 改动过的测试文件自动认领（M3，纯函数）：本任务改动里被某个套件 `files` glob 匹配的文件，归入该套件，不再逐个登记。
 *   · 改动列表先去掉控制目录（`openspec/`、`.tenon/`、`.pipeline/`）；
 *   · 没有任何套件认领、命名又像测试（且是源码扩展名）的文件是孤儿——否则这些测试永远不会跑；
 *   · 认领在求值时现算，不写进 `test-plan.yaml`，所以新增测试文件不会让计划摘要变化、已有运行不会因此过期。
 * 求值（evaluate-v2）、阶段运行集（stage-run-set）、`tenon test sync` 与 `register --auto` 共用这一份口径。
 */
import { suiteFileGlobs } from './catalog.js'
import type { CatalogSuite, TestCatalog } from './catalog-types.js'
import { matchesAnyGlob } from './globs.js'
import type { TestPlan } from './plan.js'
import { normalizeRepoPath, suitesOwningFile, type OwnedTestFile } from './test-files.js'
import { withoutControlPaths } from './test-paths.js'
import { looksLikeTestFile } from './vocabulary.js'

export interface ChangedTestFiles {
  /** 套件 id → 本任务改动过、被该套件 files glob 认领的测试文件（仓库相对、排序）。按目录里套件的顺序。 */
  readonly claimed: ReadonlyMap<string, readonly string[]>
  /** 像测试却没有任何套件认领的改动文件（排序）。 */
  readonly orphans: readonly string[]
}

/** 归一、去控制目录、去重、排序后的改动路径。认领与阶段运行集（stage-run-set）判定「碰到了哪些文件」都用这一口径。 */
export function changedRepoPaths(changedFiles: readonly string[]): string[] {
  return [...new Set(withoutControlPaths(changedFiles.map(normalizeRepoPath)))].filter((path) => path !== '').sort()
}

export function claimChangedTestFiles(changedFiles: readonly string[], catalog: TestCatalog): ChangedTestFiles {
  const byPath = new Map<string, readonly string[]>()
  const orphans: string[] = []
  for (const path of changedRepoPaths(changedFiles)) {
    const owners = suitesOwningFile(catalog, path)
    if (owners.length > 0) byPath.set(path, owners)
    else if (looksLikeTestFile(path)) orphans.push(path)
  }
  const claimed = new Map<string, readonly string[]>()
  for (const suite of catalog.suites) {
    const files = [...byPath].filter(([, owners]) => owners.includes(suite.id)).map(([path]) => path)
    if (files.length > 0) claimed.set(suite.id, files)
  }
  return { claimed, orphans }
}

/** 「套件 → 文件」的认领映射转成「文件 → 认领它的套件们」（按路径排序，套件按目录顺序）：报告的 `files.claimed` 用这个形状。 */
export function claimedByPath(claimed: ReadonlyMap<string, readonly string[]>): OwnedTestFile[] {
  const owners = new Map<string, string[]>()
  for (const [suite, files] of claimed) for (const path of files) owners.set(path, [...(owners.get(path) ?? []), suite])
  return [...owners].map(([path, suites]) => ({ path, suites })).sort((left, right) => (left.path < right.path ? -1 : 1))
}

/**
 * 孤儿里去掉计划里登记过的路径：`register --file --kind` 登记的不执行资源（视觉快照等）本来就没有套件认领，不是孤儿。
 * 求值（evaluate-files）与计划初稿（seedPlan）共用。
 */
export function orphansNotInPlan(orphans: readonly string[], plan: Pick<TestPlan, 'files'> | undefined): readonly string[] {
  const resources = new Set((plan?.files ?? []).map((file) => normalizeRepoPath(file.path)))
  return orphans.filter((path) => !resources.has(path))
}

/** 本套件认领的改动文件（排序）。运行侧据此保留这些文件的用例，求值侧据此核对它们都执行过。 */
export function claimedFilesOfSuite(changedFiles: readonly string[], suite: CatalogSuite): readonly string[] {
  const globs = suiteFileGlobs(suite)
  return changedRepoPaths(changedFiles).filter((path) => matchesAnyGlob(path, globs))
}
