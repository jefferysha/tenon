/**
 * Playwright JSON 报告 → 用例。结构：suites（文件层）→ 嵌套 suites（describe）→ specs → tests（每个 project 一条）→
 * results（每次尝试一条）。用例状态取 test.status：expected 通过、unexpected 失败、flaky 重试后通过、skipped 跳过；
 * `attempts` 直接读 results 的条数，所以原生重试的次数不需要重跑就知道。附件（截图、trace、视频）来自所有尝试。
 * 文件路径相对该 project 的 testDir，这里换算成仓库相对路径。
 */
import { posix } from 'node:path'
import type { CaseFailure } from '@tenon/kernel'
import { asArray, asNumber, asString, isRecord, parseJson, type JsonRecord } from './json.js'
import { cleanFailureMessage, cleanName, clip, repoPath, stripAnsi } from './text.js'
import type { CaseReport, ParseContext, ParsedAttachment, ParsedCase } from './types.js'

interface Walk {
  readonly ctx: ParseContext
  readonly testDirs: ReadonlyMap<string, string>
  readonly rootDir: string
  readonly cases: ParsedCase[]
}

function testDirsOf(config: unknown): { rootDir: string; dirs: Map<string, string> } {
  const dirs = new Map<string, string>()
  const record = isRecord(config) ? config : {}
  for (const project of asArray(record.projects)) {
    if (!isRecord(project)) continue
    const name = asString(project.name)
    const testDir = asString(project.testDir)
    if (name !== undefined && testDir !== undefined) dirs.set(name, testDir)
  }
  return { rootDir: asString(record.rootDir) ?? '', dirs }
}

function failureOf(result: JsonRecord): CaseFailure | undefined {
  const errors = asArray(result.errors).filter(isRecord)
  const error = isRecord(result.error) ? result.error : errors[0]
  if (error === undefined) return undefined
  const message = asString(error.message) ?? asString(error.stack) ?? ''
  const stack = asString(error.stack)
  return {
    message: cleanFailureMessage(message),
    ...(stack !== undefined && stripAnsi(stack).trim() !== '' ? { stack: clip(stripAnsi(stack)) } : {}),
  }
}

function attachmentsOf(results: readonly JsonRecord[]): ParsedAttachment[] {
  const seen = new Set<string>()
  const out: ParsedAttachment[] = []
  for (const result of results) {
    for (const item of asArray(result.attachments)) {
      if (!isRecord(item)) continue
      const path = asString(item.path)
      if (path === undefined || path === '' || seen.has(path)) continue
      seen.add(path)
      const contentType = asString(item.contentType)
      out.push({ name: asString(item.name) ?? posix.basename(path), ...(contentType === undefined ? {} : { contentType }), path })
    }
  }
  return out
}

function statusOf(test: JsonRecord, results: readonly JsonRecord[]): ParsedCase['status'] {
  switch (asString(test.status)) {
    case 'expected': return 'pass'
    case 'flaky': return 'flaky'
    case 'skipped': return 'skip'
    case 'unexpected': return 'fail'
    default: {
      const last = asString(results.at(-1)?.status)
      return last === 'passed' ? 'pass' : last === 'skipped' ? 'skip' : 'fail'
    }
  }
}

function caseFromTest(spec: JsonRecord, test: JsonRecord, groups: readonly string[], file: string, walk: Walk): ParsedCase {
  const results = asArray(test.results).filter(isRecord)
  const project = asString(test.projectName) ?? null
  const status = statusOf(test, results)
  const testDir = (project === null ? undefined : walk.testDirs.get(project)) ?? walk.rootDir
  const specFile = asString(spec.file) ?? file
  const failed = [...results].reverse().find((result) => asString(result.status) !== 'passed' && asString(result.status) !== 'skipped')
  const duration = results.at(-1) === undefined ? 0 : (asNumber(results.at(-1)?.duration) ?? 0)
  const failure = status === 'fail' || status === 'flaky' ? (failed === undefined ? undefined : failureOf(failed)) : undefined
  const line = asNumber(spec.line)
  return {
    file: testDir === '' ? repoPath(walk.ctx, specFile) : repoPath(walk.ctx, specFile, testDir),
    ...(line === undefined ? {} : { line }),
    name: cleanName(asString(spec.title) ?? '', '(未命名用例)'),
    suite_path: groups.map((group) => cleanName(group, '(分组)')),
    project,
    status,
    duration_ms: Math.round(duration),
    attempts: Math.max(1, results.length),
    ...(failure === undefined ? {} : { failure }),
    attachments: attachmentsOf(results),
  }
}

function visit(suite: JsonRecord, groups: readonly string[], file: string, walk: Walk): void {
  for (const spec of asArray(suite.specs).filter(isRecord)) {
    for (const test of asArray(spec.tests).filter(isRecord)) walk.cases.push(caseFromTest(spec, test, groups, file, walk))
  }
  for (const child of asArray(suite.suites).filter(isRecord)) {
    visit(child, [...groups, asString(child.title) ?? ''], file, walk)
  }
}

export function parsePlaywrightJson(text: string, ctx: ParseContext): CaseReport {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  const root = parsed.value
  if (!isRecord(root) || !Array.isArray(root.suites)) return { ok: false, reason: '缺少 suites：不是 Playwright JSON 报告' }
  const { rootDir, dirs } = testDirsOf(root.config)
  const walk: Walk = { ctx, testDirs: dirs, rootDir, cases: [] }
  for (const fileSuite of root.suites.filter(isRecord)) {
    const file = asString(fileSuite.file) ?? asString(fileSuite.title) ?? ''
    visit(fileSuite, [], file, walk)
  }
  for (const error of asArray(root.errors).filter(isRecord)) {
    const message = asString(error.message) ?? ''
    if (/No tests found/i.test(message)) continue
    walk.cases.push({
      file: '(playwright)',
      name: 'Playwright 运行出错',
      suite_path: [],
      project: null,
      status: 'fail',
      duration_ms: 0,
      attempts: 1,
      failure: { message: cleanFailureMessage(message) },
      attachments: [],
    })
  }
  const projects = [...new Set(walk.cases.flatMap((item) => (item.project === null ? [] : [item.project])))]
  return { ok: true, cases: walk.cases, projects }
}
