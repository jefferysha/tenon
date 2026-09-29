/**
 * 测试策略表单的纯编辑函数：每次编辑都在入参的拷贝上改一个键，其余键（plan / files / run_if_registered /
 * browsers / coverage 的 functions 与 statements / flaky.fail_on_new）原样保留；值变空就删键，输出始终稀疏。
 */
import type { WbCoverageMetric, WbStepTestPolicy } from '../api/governanceTypes'

export type FormCoverageMetric = Extract<WbCoverageMetric, 'lines' | 'branches' | 'changed_lines'>
export const FORM_COVERAGE_METRICS: readonly FormCoverageMetric[] = ['lines', 'branches', 'changed_lines']

/** 新建策略：只写出口要求计划存在这一项，其余键缺省。 */
export function newPolicy(): WbStepTestPolicy {
  return { plan: 'required' }
}

export function withKinds(policy: WbStepTestPolicy, key: 'kinds' | 'run', kinds: readonly string[]): WbStepTestPolicy {
  const { [key]: _old, ...rest } = policy
  return kinds.length === 0 ? rest : { ...rest, [key]: [...kinds] }
}

export function withScope(policy: WbStepTestPolicy, scope: NonNullable<WbStepTestPolicy['scope']>): WbStepTestPolicy {
  return { ...policy, scope }
}

export function withScenarios(policy: WbStepTestPolicy, scenarios: NonNullable<WbStepTestPolicy['scenarios']>): WbStepTestPolicy {
  return { ...policy, scenarios }
}

/** 单项覆盖率门槛；undefined 删掉这一项，全空时整个 coverage 键删掉（服务端要求至少一项）。 */
export function withCoverage(policy: WbStepTestPolicy, metric: FormCoverageMetric, value: number | undefined): WbStepTestPolicy {
  const { coverage, ...rest } = policy
  const next = { ...coverage }
  if (value === undefined) delete next[metric]
  else next[metric] = value
  return Object.keys(next).length === 0 ? rest : { ...rest, coverage: next }
}

/** flaky 上限；undefined 删掉整个 flaky，保留时 fail_on_new 原样带着。 */
export function withFlakyMax(policy: WbStepTestPolicy, max: number | undefined): WbStepTestPolicy {
  const { flaky, ...rest } = policy
  if (max === undefined) return rest
  return { ...rest, flaky: { ...flaky, max } }
}

export function withRequireBaseline(policy: WbStepTestPolicy, on: boolean): WbStepTestPolicy {
  const { benchmark: _old, ...rest } = policy
  return on ? { ...rest, benchmark: { require_baseline: true } } : rest
}

export type Parsed = { readonly kind: 'empty' } | { readonly kind: 'value'; readonly value: number } | { readonly kind: 'invalid' }

/** 百分比输入：空 = 清除；0–100 的数（可带小数）= 值；其余 = 无效（不上报）。 */
export function parsePercent(text: string): Parsed {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed)) return { kind: 'invalid' }
  const value = Number(trimmed)
  return value >= 0 && value <= 100 ? { kind: 'value', value } : { kind: 'invalid' }
}

/** flaky 上限输入：空 = 清除；0–1000 的整数 = 值；其余无效。 */
export function parseLimit(text: string): Parsed {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (!/^\d+$/u.test(trimmed)) return { kind: 'invalid' }
  const value = Number(trimmed)
  return value <= 1000 ? { kind: 'value', value } : { kind: 'invalid' }
}
