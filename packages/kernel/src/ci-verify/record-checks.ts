/**
 * 已提交的运行记录的自洽检查（纯函数）。链校验（record-chain.ts）管结构与摘要，记录解码器管字段形状与用例总数；
 * 这里管摘要重算之后仍然必须成立的事：记录住对了位置、记录自己的结论与它的明细不矛盾。
 * `tenon test run` 写出的记录恒满足这些，所以违反的记录是手改过的——即使改的人重算了每一条摘要。
 */
import { userSlug } from '../users/user.js'
import type { RecordFileEntry } from '../test-system/record-chain.js'
import type { CaseStatus, SuiteRunV2 } from '../test-system/record-v2-types.js'
import type { CiText } from './text.js'

export interface RecordProblem {
  readonly code: 'record-misplaced' | 'record-inconsistent'
  readonly file: string
  readonly message: string
}

const STATUS_TOTAL: Readonly<Record<CaseStatus, keyof SuiteRunV2['totals']>> = {
  pass: 'pass', fail: 'fail', skip: 'skip', flaky: 'flaky', 'known-fail': 'known_fail',
}

function suiteProblems(file: string, suite: SuiteRunV2, text: CiText): readonly RecordProblem[] {
  const out: RecordProblem[] = []
  const { totals } = suite
  // 用例总数 = 各状态之和由记录解码器保证；留存的用例不能比统计的还多。
  const kept = new Map<CaseStatus, number>()
  for (const item of suite.cases) kept.set(item.status, (kept.get(item.status) ?? 0) + 1)
  for (const [status, count] of kept) {
    const total = totals[STATUS_TOTAL[status]]
    if (count > total) {
      out.push({ code: 'record-inconsistent', file, message: text('record.keptTooMany', { suite: suite.suite, count, status, total }) })
    }
  }
  return out
}

export function recordInvariantProblems(input: {
  readonly change: string
  /** 记录所在的用户目录名。 */
  readonly slug: string
  readonly records: readonly RecordFileEntry[]
  /** 问题文案的文本源（语言由调用方定）。 */
  readonly text: CiText
}): readonly RecordProblem[] {
  const { text } = input
  const out: RecordProblem[] = []
  for (const { file, record } of input.records) {
    if (record.change !== input.change) {
      out.push({ code: 'record-misplaced', file, message: text('record.wrongChange', { recordChange: record.change, change: input.change }) })
    }
    if (userSlug(record.actor.id) !== input.slug) {
      out.push({ code: 'record-misplaced', file, message: text('record.wrongActor', { actor: record.actor.id, slug: input.slug }) })
    }
    const expected = record.suites.every((suite) => suite.result === 'pass') ? 'pass' : 'fail'
    if (record.result !== expected) {
      out.push({ code: 'record-inconsistent', file, message: text('record.resultMismatch', { result: record.result, expected }) })
    }
    for (const suite of record.suites) out.push(...suiteProblems(file, suite, text))
  }
  return out
}
