/**
 * 套件运行结果的判定：进程与报告层面的结构性原因由执行方先填进 `reasons`，这里把它们连同用例失败（对照已知失败）、
 * 已登记用例未执行、覆盖率、基准、浏览器 project 一起交给 kernel 的 evaluateSuiteResult——运行时的结论与之后门禁
 * 重新计算的结论是同一份代码，不会出现「运行说通过、门禁说失败」的两套口径。
 */
import {
  SUITE_REASON_CODES, baselineKey, evaluateSuiteResult,
  type CatalogSuite, type SuiteReason, type SuiteReasonCode, type SuiteRunV2, type TestBaselineV2, type TestBlocker, type TestNotice,
} from '@tenon/kernel'
import type { TestProcessOutcome } from '../test-runner/process.js'
import type { ExecContext } from './exec-types.js'

const CODES: ReadonlySet<string> = new Set<string>(SUITE_REASON_CODES)

function reasonOf(blocker: TestBlocker): SuiteReason | undefined {
  if (!CODES.has(blocker.code)) return undefined
  return { code: blocker.code as SuiteReasonCode, detail: blocker.message.slice(0, 1900) }
}

function dedupe(reasons: readonly SuiteReason[]): SuiteReason[] {
  const seen = new Set<string>()
  return reasons.filter((reason) => (seen.has(reason.code) ? false : (seen.add(reason.code), true)))
}

export async function judgeSuite(
  suite: CatalogSuite,
  run: SuiteRunV2,
  context: ExecContext,
): Promise<{ readonly run: SuiteRunV2; readonly notices: readonly TestNotice[] }> {
  const baselines = new Map<string, TestBaselineV2>()
  const baseline = suite.benchmark === undefined ? undefined : await context.baseline(suite.id)
  if (baseline !== undefined) baselines.set(baselineKey(suite.id, context.evalRecord.machine_profile), baseline)
  const evaluation = evaluateSuiteResult(suite, { record: context.evalRecord, run }, {
    change: context.change, policy: context.policy, plan: context.plan,
    knownFailures: context.knownFailures, baselines, today: context.today,
  })
  const extra = evaluation.blockers.flatMap((blocker) => {
    const reason = reasonOf(blocker)
    return reason === undefined ? [] : [reason]
  })
  return {
    run: {
      ...run,
      reasons: dedupe([...run.reasons, ...extra]),
      result: evaluation.blockers.some((blocker) => blocker.blocking) ? 'fail' : 'pass',
    },
    notices: evaluation.notices,
  }
}

/** 进程层面的原因（超时、被中断、启动失败、找不到命令）；退出码本身的解释由各套件类型决定。 */
export function processReasons(outcome: TestProcessOutcome, timeoutSeconds: number): SuiteReason[] {
  if (outcome.spawnError !== undefined) return [{ code: 'spawn-error', detail: outcome.spawnError.slice(0, 200) }]
  if (outcome.timedOut) return [{ code: 'timeout', detail: `超过 ${timeoutSeconds}s` }]
  if (outcome.interrupted) return [{ code: 'interrupted' }]
  const reasons: SuiteReason[] = []
  if (outcome.exitCode === 127) reasons.push({ code: 'command-not-found' })
  if (outcome.exitCode === 126) reasons.push({ code: 'not-executable' })
  return reasons
}

export function exitText(outcome: TestProcessOutcome): string {
  return outcome.exitCode === null ? `signal ${outcome.signal ?? '?'}` : String(outcome.exitCode)
}
