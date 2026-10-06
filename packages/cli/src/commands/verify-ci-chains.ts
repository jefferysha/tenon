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
import type { CliDeps } from '../deps.js'
import type { MessageCode } from '../i18n/messages.js'
import { ciTextOf, verifyMsg } from './verify-ci-text.js'

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

/** 记录链校验给出的断链原因是 kernel 里的中文句子；英文输出按已知的几种换成英文，其余原样。 */
const CHAIN_REASONS: Readonly<Record<string, Extract<MessageCode, `verify.${string}`>>> = {
  '找不到链首记录': 'verify.chainReason.noGenesis',
  '有记录文件无法读取或格式非法': 'verify.chainReason.unreadable',
  '记录内容与摘要不符（被改动）': 'verify.chainReason.digest',
  '记录链出现分叉': 'verify.chainReason.fork',
  '记录链成环': 'verify.chainReason.cycle',
  '有记录不在当前链上（中间记录缺失或被替换）': 'verify.chainReason.stray',
}

function chainReasonText(deps: CliDeps, reason: string): string {
  const code = CHAIN_REASONS[reason]
  return code === undefined ? reason : verifyMsg(deps, code)
}

/** 判定用的用户目录：负责人的链；负责人没有链而恰好只有一条别人的链时用那一条（并给警告）；否则没有。 */
export function pickEvaluatedChain(
  deps: CliDeps,
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
      : { chain: only, finding: { ...base, message: verifyMsg(deps, 'verify.ownerChainMissingOne', { owner: ownerSlug, user: only.slug }) } }
  }
  if (chains.length > 1) {
    return {
      chain: undefined,
      finding: {
        ...base,
        message: ownerSlug === null
          ? verifyMsg(deps, 'verify.ownerUnknownChainMany', { count: chains.length })
          : verifyMsg(deps, 'verify.ownerChainMissingMany', { owner: ownerSlug, count: chains.length }),
      },
    }
  }
  return { chain: undefined }
}

/** 链断了、记录自洽性：判定用的链的断链由策略判定自己报，这里不重复。 */
export function chainFindings(deps: CliDeps, change: string, chain: UserChain, evaluated: boolean): readonly CiFinding[] {
  const out: CiFinding[] = []
  const { report, listing } = chain
  if (report.state === 'broken' && !evaluated) {
    const file = report.files[0]
    out.push({
      code: 'record-chain-broken', severity: 'error', change, source: 'ci', subject: chain.slug,
      message: verifyMsg(deps, 'verify.chainBroken', {
        user: chain.slug, reason: chainReasonText(deps, report.reason), files: report.files.slice(0, 3).join(verifyMsg(deps, 'verify.listSep')),
      }),
      ...(file === undefined ? {} : { path: `${chain.relDir}/${file}` }),
    })
  }
  const active = report.state === 'intact' ? new Set(report.active.map((record) => record.digest)) : undefined
  const records = active === undefined ? listing.records : listing.records.filter((entry) => active.has(entry.record.digest))
  for (const problem of recordInvariantProblems({ change, slug: chain.slug, records, text: ciTextOf(deps) })) {
    out.push({
      code: problem.code, severity: 'error', change, source: 'ci', subject: problem.file,
      message: verifyMsg(deps, 'verify.recordProblem', { file: problem.file, message: problem.message }), path: `${chain.relDir}/${problem.file}`,
    })
  }
  return out
}
