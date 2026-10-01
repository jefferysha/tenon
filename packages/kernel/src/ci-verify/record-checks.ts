/**
 * 已提交的运行记录的自洽检查（纯函数）。链校验（record-chain.ts）管结构与摘要，记录解码器管字段形状与用例总数；
 * 这里管摘要重算之后仍然必须成立的事：记录住对了位置、记录自己的结论与它的明细不矛盾。
 * `tenon test run` 写出的记录恒满足这些，所以违反的记录是手改过的——即使改的人重算了每一条摘要。
 */
import { userSlug } from '../users/user.js'
import type { RecordFileEntry } from '../test-system/record-chain.js'
import type { CaseStatus, SuiteRunV2 } from '../test-system/record-v2-types.js'

export interface RecordProblem {
  readonly code: 'record-misplaced' | 'record-inconsistent'
  readonly file: string
  readonly message: string
}

const STATUS_TOTAL: Readonly<Record<CaseStatus, keyof SuiteRunV2['totals']>> = {
  pass: 'pass', fail: 'fail', skip: 'skip', flaky: 'flaky', 'known-fail': 'known_fail',
}

function suiteProblems(file: string, suite: SuiteRunV2): readonly RecordProblem[] {
  const out: RecordProblem[] = []
  const { totals } = suite
  // 用例总数 = 各状态之和由记录解码器保证；留存的用例不能比统计的还多。
  const kept = new Map<CaseStatus, number>()
  for (const item of suite.cases) kept.set(item.status, (kept.get(item.status) ?? 0) + 1)
  for (const [status, count] of kept) {
    const total = totals[STATUS_TOTAL[status]]
    if (count > total) {
      out.push({ code: 'record-inconsistent', file, message: `套件 ${suite.suite} 留存了 ${count} 个 ${status} 用例，超过统计的 ${total} 个` })
    }
  }
  return out
}

export function recordInvariantProblems(input: {
  readonly change: string
  /** 记录所在的用户目录名。 */
  readonly slug: string
  readonly records: readonly RecordFileEntry[]
}): readonly RecordProblem[] {
  const out: RecordProblem[] = []
  for (const { file, record } of input.records) {
    if (record.change !== input.change) {
      out.push({ code: 'record-misplaced', file, message: `记录属于任务 ${record.change}，却放在任务 ${input.change} 的目录里` })
    }
    if (userSlug(record.actor.id) !== input.slug) {
      out.push({ code: 'record-misplaced', file, message: `记录的执行人 ${record.actor.id} 与所在的用户目录 ${input.slug} 不符` })
    }
    const expected = record.suites.every((suite) => suite.result === 'pass') ? 'pass' : 'fail'
    if (record.result !== expected) {
      out.push({ code: 'record-inconsistent', file, message: `记录结论 ${record.result} 与各套件结论（应为 ${expected}）矛盾` })
    }
    for (const suite of record.suites) out.push(...suiteProblems(file, suite))
  }
  return out
}
