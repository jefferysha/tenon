/**
 * `go test -json` 事件流 → 用例。每行一个 JSON 事件（Action: run / pass / fail / skip / output …），
 * 用例按 Package + Test 聚合；子测试 `TestA/sub` 拆成分组 TestA 与用例 sub。包级别的 fail（没有 Test）说明编译失败或
 * 整包崩溃，记成一条失败用例并带上输出，避免被当成「0 用例」。Go 不报告文件，失败输出里的 `x_test.go:12:` 是仅有的线索，
 * 没有线索就用包的导入路径当文件。
 */
import { asNumber, asString, isRecord } from './json.js'
import { cleanFailureMessage, cleanName, clip, stripAnsi } from './text.js'
import type { CaseReport, ParseContext, ParsedCase } from './types.js'

interface Entry {
  readonly pkg: string
  readonly test: string
  status: ParsedCase['status'] | 'running'
  elapsed: number
  readonly output: string[]
}

const FILE_HINT = /(\S+_test\.go):(\d+)/
const MAX_OUTPUT_LINES = 400

export function parseGoJson(text: string, _ctx: ParseContext): CaseReport {
  const entries = new Map<string, Entry>()
  const packages = new Map<string, { status: 'pass' | 'fail' | 'skip' | undefined; output: string[] }>()
  let events = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(event) || typeof event.Action !== 'string') continue
    events++
    const pkg = asString(event.Package) ?? ''
    const test = asString(event.Test)
    const action = event.Action
    if (test === undefined) {
      const current = packages.get(pkg) ?? { status: undefined, output: [] }
      if (action === 'output' && current.output.length < MAX_OUTPUT_LINES) current.output.push(asString(event.Output) ?? '')
      if (action === 'pass' || action === 'fail' || action === 'skip') current.status = action
      packages.set(pkg, current)
      continue
    }
    const key = `${pkg}\u0000${test}`
    const entry = entries.get(key) ?? { pkg, test, status: 'running' as const, elapsed: 0, output: [] }
    if (action === 'output' && entry.output.length < MAX_OUTPUT_LINES) entry.output.push(asString(event.Output) ?? '')
    if (action === 'pass') entry.status = 'pass'
    if (action === 'fail') entry.status = 'fail'
    if (action === 'skip') entry.status = 'skip'
    if (action === 'pass' || action === 'fail' || action === 'skip') entry.elapsed = asNumber(event.Elapsed) ?? 0
    entries.set(key, entry)
  }
  if (events === 0) return { ok: false, reason: '没有可识别的 go test -json 事件' }
  const cases: ParsedCase[] = []
  for (const entry of entries.values()) {
    const parts = entry.test.split('/')
    const name = parts.pop() ?? entry.test
    const status = entry.status === 'running' ? 'fail' : entry.status
    const output = stripAnsi(entry.output.join(''))
    const hint = FILE_HINT.exec(output)
    const relevant = output.split('\n').filter((row) => row.trim() !== '' && !/^\s*(?:=== |--- )/.test(row)).join('\n')
    cases.push({
      file: hint?.[1] ?? entry.pkg,
      ...(hint === null ? {} : { line: Number(hint[2]) }),
      name: cleanName(name, '(未命名用例)'),
      suite_path: parts.map((part) => cleanName(part, '(分组)')),
      project: null,
      status,
      duration_ms: Math.round(entry.elapsed * 1000),
      attempts: 1,
      ...(status === 'fail'
        ? { failure: { message: cleanFailureMessage(entry.status === 'running' ? '测试没有结束（超时或进程崩溃）' : relevant.split('\n')[0] ?? ''), ...(relevant === '' ? {} : { stack: clip(relevant) }) } }
        : {}),
      attachments: [],
    })
  }
  for (const [pkg, info] of packages) {
    const failedTests = [...entries.values()].some((entry) => entry.pkg === pkg && entry.status === 'fail')
    if (info.status !== 'fail' || failedTests) continue
    const output = stripAnsi(info.output.join('')).trim()
    cases.push({
      file: pkg === '' ? '(go)' : pkg,
      name: '(包无法构建或运行)',
      suite_path: [],
      project: null,
      status: 'fail',
      duration_ms: 0,
      attempts: 1,
      failure: { message: cleanFailureMessage(output.split('\n')[0] ?? ''), ...(output === '' ? {} : { stack: clip(output) }) },
      attachments: [],
    })
  }
  return { ok: true, cases, projects: [] }
}
