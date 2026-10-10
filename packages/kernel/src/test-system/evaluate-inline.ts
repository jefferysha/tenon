/**
 * 旧步骤测试（内联套件，id 以 `step:` 开头）并入策略判定（纯函数）。判定顺序与阻塞排序在 evaluate-v2.ts，
 * 这里只处理内联套件：状态取 v2 记录（有则优先）或 v1 判定结果，必需测试失败时再查计划里的 `test:<id>` 豁免。
 */
import { testBlocker, testNotice, type TestBlocker, type TestNotice } from './blockers.js'
import { STALE_WORDS, staleBindings, type FreshnessContext, type SuiteRunRef } from './evaluate-suite.js'
import type { SuiteVerdict, TestPolicyEvaluationInput } from './evaluate-types.js'
import type { TestPlan } from './plan.js'
import { stepTestWaiver, waiverReasonText } from './step-test-waivers.js'

export interface InlineSink {
  readonly blockers: TestBlocker[]
  readonly notices: TestNotice[]
}

/**
 * 旧步骤测试（内联套件）并入。必需测试的最新有效记录是失败、且计划里有 `test:<id>` 豁免时：已批准 = 放行（verdict
 * `waived` + 一条提示），未批准 = `waiver-unapproved`（评审请求时列给用户，转换时仍要求批准）。「已批准」要求批准绑定的
 * 代码就是这条失败所在的代码（见 step-test-waivers.ts）：换了代码的再次失败、旧版本没有候选的批准都是待批准。
 * 豁免只覆盖「新鲜的失败记录」：未运行 / 运行中 / 过期照旧阻塞，豁免不免除在当前候选上真跑一次。
 */
export function evaluateInline(
  input: TestPolicyEvaluationInput,
  plan: TestPlan | undefined,
  latest: ReadonlyMap<string, SuiteRunRef>,
  freshness: FreshnessContext,
  reviewFix: string,
  out: InlineSink,
): SuiteVerdict[] {
  const verdicts: SuiteVerdict[] = []
  for (const item of input.inline) {
    const suite = item.suite
    const base = { suite: suite.id, origin: 'step' as const, kind: suite.kind, ...(suite.label === undefined ? {} : { label: suite.label }), reason: 'inline' as const }
    const name = suite.label === undefined ? suite.testId : `${suite.label}（${suite.testId}）`
    const fix = `tenon test run ${input.change} ${suite.testId}`
    const ref = latest.get(suite.id)
    let state = item.status
    let detail = item.detail
    let failedCandidate = item.candidate
    if (ref !== undefined && state !== 'running') {
      const stale = staleBindings(ref, freshness)
      state = stale.length > 0 ? 'stale' : ref.run.result === 'pass' ? 'passed' : 'failed'
      detail = stale.length > 0 ? stale.map((binding) => STALE_WORDS[binding]).join('、') : ref.run.reasons.map((reason) => reason.code).join(', ')
      failedCandidate = ref.record.bindings.candidate
    }
    const waiver = suite.required && state === 'failed' ? stepTestWaiver(plan, suite.testId, failedCandidate, freshness) : undefined
    const verdictState = waiver === undefined ? state : waiver.approved ? 'waived' : 'waiver-pending'
    verdicts.push({
      ...base,
      state: verdictState,
      ...(detail === undefined || detail === '' ? {} : { detail }),
      ...(waiver !== undefined && typeof failedCandidate === 'string' ? { failedCandidate } : {}),
    })
    if (!suite.required || state === 'passed') continue
    const suffix = detail === undefined || detail === '' ? '' : `：${detail}`
    if (waiver !== undefined) {
      const failed = `测试 ${name} 失败${detail === undefined || detail === '' ? '' : `（${detail}）`}`
      const subject = `test:${suite.testId}`
      if (waiver.approved) {
        out.notices.push(testNotice('test-waived', `${failed}，已按评审批准的豁免放行（理由为登记者自述、未经核实）：${waiverReasonText(waiver.reason)}`, { subject }))
      } else out.blockers.push(testBlocker('waiver-unapproved', `${failed}，豁免尚未经评审批准`, { fix: reviewFix, subject }))
    } else if (state === 'running') out.blockers.push(testBlocker('test-not-run', `测试 ${name} 运行中`, { subject: suite.id }))
    else if (state === 'missing') out.blockers.push(testBlocker('test-not-run', `测试 ${name} 未运行`, { fix, subject: suite.id }))
    else if (state === 'stale') out.blockers.push(testBlocker('test-stale', `测试 ${name} 过期${suffix}`, { fix, subject: suite.id }))
    else out.blockers.push(testBlocker('test-failed', `测试 ${name} 失败${suffix}`, { fix, subject: suite.id }))
  }
  return verdicts
}
