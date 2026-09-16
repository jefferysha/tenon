/**
 * 一次运行的结论：把进程结果、输出核对与指标判定归成 reasons[]，失败原因决定 result。
 * 沙箱拦截只是附加原因（与退出码原因并列），因为它解释的是「为什么退出码是这个」。
 */
import { testRunFailed, type TestRunReason, type TestOutputRecord, type StepTestIR } from '@tenon/kernel'
import type { TestProcessOutcome } from './process.js'

const SANDBOX_PATTERNS = [
  'Operation not permitted',
  'EPERM',
  'sandbox-exec',
  'Target page, context or browser has been closed',
] as const

export const SANDBOX_ESCALATION_HINT = '可能被宿主沙箱拦截：Codex 中用 sandbox_permissions=require_escalated 重新执行'

export interface ClassifyInput {
  readonly test: StepTestIR
  readonly outcome: TestProcessOutcome
  readonly outputs: readonly TestOutputRecord[]
  readonly metricReasons: readonly TestRunReason[]
  readonly candidateBefore: string | null
  readonly candidate: string | null
  readonly sandbox: string | null
}

export interface Classification {
  readonly reasons: readonly TestRunReason[]
  readonly result: 'pass' | 'fail'
  readonly sandboxDenied: boolean
}

function exitReasons(input: ClassifyInput): TestRunReason[] {
  const { outcome, test } = input
  if (outcome.spawnError !== undefined) {
    return [{ code: 'spawn-error', detail: outcome.spawnError.slice(0, 200) }]
  }
  if (outcome.timedOut) return [{ code: 'timeout', detail: `超过 ${test.timeout_s}s` }]
  if (outcome.interrupted) return [{ code: 'interrupted' }]
  if (outcome.exitCode === test.pass.exit_code) return []
  const actual = outcome.exitCode === null ? `signal ${outcome.signal ?? '?'}` : String(outcome.exitCode)
  const reasons: TestRunReason[] = [{ code: 'exit-code', detail: `退出码 ${actual}，期望 ${test.pass.exit_code}` }]
  if (outcome.exitCode === 127) reasons.push({ code: 'command-not-found' })
  if (outcome.exitCode === 126) reasons.push({ code: 'not-executable' })
  return reasons
}

export function classifyTestRun(input: ClassifyInput): Classification {
  const reasons: TestRunReason[] = [...exitReasons(input)]
  for (const output of input.outputs) {
    if (output.required && !output.present) {
      reasons.push({ code: 'output-missing', detail: output.path.slice(0, 200) })
    }
  }
  reasons.push(...input.metricReasons)
  if (input.candidate === null) reasons.push({ code: 'candidate-unavailable' })
  const expectedExit = input.outcome.exitCode === input.test.pass.exit_code
  const sandboxDenied = input.sandbox !== null
    && !expectedExit
    && SANDBOX_PATTERNS.some((pattern) => input.outcome.tail.includes(pattern))
  if (sandboxDenied) reasons.push({ code: 'sandbox-denied' })
  if (input.candidateBefore !== null && input.candidate !== null && input.candidateBefore !== input.candidate) {
    reasons.push({ code: 'workspace-changed' })
  }
  if (input.outcome.log.truncated) reasons.push({ code: 'log-truncated' })
  return { reasons, result: testRunFailed(reasons) ? 'fail' : 'pass', sandboxDenied }
}
