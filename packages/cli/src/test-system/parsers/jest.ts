/**
 * Jest / Vitest 的 JSON 报告（Vitest 的 json reporter 沿用 Jest 的形状）→ 用例。
 * testResults[] 是文件层：name 是绝对路径，assertionResults[] 是用例（ancestorTitles 是分组链，title 是用例名，
 * status 为 passed / failed / pending / skipped / todo / disabled）。Jest 的 `invocations` 记录同一用例被执行的次数
 * （retryTimes 重试时大于 1）：失败后重试通过 → flaky。文件整体失败却没有失败用例（导入报错、语法错）时补一条失败用例，
 * 否则这种失败会被误判成「0 用例」。
 */
import { UNKNOWN_CASE_FILE, type CaseFailure } from '@tenon/kernel'
import { asArray, asNumber, asString, isRecord, parseJson, type JsonRecord } from './json.js'
import { cleanFailureMessage, cleanName, clip, failureFromText, repoPath, stripAnsi } from './text.js'
import type { CaseReport, ParseContext, ParsedCase } from './types.js'

function statusOf(raw: string | undefined, invocations: number): ParsedCase['status'] {
  if (raw === 'passed') return invocations > 1 ? 'flaky' : 'pass'
  if (raw === 'failed') return 'fail'
  return 'skip'
}

function show(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text === undefined ? undefined : clip(text, 4000)
}

/** failureMessages 给消息与堆栈；failureDetails[0].matcherResult 给期望 / 实际值。 */
function failureOf(assertion: JsonRecord, messages: readonly string[]): CaseFailure {
  const base = failureFromText(clip(messages.join('\n\n')))
  const detail = asArray(assertion.failureDetails).find(isRecord)
  const matcher = detail !== undefined && isRecord(detail.matcherResult) ? detail.matcherResult : undefined
  const expected = matcher === undefined ? undefined : show(matcher.expected)
  const actual = matcher === undefined ? undefined : show(matcher.actual)
  return { ...base, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) }
}

export function parseJestJson(text: string, ctx: ParseContext): CaseReport {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  const root = parsed.value
  if (!isRecord(root) || !Array.isArray(root.testResults)) return { ok: false, reason: '缺少 testResults：不是 Jest / Vitest JSON 报告' }
  const cases: ParsedCase[] = []
  for (const fileResult of root.testResults.filter(isRecord)) {
    const fileName = asString(fileResult.name)
    const file = fileName === undefined ? UNKNOWN_CASE_FILE : repoPath(ctx, fileName)
    let failedInFile = false
    for (const assertion of asArray(fileResult.assertionResults).filter(isRecord)) {
      const invocations = Math.max(1, asNumber(assertion.invocations) ?? 1)
      const status = statusOf(asString(assertion.status), invocations)
      if (status === 'fail') failedInFile = true
      const messages = asArray(assertion.failureMessages).filter((item): item is string => typeof item === 'string')
      const location = isRecord(assertion.location) ? asNumber(assertion.location.line) : undefined
      cases.push({
        file,
        ...(location === undefined ? {} : { line: location }),
        name: cleanName(asString(assertion.title) ?? '', '(未命名用例)'),
        suite_path: asArray(assertion.ancestorTitles).filter((item): item is string => typeof item === 'string')
          .map((title) => cleanName(title, '(分组)')),
        project: null,
        status,
        duration_ms: Math.round(asNumber(assertion.duration) ?? 0),
        attempts: status === 'skip' ? 1 : invocations,
        ...(status === 'fail' ? { failure: failureOf(assertion, messages) } : {}),
        attachments: [],
      })
    }
    const message = asString(fileResult.message) ?? ''
    if (asString(fileResult.status) === 'failed' && !failedInFile) {
      cases.push({
        file,
        name: '(测试文件无法运行)',
        suite_path: [],
        project: null,
        status: 'fail',
        duration_ms: 0,
        attempts: 1,
        failure: { message: cleanFailureMessage(message === '' ? '测试文件整体失败，报告没有给出原因' : stripAnsi(message)) },
        attachments: [],
      })
    }
  }
  return { ok: true, cases, projects: [] }
}
