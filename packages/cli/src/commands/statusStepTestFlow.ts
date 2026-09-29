/**
 * 把 kernel 的策略判定装配成 `next` 用的 `StepTestFlow`：归档逻辑在 statusStepTests.ts（纯函数），
 * 这里只补一件需要读盘的事——验证报告是否已经带上最新运行的追溯矩阵。
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestPolicyReport } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import type { StepDocumentsView } from './statusStepParts.js'
import {
  classifyTestPolicy, freshRunIds, reportCarriesRuns, testReportCommand, type StepTestFlow,
} from './statusStepTests.js'

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

export async function buildStepTestFlow(
  deps: CliDeps,
  change: string,
  report: TestPolicyReport | undefined,
  documents: StepDocumentsView,
): Promise<StepTestFlow | undefined> {
  if (report === undefined) return undefined
  return { ...classifyTestPolicy(report), report: await pendingReport(deps, change, report, documents) }
}
