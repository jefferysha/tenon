/**
 * 测试证据判定的注入面装配。身份缺失返回 undefined——记录按用户存放，没有身份就没有可读的证据集，
 * kernel 据此失败关闭，绝不把「读不到证据」当成「证据通过」。
 *
 * 工作区指纹是可降级能力：宿主没接就不传，判定跳过候选比对，其余三条新鲜度绑定照查
 * （见 kernel TestEvidenceContext 的注释）。生产装配（main.ts / server）恒有这项能力。
 *
 * 改动文件列表（全量登记强制）是另一回事：生产装配恒提供「自任务起点以来的改动文件」，读取失败时
 * 抛错，kernel 据此阻塞（files-diff-unavailable），绝不降级成「没有改动」。
 */
import {
  changeStartOfFields, changedFilesResultForState, createChangedFilesSession, evaluateTestEvidence, integrityDiffInSession, isTenonUser,
  protectedChangesSinceChangeStart, userSlug,
  type ChangedFilesReport, type ChangedFilesSource, type IntegrityDiffSource, type ProtectedChange, type TestEvidenceContext,
  type TestEvidenceReader,
} from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { resolveChangeDir } from './paths.js'

/** 判定读取器：缺省权威读取，只有单测覆写（见 CliDeps.testEvidence）。 */
export function testEvidenceReaderFor(deps: CliDeps): TestEvidenceReader {
  return deps.testEvidence ?? evaluateTestEvidence
}

/** 自任务起点以来改动的文件，带「未跟踪文件被截断」标记；CliDeps.changedFiles 只供测试装配覆写。 */
export function changedFilesReportFor(deps: CliDeps, changeName: string): () => Promise<ChangedFilesSource> {
  return async () => {
    if (deps.changedFiles !== undefined) return deps.changedFiles(changeName)
    return changedFilesResultForState(deps.cwd, await deps.store.read(resolveChangeDir(deps.cwd, changeName)))
  }
}

/** 只要文件列表的调用方（计划登记、运行编排）用这个；截断标记只在测试策略的判定里显示。 */
export function changedFilesFor(deps: CliDeps, changeName: string): () => Promise<readonly string[]> {
  const report = changedFilesReportFor(deps, changeName)
  return async () => {
    const source = await report()
    return Array.isArray(source) ? source : (source as ChangedFilesReport).files
  }
}

/** 自任务起点以来改动的受保护测试配置（含删除）；CliDeps.protectedChanges 只供测试装配覆写。 */
export function protectedChangesFor(deps: CliDeps, changeName: string): () => Promise<readonly ProtectedChange[]> {
  return async () => {
    if (deps.protectedChanges !== undefined) return deps.protectedChanges(changeName)
    const state = await deps.store.read(resolveChangeDir(deps.cwd, changeName))
    return protectedChangesSinceChangeStart(deps.cwd, changeStartOfFields(state.fields))
  }
}

/** 自任务起点以来相关测试文件的改动行（测试完整性）；CliDeps.integrityDiff 只供测试装配覆写。 */
export function integrityDiffFor(deps: CliDeps, changeName: string): IntegrityDiffSource {
  return async (accept) => {
    if (deps.integrityDiff !== undefined) return deps.integrityDiff(changeName, accept)
    const state = await deps.store.read(resolveChangeDir(deps.cwd, changeName))
    return integrityDiffInSession(createChangedFilesSession(deps.cwd), changeStartOfFields(state.fields))(accept)
  }
}

export function testEvidenceContextFor(deps: CliDeps, changeName: string): TestEvidenceContext | undefined {
  const user = deps.user()
  if (!isTenonUser(user)) return undefined
  const fingerprint = deps.workspaceFingerprint
  return {
    user: { id: user.id, name: user.name, slug: userSlug(user.id) },
    ...(fingerprint === undefined ? {} : { currentCandidate: () => fingerprint(changeName) }),
    // 已知失败的到期判定与 `known add` 的 30 天上限读同一个时钟（生产里就是真实时间）。
    now: () => Date.parse(deps.clock()),
    changedFiles: changedFilesReportFor(deps, changeName),
    protectedChanges: protectedChangesFor(deps, changeName),
    integrityDiff: integrityDiffFor(deps, changeName),
  }
}
