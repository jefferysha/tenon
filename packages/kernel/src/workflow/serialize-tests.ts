/**
 * `tests:` 块的写回（parse-tests.ts 的反向）。键序固定
 * `id, direction, command, cwd, label, timeout_s, required, keep_runs, scope, metrics_path, pass, inputs, outputs`；
 * 缺省键不写，`inputs: []` / `outputs: []` 与缺省是两种保留状态（同 artifacts 的三态）。
 * 测试方向文件（test-evidence/direction.ts）复用 `serializeTestBody`，两处语法只有一份写法。
 */
import type { StepTestDef, TestInputDef, TestMetricCriterion, TestOutputDef } from './types.js'
import { formatScalar } from './yaml-scalar.js'

/** 方向文件没有 `direction` 键；其余字段与步骤测试项同型。 */
export type TestBodyDef = Omit<StepTestDef, 'id' | 'direction'> & { readonly direction?: string }

function serializeInput(input: TestInputDef, pad: string): string[] {
  const lines = [`${pad}- kind: ${input.kind}`]
  const sub = `${pad}  `
  if (input.kind === 'document') lines.push(`${sub}ref: ${formatScalar(input.ref)}`)
  if (input.kind === 'file') lines.push(`${sub}path: ${formatScalar(input.path)}`)
  if (input.kind === 'env' || input.kind === 'service') lines.push(`${sub}name: ${formatScalar(input.name)}`)
  if (input.kind === 'service' && input.url !== undefined) lines.push(`${sub}url: ${formatScalar(input.url)}`)
  return lines
}

function serializeOutput(output: TestOutputDef, pad: string): string[] {
  const sub = `${pad}  `
  return [
    `${pad}- path: ${formatScalar(output.path)}`,
    ...(output.kind === undefined ? [] : [`${sub}kind: ${output.kind}`]),
    ...(output.required === undefined ? [] : [`${sub}required: ${output.required}`]),
  ]
}

function serializeMetric(metric: TestMetricCriterion, pad: string): string[] {
  const sub = `${pad}  `
  return [
    `${pad}- name: ${formatScalar(metric.name)}`,
    ...(metric.max === undefined ? [] : [`${sub}max: ${metric.max}`]),
    ...(metric.min === undefined ? [] : [`${sub}min: ${metric.min}`]),
    ...(metric.max_regression_pct === undefined ? [] : [`${sub}max_regression_pct: ${metric.max_regression_pct}`]),
    ...(metric.better === undefined ? [] : [`${sub}better: ${metric.better}`]),
  ]
}

function serializePass(pass: NonNullable<StepTestDef['pass']>, pad: string): string[] {
  const sub = `${pad}  `
  const lines: string[] = [`${pad}pass:`]
  if (pass.exit_code !== undefined) lines.push(`${sub}exit_code: ${pass.exit_code}`)
  if (pass.metrics !== undefined) {
    lines.push(pass.metrics.length === 0 ? `${sub}metrics: []` : `${sub}metrics:`)
    lines.push(...pass.metrics.flatMap((metric) => serializeMetric(metric, `${sub}  `)))
  }
  return lines.length === 1 ? [] : lines
}

function serializeBlock<T>(
  name: string,
  items: readonly T[] | undefined,
  pad: string,
  each: (item: T, itemPad: string) => string[],
): string[] {
  if (items === undefined) return []
  if (items.length === 0) return [`${pad}${name}: []`]
  return [`${pad}${name}:`, ...items.flatMap((item) => each(item, `${pad}  `))]
}

/** 一个测试项除 `id` 外的全部字段行，按固定键序写出，缩进以 pad 为基准。 */
export function serializeTestBody(test: TestBodyDef, pad: string): string[] {
  const lines: string[] = []
  if (test.direction !== undefined) lines.push(`${pad}direction: ${test.direction}`)
  lines.push(`${pad}command: ${formatScalar(test.command)}`)
  if (test.cwd !== undefined) lines.push(`${pad}cwd: ${formatScalar(test.cwd)}`)
  if (test.label !== undefined) lines.push(`${pad}label: ${formatScalar(test.label)}`)
  if (test.timeout_s !== undefined) lines.push(`${pad}timeout_s: ${test.timeout_s}`)
  if (test.required !== undefined) lines.push(`${pad}required: ${test.required}`)
  if (test.keep_runs !== undefined) lines.push(`${pad}keep_runs: ${test.keep_runs}`)
  if (test.scope !== undefined) lines.push(`${pad}scope: ${test.scope}`)
  if (test.metrics_path !== undefined) lines.push(`${pad}metrics_path: ${formatScalar(test.metrics_path)}`)
  if (test.pass !== undefined) lines.push(...serializePass(test.pass, pad))
  lines.push(...serializeBlock('inputs', test.inputs, pad, serializeInput))
  lines.push(...serializeBlock('outputs', test.outputs, pad, serializeOutput))
  return lines
}

export function serializeStepTests(tests: readonly StepTestDef[] | undefined): string[] {
  if (tests === undefined) return []
  if (tests.length === 0) return ['    tests: []']
  return [
    '    tests:',
    ...tests.flatMap((test) => [`      - id: ${test.id}`, ...serializeTestBody(test, '        ')]),
  ]
}
