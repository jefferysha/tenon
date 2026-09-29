/**
 * 追溯矩阵（纯函数）：OpenSpec 场景 / tasks 条目 → 计划映射的用例 → 本轮最近的新鲜结果。
 * 场景要求（策略 scenarios）对「要求映射」的行出阻塞：所有场景，加上 tasks.md 里实现阶段小节的任务；
 * 其余任务（立项 / 调研 / 规格 / 验证 / 交付 / 完结小节、骨架提示词）可选，只进矩阵与报告。
 */
import { shellQuote, testBlocker, testNotice, type TestBlocker, type TestNotice } from './blockers.js'
import { caseMatchesRef, parseCaseRef } from './covers.js'
import type { SuiteRunRef } from './evaluate-suite.js'
import type { TraceRow, TraceTest } from './evaluate-types.js'
import type { OpenSpecScenario, TaskItem } from './openspec-trace.js'
import type { TestPlan } from './plan.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'

export interface TraceContext {
  readonly change: string
  readonly policy: StepTestPolicyIR
  readonly plan: TestPlan
  readonly scenarios: readonly OpenSpecScenario[]
  readonly tasks: readonly TaskItem[]
  /** 各套件最新且新鲜的运行（不限本阶段运行集）。 */
  readonly fresh: readonly SuiteRunRef[]
  readonly reviewFix: string
}

export interface TraceEvaluation {
  readonly rows: readonly TraceRow[]
  readonly blockers: readonly TestBlocker[]
  readonly notices: readonly TestNotice[]
}

function order(left: SuiteRunRef, right: SuiteRunRef): number {
  const a = left.record
  const b = right.record
  if (a.finished_at !== b.finished_at) return a.finished_at < b.finished_at ? -1 : 1
  return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0
}

function traceTest(test: string, fresh: readonly SuiteRunRef[]): TraceTest {
  const ref = parseCaseRef(test)
  if (ref === undefined) return { ref: test, status: 'not-run' }
  let found: TraceTest | undefined
  for (const entry of [...fresh].sort(order)) {
    const matches = entry.run.cases.filter((item) => caseMatchesRef(ref, item))
    if (matches.length === 0) continue
    const status = matches.some((item) => item.status === 'fail') ? 'fail'
      : matches.some((item) => item.status === 'known-fail') ? 'known-fail'
        : matches.some((item) => item.status === 'flaky') ? 'flaky'
          : matches.every((item) => item.status === 'skip') ? 'skip' : 'pass'
    found = { ref: test, status, suite: entry.run.suite, run_id: entry.record.run_id }
  }
  return found ?? { ref: test, status: 'not-run' }
}

function rowState(tests: readonly TraceTest[], waived: boolean): TraceRow['state'] {
  if (tests.length === 0) return waived ? 'waived' : 'uncovered'
  if (tests.some((test) => test.status === 'fail' || test.status === 'known-fail')) return 'failing'
  if (tests.some((test) => test.status === 'pass' || test.status === 'flaky')) return 'passing'
  return waived ? 'waived' : 'mapped'
}

export function evaluateTrace(context: TraceContext): TraceEvaluation {
  const mapping = new Map(context.plan.cases.map((item) => [item.covers, item.tests]))
  const waivers = new Map(context.plan.waivers.filter((waiver) => waiver.covers !== undefined).map((waiver) => [waiver.covers, waiver]))
  const rows: TraceRow[] = []
  const blockers: TestBlocker[] = []
  const requirement = context.policy.scenarios
  const sources = [
    ...context.scenarios.map((scenario) => ({ covers: scenario.covers, kind: 'spec' as const, title: `${scenario.capability} · ${scenario.title}`, required: true })),
    ...context.tasks.map((task) => ({ covers: task.covers, kind: 'task' as const, title: task.text, required: task.required })),
  ]
  for (const source of sources) {
    const tests = (mapping.get(source.covers) ?? []).map((test) => traceTest(test, context.fresh))
    const waiver = waivers.get(source.covers)
    const approved = waiver?.approved_by !== null && waiver?.approved_by !== undefined
    const state = rowState(tests, approved)
    rows.push({
      covers: source.covers, kind: source.kind, title: source.title, required: source.required, tests,
      ...(waiver === undefined ? {} : { waiver: { approved, reason: waiver.reason } }),
      state,
    })
    if (!source.required || requirement === 'off' || approved) continue
    const noun = source.kind === 'spec' ? '场景' : '任务'
    const register = `tenon test register ${context.change} --case ${shellQuote(source.covers)} --test ${shellQuote('<文件> › <用例名>')}`
    if (tests.length === 0) {
      if (waiver !== undefined) {
        blockers.push(testBlocker('waiver-unapproved', `${noun} ${source.title} 的豁免尚未经评审批准`, { fix: context.reviewFix, subject: source.covers }))
      } else {
        blockers.push(testBlocker('scenario-uncovered', `${noun} ${source.title} 没有映射任何用例`, { fix: register, subject: source.covers }))
      }
      continue
    }
    if (requirement === 'passing' && state !== 'passing') {
      const detail = state === 'failing' ? '映射的用例有失败' : '映射的用例本轮没有通过的结果'
      blockers.push(testBlocker('scenario-failing', `${noun} ${source.title}：${detail}`, {
        fix: `tenon test run ${context.change} --stage`, subject: source.covers,
      }))
    }
  }
  const known = new Set(sources.map((source) => source.covers))
  const notices = context.plan.cases
    .filter((item) => !known.has(item.covers))
    .map((item) => testNotice('trace-mapping-stale', `计划映射的 ${item.covers} 在当前 delta spec / tasks.md 里找不到`, {
      fix: `tenon test unregister ${context.change} --case ${shellQuote(item.covers)}`, subject: item.covers,
    }))
  return { rows, blockers, notices }
}
