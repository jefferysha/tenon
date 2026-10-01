/**
 * 测试完整性要读的 diff：哪些路径值得读，以及宿主怎么把它们读出来。
 *
 * 路径过滤由 kernel 给（目录里套件认领的文件 ∪ 看起来像测试 / 快照 / 基线 / 已知失败 / 覆盖率配置的文件），
 * 读取由宿主给（`IntegrityDiffSource`）：CLI 与 server 各用自己的版本库会话，口径同 changedFiles / protectedChanges。
 */
import type { ChangeStartInput, ChangedFilesSession } from '../workspace/changed-files.js'
import type { TestCatalog } from './catalog-types.js'
import type { IntegrityDiff } from './integrity.js'
import { integrityPathKind } from './integrity-patterns.js'
import { suitesOwningFile } from './test-files.js'

/** 一次读多少个相关文件；超出的部分不读，报告里带出截断。 */
export const INTEGRITY_FILE_LIMIT = 400

export type IntegrityPathFilter = (path: string) => boolean

/** 宿主提供：按路径过滤读出自任务起点以来的改动行（读不出抛错，判定层据此失败关闭或提示）。 */
export type IntegrityDiffSource = (accept: IntegrityPathFilter) => Promise<IntegrityDiff>

export function integrityPathFilter(catalog: TestCatalog | undefined): IntegrityPathFilter {
  return (path) => integrityPathKind(path, catalog !== undefined && suitesOwningFile(catalog, path).length > 0) !== undefined
}

/** 认领该文件的目录套件（第一个）；没有目录或没人认领返回 undefined。 */
export function integritySuiteOf(catalog: TestCatalog | undefined): (path: string) => string | undefined {
  return (path) => (catalog === undefined ? undefined : suitesOwningFile(catalog, path)[0])
}

/** 版本库会话版的 `IntegrityDiffSource`：CLI 的单次调用与 server 的项目级共享会话都走它。 */
export function integrityDiffInSession(
  session: Pick<ChangedFilesSession, 'fileDiffs'>,
  start: ChangeStartInput,
): IntegrityDiffSource {
  return (accept) => session.fileDiffs(start, accept, INTEGRITY_FILE_LIMIT)
}
