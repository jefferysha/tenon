/**
 * 把 kernel 的策略判定装配成 `next` 用的 `StepTestFlow`：归档逻辑在 statusStepTests.ts（纯函数），
 * 这里只补两件需要读盘的事——验证报告是否已经带上最新运行的追溯矩阵，以及评审请求冻结的豁免清单是否过时。
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  pendingReviewWaivers, readReviewWaiverSelection, reportCarriesRuns, stepTestFailuresOf,
  type StepTestFailures, type TestEvidenceReport, type TestPolicyReport,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import type { StepDocumentsView } from './statusStepParts.js'
import { classifyTestPolicy, freshRunIds, testReportCommand, type StepTestFlow } from './statusStepTests.js'

/** 追溯矩阵写进的文档 kind（文档契约里的验证报告）。 */
const REPORT_DOCUMENT_KIND = 'verification-report'
const MAX_REPORT_BYTES = 2 * 1024 * 1024

async function readReport(deps: CliDeps, path: string): Promise<string | undefined> {
  try {
    const absolute = join(deps.cwd, path)
    const entry = await lstat(absolute)
    if (!entry.isFile() || entry.size > MAX_REPORT_BYTES) return undefined
    return await readFile(absolute, 'utf8')
  } catch {
    return undefined
  }
}

async function pendingReport(
  deps: CliDeps,
  change: string,
  report: TestPolicyReport,
  documents: StepDocumentsView,
): Promise<StepTestFlow['report']> {
  const runs = freshRunIds(report)
  if (runs.length === 0) return null
  const doc = documents.records.find((candidate) => candidate.kind === REPORT_DOCUMENT_KIND)
  if (doc === undefined || doc.path === null) return null
  const text = await readReport(deps, doc.path)
  if (text === undefined || reportCarriesRuns(text, runs)) return null
  return { path: doc.path, command: testReportCommand(change, doc.path) }
}

/**
 * 评审请求发出时冻结的豁免清单（review request 写的边车）是否漏了计划里现在待批准的豁免。
 * 只在评审待确认时才问；清单不属于这一次请求（requestedAt 不同）也算漏了。步骤测试豁免的批准绑定代码：
 * 冻结时记下的候选对不上现在这条失败（请求之后代码又变了），同样算过时，要重新发起评审。
 */
async function requestListIsStale(
  repoRoot: string,
  dir: string,
  change: string,
  requestedAt: string,
  failures: StepTestFailures,
): Promise<boolean> {
  const pending = await pendingReviewWaivers({ repoRoot, dir, change, failures })
  if (pending.length === 0) return false
  const frozen = await readReviewWaiverSelection(dir)
  if (frozen === undefined || frozen.requestedAt !== requestedAt) return true
  return pending.some((waiver) => !frozen.waivers.some((item) =>
    item.key === waiver.key && item.reason === waiver.reason && item.candidate === waiver.candidate))
}

export async function buildStepTestFlow(
  deps: CliDeps,
  change: string,
  dir: string,
  evidence: Pick<TestEvidenceReport, 'policy' | 'items'>,
  documents: StepDocumentsView,
  /** 评审待确认时这次请求的时间；其余情况 null。 */
  pendingRequestedAt: string | null,
): Promise<StepTestFlow | undefined> {
  const report = evidence.policy
  if (report === undefined) return undefined
  const classified = classifyTestPolicy(report)
  return {
    ...classified,
    report: await pendingReport(deps, change, report, documents),
    refreshRequest: pendingRequestedAt !== null && classified.waivers.length > 0
      && await requestListIsStale(deps.cwd, dir, change, pendingRequestedAt, stepTestFailuresOf(evidence.items)),
  }
}
