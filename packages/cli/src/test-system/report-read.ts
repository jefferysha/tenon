/**
 * 读取并解析套件的报告 / 覆盖率文件。运行前先删掉上一次留下的文件，所以「文件存在」就等于「这次命令产出的」。
 * 文件大小有界（报告 64 MiB）；读不到、超限、解析失败都变成结构化的原因，不抛异常。
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CatalogSuite, CoverageResult } from '@tenon/kernel'
import {
  parseBenchmarkReport, parseCaseReport, parseCoverageReport,
  type BenchmarkReport, type BenchmarkReportFormat, type CaseReport, type CaseReportFormat, type CoverageContext,
} from './parsers/index.js'

const MAX_REPORT_BYTES = 64 * 1024 * 1024

export type ReportRead =
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'ok'; readonly text: string; readonly digest: string }

async function readBounded(path: string): Promise<ReportRead> {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', reason: '无法读取报告文件' }
  }
  if (!entry.isFile()) return { state: 'unreadable', reason: '报告路径不是普通文件' }
  if (entry.size > MAX_REPORT_BYTES) return { state: 'unreadable', reason: `报告超过 ${MAX_REPORT_BYTES / 1024 / 1024} MiB` }
  const bytes = await readFile(path)
  return { state: 'ok', text: bytes.toString('utf8'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

/** 运行前清理上一次的报告 / 覆盖率，并保证报告所在目录存在（命令若把输出重定向到文件，目录必须先在）。 */
export async function prepareOutputs(suite: CatalogSuite, cwd: string): Promise<void> {
  for (const path of [suite.report.path, suite.coverage?.path]) {
    if (path === undefined) continue
    await rm(resolve(cwd, path), { force: true })
    await mkdir(dirname(resolve(cwd, path)), { recursive: true })
  }
}

export async function readReportFile(suite: CatalogSuite, cwd: string): Promise<ReportRead> {
  return suite.report.path === undefined ? { state: 'missing' } : readBounded(resolve(cwd, suite.report.path))
}

export async function readCoverageFiles(suite: CatalogSuite, cwd: string): Promise<{ readonly summary: ReportRead; readonly detail?: string }> {
  if (suite.coverage === undefined) return { summary: { state: 'missing' } }
  const summary = await readBounded(resolve(cwd, suite.coverage.path))
  if (suite.coverage.format !== 'istanbul-summary') return { summary }
  const detail = await readBounded(resolve(dirname(resolve(cwd, suite.coverage.path)), 'coverage-final.json'))
  return { summary, ...(detail.state === 'ok' ? { detail: detail.text } : {}) }
}

export function parseCases(suite: CatalogSuite, text: string, repoRoot: string, cwd: string): CaseReport {
  return parseCaseReport(suite.report.format as CaseReportFormat, text, { repoRoot, cwd })
}

export function parseBenchmark(suite: CatalogSuite, text: string): BenchmarkReport {
  return parseBenchmarkReport(suite.report.format as BenchmarkReportFormat, text)
}

export function parseCoverage(
  suite: CatalogSuite, text: string, context: CoverageContext,
): { readonly ok: true; readonly coverage: CoverageResult } | { readonly ok: false; readonly reason: string } {
  return suite.coverage === undefined ? { ok: false, reason: '套件没有声明覆盖率' } : parseCoverageReport(suite.coverage.format, text, context)
}
