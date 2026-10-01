/**
 * `tenon verify --ci` 的记录链部分：枚举一个任务在每个用户目录下的记录链，逐条校验结构与自洽，
 * 并选出「判定用哪条链」。CI 没有当前用户，选择只看任务的负责人。
 */
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  TENON_PROJECT_DIR, listRecordDirectory, recordInvariantProblems, testRunRecordsDir, verifyRecordChain,
  type ChainReport, type CiChainSummary, type CiFinding, type RecordDirectoryListing,
} from '@tenon/kernel'

export interface UserChain {
  /** 用户目录名。 */
  readonly slug: string
  /** 记录目录（仓库相对路径，正斜杠）。 */
  readonly relDir: string
  readonly listing: RecordDirectoryListing
  readonly report: ChainReport
}

/** 没有任何记录链时判定用的占位用户目录名（合法的 slug，目录不存在 = 空链）。 */
export const NO_USER_SLUG = 'none-at-none'

async function userSlugs(cwd: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(cwd, TENON_PROJECT_DIR, 'users'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export async function readUserChains(cwd: string, change: string): Promise<readonly UserChain[]> {
  const out: UserChain[] = []
  for (const slug of await userSlugs(cwd)) {
    let dir: string
    try {
      dir = testRunRecordsDir(cwd, slug, change)
    } catch {
      continue
    }
    const listing = await listRecordDirectory(dir)
    if (listing.records.length === 0 && listing.problems.length === 0) continue
    out.push({ slug, relDir: relative(cwd, dir).split(sep).join('/'), listing, report: verifyRecordChain(listing) })
  }
  return out
}

export function chainSummary(chain: UserChain): CiChainSummary {
  const { report } = chain
  return {
    user: chain.slug,
    state: report.state,
    head: report.state === 'intact' ? report.head : null,
    records: report.state === 'intact' ? report.active.length : chain.listing.records.length,
  }
}

/** 判定用的用户目录：负责人的链；负责人没有链而恰好只有一条别人的链时用那一条（并给警告）；否则没有。 */
export function pickEvaluatedChain(
  change: string,
  ownerSlug: string | null,
  chains: readonly UserChain[],
): { readonly chain: UserChain | undefined; readonly finding?: CiFinding } {
  const owned = ownerSlug === null ? undefined : chains.find((chain) => chain.slug === ownerSlug)
  if (owned !== undefined) return { chain: owned }
  const base = { code: 'owner-chain-missing', severity: 'warning' as const, change, source: 'ci' as const }
  if (chains.length === 1 && chains[0] !== undefined) {
    const only = chains[0]
    return ownerSlug === null
      ? { chain: only }
      : { chain: only, finding: { ...base, message: `任务负责人 ${ownerSlug} 没有测试记录；判定用的是 ${only.slug} 的记录链` } }
  }
  if (chains.length > 1) {
    return { chain: undefined, finding: { ...base, message: `任务负责人${ownerSlug === null ? '未知' : ` ${ownerSlug} 没有测试记录`}，而有 ${chains.length} 个用户各有一条记录链，无法决定用哪条判定` } }
  }
  return { chain: undefined }
}

/** 链断了、记录自洽性：判定用的链的断链由策略判定自己报，这里不重复。 */
export function chainFindings(change: string, chain: UserChain, evaluated: boolean): readonly CiFinding[] {
  const out: CiFinding[] = []
  const { report, listing } = chain
  if (report.state === 'broken' && !evaluated) {
    const file = report.files[0]
    out.push({
      code: 'record-chain-broken', severity: 'error', change, source: 'ci', subject: chain.slug,
      message: `用户 ${chain.slug} 的测试记录被改动（${report.reason}：${report.files.slice(0, 3).join('、')}）`,
      ...(file === undefined ? {} : { path: `${chain.relDir}/${file}` }),
    })
  }
  const active = report.state === 'intact' ? new Set(report.active.map((record) => record.digest)) : undefined
  const records = active === undefined ? listing.records : listing.records.filter((entry) => active.has(entry.record.digest))
  for (const problem of recordInvariantProblems({ change, slug: chain.slug, records })) {
    out.push({
      code: problem.code, severity: 'error', change, source: 'ci', subject: problem.file,
      message: `${problem.file}：${problem.message}`, path: `${chain.relDir}/${problem.file}`,
    })
  }
  return out
}
