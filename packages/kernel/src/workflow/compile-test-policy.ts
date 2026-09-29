/**
 * 步骤测试策略的编译（定义层 → IR）：闭集键、种类闭集、组合约束与默认值。结构化输入（server 的
 * decodeWorkflowDef 直调）与 YAML 走同一条校验链；只在声明时产出 `test_policy`。
 */
import {
  BROWSER_PROJECT_RE, COVERAGE_METRICS, TEST_KINDS, isTestKind, type CoverageMetric, type TestKind,
} from '../test-system/vocabulary.js'
import type { StepTestPolicyIR } from './ir.js'

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'plan', 'kinds', 'run', 'run_if_registered', 'scope', 'files', 'scenarios', 'coverage', 'flaky', 'benchmark', 'browsers',
])

function compileError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}

function rejectExtraKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) compileError(path, `出现不接受的键 '${key}'（闭集：${[...allowed].join('/')}）`)
  }
}

function choice<T extends string>(value: unknown, path: string, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    compileError(path, `只支持 ${values.join(' | ')}（实际 ${JSON.stringify(value)}）`)
  }
  return value as T
}

function kinds(value: unknown, path: string): TestKind[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) compileError(path, `必须是种类列表（实际 ${JSON.stringify(value)}）`)
  const out: TestKind[] = []
  for (const item of value) {
    if (!isTestKind(item)) compileError(path, `测试种类 '${String(item)}' 不在闭集（${TEST_KINDS.join('/')}）`)
    if (out.includes(item)) compileError(path, `测试种类 '${item}' 重复`)
    out.push(item)
  }
  return out
}

function coverage(value: unknown, path: string): StepTestPolicyIR['coverage'] {
  if (value === undefined) return undefined
  const record = asRecord(value, path)
  rejectExtraKeys(record, new Set(COVERAGE_METRICS), path)
  const out: Partial<Record<CoverageMetric, number>> = {}
  for (const metric of COVERAGE_METRICS) {
    const raw = record[metric]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      compileError(`${path}.${metric}`, `覆盖率门槛必须是 0–100 的数字（实际 ${JSON.stringify(raw)}）`)
    }
    out[metric] = raw
  }
  if (Object.keys(out).length === 0) compileError(path, `至少声明 ${COVERAGE_METRICS.join('/')} 之一`)
  return out
}

function flaky(value: unknown, path: string): StepTestPolicyIR['flaky'] {
  if (value === undefined) return undefined
  const record = asRecord(value, path)
  rejectExtraKeys(record, new Set(['max', 'fail_on_new']), path)
  const max = record.max
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 1000) {
    compileError(`${path}.max`, `必须是 0–1000 的整数（实际 ${JSON.stringify(max)}）`)
  }
  const failOnNew = record.fail_on_new ?? false
  if (typeof failOnNew !== 'boolean') compileError(`${path}.fail_on_new`, '必须是布尔')
  return { max, fail_on_new: failOnNew }
}

function benchmark(value: unknown, path: string): StepTestPolicyIR['benchmark'] {
  if (value === undefined) return { require_baseline: false }
  const record = asRecord(value, path)
  rejectExtraKeys(record, new Set(['require_baseline']), path)
  if (typeof record.require_baseline !== 'boolean') compileError(`${path}.require_baseline`, '必须是布尔')
  return { require_baseline: record.require_baseline }
}

function browsers(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) compileError(path, '必须是 Playwright project 名列表')
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !BROWSER_PROJECT_RE.test(item)) compileError(path, `Playwright project 名 '${String(item)}' 非法`)
    if (out.includes(item)) compileError(path, `Playwright project '${item}' 重复`)
    out.push(item)
  }
  return out
}

export function compileStepTestPolicy(raw: unknown, path: string): StepTestPolicyIR | undefined {
  if (raw === undefined) return undefined
  const record = asRecord(raw, path)
  rejectExtraKeys(record, POLICY_KEYS, path)
  const plan = choice(record.plan, `${path}.plan`, ['required', 'optional'] as const, 'required')
  const required = kinds(record.kinds, `${path}.kinds`)
  const run = kinds(record.run, `${path}.run`)
  const optional = kinds(record.run_if_registered, `${path}.run_if_registered`)
  const overlap = optional.find((kind) => run.includes(kind))
  if (overlap !== undefined) compileError(`${path}.run_if_registered`, `种类 '${overlap}' 已在 run 中必跑，不能同时是「有则跑」`)
  const scenarios = choice(record.scenarios, `${path}.scenarios`, ['off', 'required', 'passing'] as const, 'off')
  if (plan === 'optional' && (required.length > 0 || run.length > 0 || scenarios !== 'off')) {
    compileError(`${path}.plan`, 'kinds / run / scenarios 都依赖测试计划，不能与 plan: optional 同用')
  }
  const coverageIr = coverage(record.coverage, `${path}.coverage`)
  const flakyIr = flaky(record.flaky, `${path}.flaky`)
  return {
    plan,
    kinds: required,
    run,
    run_if_registered: optional,
    scope: choice(record.scope, `${path}.scope`, ['changed', 'full'] as const, 'full'),
    files: choice(record.files, `${path}.files`, ['registered', 'any'] as const, 'any'),
    scenarios,
    ...(coverageIr === undefined ? {} : { coverage: coverageIr }),
    ...(flakyIr === undefined ? {} : { flaky: flakyIr }),
    benchmark: benchmark(record.benchmark, `${path}.benchmark`),
    browsers: browsers(record.browsers, `${path}.browsers`),
  }
}
