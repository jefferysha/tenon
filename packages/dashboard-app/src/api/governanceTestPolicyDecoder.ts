/** 步骤 `test_policy` 的严格解码：闭集键、闭集取值；任何不认识的形状都拒绝整份定义，不静默丢弃。 */
import { COVERAGE_METRICS, POLICY_SCOPES, isTestKind } from '@tenon/kernel/test-system/vocabulary'
import type { WbCoverageMetric, WbStepTestPolicy } from './governanceTypes'
import { allowedKeys, exactKeys, record } from './governanceBaseDecoders'

const POLICY_KEYS = [
  'plan', 'kinds', 'run', 'run_if_registered', 'scope', 'files', 'scenarios', 'integrity', 'coverage', 'flaky', 'benchmark', 'browsers',
] as const
const PLANS = ['required', 'optional'] as const
const INTEGRITY = ['notice', 'block'] as const
const FILES = ['registered', 'any'] as const
const SCENARIOS = ['off', 'required', 'passing'] as const

function choice<T extends string>(value: unknown, values: readonly T[]): T | null {
  return values.find((item) => item === value) ?? null
}

function kindList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (!isTestKind(item) || out.includes(item)) return null
    out.push(item)
  }
  return out
}

function nameList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || out.includes(item)) return null
    out.push(item)
  }
  return out
}

function coverage(value: unknown): Partial<Record<WbCoverageMetric, number>> | null {
  const item = record(value)
  if (item === null || !allowedKeys(item, COVERAGE_METRICS)) return null
  const out: Partial<Record<WbCoverageMetric, number>> = {}
  for (const metric of COVERAGE_METRICS) {
    const raw = item[metric]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) return null
    out[metric] = raw
  }
  return Object.keys(out).length === 0 ? null : out
}

function flaky(value: unknown): NonNullable<WbStepTestPolicy['flaky']> | null {
  const item = record(value)
  if (item === null || !allowedKeys(item, ['max', 'fail_on_new'])) return null
  if (typeof item.max !== 'number' || !Number.isInteger(item.max) || item.max < 0 || item.max > 1000) return null
  if (item.fail_on_new !== undefined && typeof item.fail_on_new !== 'boolean') return null
  return { max: item.max, ...(item.fail_on_new === undefined ? {} : { fail_on_new: item.fail_on_new }) }
}

export function decodeStepTestPolicy(value: unknown): WbStepTestPolicy | null {
  const item = record(value)
  if (item === null || !allowedKeys(item, POLICY_KEYS)) return null
  const out: WbStepTestPolicy = {}
  if (item.plan !== undefined) {
    const plan = choice(item.plan, PLANS)
    if (plan === null) return null
    out.plan = plan
  }
  for (const key of ['kinds', 'run', 'run_if_registered'] as const) {
    if (item[key] === undefined) continue
    const list = kindList(item[key])
    if (list === null) return null
    out[key] = list
  }
  if (item.scope !== undefined) {
    const scope = choice(item.scope, POLICY_SCOPES)
    if (scope === null) return null
    out.scope = scope
  }
  if (item.files !== undefined) {
    const files = choice(item.files, FILES)
    if (files === null) return null
    out.files = files
  }
  if (item.scenarios !== undefined) {
    const scenarios = choice(item.scenarios, SCENARIOS)
    if (scenarios === null) return null
    out.scenarios = scenarios
  }
  if (item.integrity !== undefined) {
    const integrity = choice(item.integrity, INTEGRITY)
    if (integrity === null) return null
    out.integrity = integrity
  }
  if (item.coverage !== undefined) {
    const decoded = coverage(item.coverage)
    if (decoded === null) return null
    out.coverage = decoded
  }
  if (item.flaky !== undefined) {
    const decoded = flaky(item.flaky)
    if (decoded === null) return null
    out.flaky = decoded
  }
  if (item.benchmark !== undefined) {
    const bench = record(item.benchmark)
    if (bench === null || !exactKeys(bench, ['require_baseline']) || typeof bench.require_baseline !== 'boolean') return null
    out.benchmark = { require_baseline: bench.require_baseline }
  }
  if (item.browsers !== undefined) {
    const list = nameList(item.browsers)
    if (list === null) return null
    out.browsers = list
  }
  return out
}
