/**
 * `tests:` 块的写回（parse-tests.ts 的反向）。键序固定
 * `id, direction, command, cwd, label, timeout_s, required, keep_runs, scope, metrics_path, pass, inputs, outputs`；
 * 缺省键不写，`inputs: []` / `outputs: []` 与缺省是两种保留状态（同 artifacts 的三态）。
 */
import type { StepTestDef, TestInputDef, TestMetricCriterion, TestOutputDef } from './types.js'
import { formatScalar } from './yaml-scalar.js'

function serializeInput(input: TestInputDef): string[] {
  const lines = [`          - kind: ${input.kind}`]
  if (input.kind === 'document') lines.push(`            ref: ${formatScalar(input.ref)}`)
  if (input.kind === 'file') lines.push(`            path: ${formatScalar(input.path)}`)
  if (input.kind === 'env' || input.kind === 'service') lines.push(`            name: ${formatScalar(input.name)}`)
  if (input.kind === 'service' && input.url !== undefined) lines.push(`            url: ${formatScalar(input.url)}`)
  return lines
}

function serializeOutput(output: TestOutputDef): string[] {
  return [
    `          - path: ${formatScalar(output.path)}`,
    ...(output.kind === undefined ? [] : [`            kind: ${output.kind}`]),
    ...(output.required === undefined ? [] : [`            required: ${output.required}`]),
  ]
}

function serializeMetric(metric: TestMetricCriterion): string[] {
  return [
    `            - name: ${formatScalar(metric.name)}`,
    ...(metric.max === undefined ? [] : [`              max: ${metric.max}`]),
    ...(metric.min === undefined ? [] : [`              min: ${metric.min}`]),
    ...(metric.max_regression_pct === undefined ? [] : [`              max_regression_pct: ${metric.max_regression_pct}`]),
    ...(metric.better === undefined ? [] : [`              better: ${metric.better}`]),
  ]
}

function serializePass(pass: NonNullable<StepTestDef['pass']>): string[] {
  const lines: string[] = ['        pass:']
  if (pass.exit_code !== undefined) lines.push(`          exit_code: ${pass.exit_code}`)
  if (pass.metrics !== undefined) {
    lines.push(pass.metrics.length === 0 ? '          metrics: []' : '          metrics:')
    lines.push(...pass.metrics.flatMap(serializeMetric))
  }
  return lines.length === 1 ? [] : lines
}

function serializeBlock<T>(name: string, items: readonly T[] | undefined, each: (item: T) => string[]): string[] {
  if (items === undefined) return []
  if (items.length === 0) return [`        ${name}: []`]
  return [`        ${name}:`, ...items.flatMap(each)]
}

function serializeTest(test: StepTestDef): string[] {
  const lines = [`      - id: ${test.id}`, `        direction: ${test.direction}`, `        command: ${formatScalar(test.command)}`]
  if (test.cwd !== undefined) lines.push(`        cwd: ${formatScalar(test.cwd)}`)
  if (test.label !== undefined) lines.push(`        label: ${formatScalar(test.label)}`)
  if (test.timeout_s !== undefined) lines.push(`        timeout_s: ${test.timeout_s}`)
  if (test.required !== undefined) lines.push(`        required: ${test.required}`)
  if (test.keep_runs !== undefined) lines.push(`        keep_runs: ${test.keep_runs}`)
  if (test.scope !== undefined) lines.push(`        scope: ${test.scope}`)
  if (test.metrics_path !== undefined) lines.push(`        metrics_path: ${formatScalar(test.metrics_path)}`)
  if (test.pass !== undefined) lines.push(...serializePass(test.pass))
  lines.push(...serializeBlock('inputs', test.inputs, serializeInput))
  lines.push(...serializeBlock('outputs', test.outputs, serializeOutput))
  return lines
}

export function serializeStepTests(tests: readonly StepTestDef[] | undefined): string[] {
  if (tests === undefined) return []
  if (tests.length === 0) return ['    tests: []']
  return ['    tests:', ...tests.flatMap(serializeTest)]
}
