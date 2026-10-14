/**
 * 测试文件与套件的归属：路径归一，以及某个路径被哪些目录套件的 `files` glob 认领。
 * 改动文件列表由宿主给出（相对 change 起点、仓库相对、正斜杠），本模块不碰 git；
 * 认领与孤儿的判定在 claim.ts。
 */
import { suiteFileGlobs } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'
import { matchesAnyGlob } from './globs.js'

/** 一个改动过的测试文件，及认领它的目录套件。 */
export interface OwnedTestFile {
  readonly path: string
  readonly suites: readonly string[]
}

/**
 * 旧报告 `files.unregistered` 的元素。认领取代逐个登记之后求值不再产生未登记的文件，该字段恒为空；
 * 保留类型是为了不破坏读取旧报告形状的调用方（server DTO、Dashboard）。
 */
export type UnregisteredTestFile = OwnedTestFile

export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function suitesOwningFile(catalog: TestCatalog, path: string): readonly string[] {
  return catalog.suites.filter((suite) => matchesAnyGlob(path, suiteFileGlobs(suite))).map((suite) => suite.id)
}
