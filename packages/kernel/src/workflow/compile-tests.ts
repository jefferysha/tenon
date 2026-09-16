/**
 * 步骤测试项的编译（定义层 → IR）：闭集键、字符集、范围与路径校验，补齐默认值，键序固定。
 * 结构化输入（server 的 decodeWorkflowDef 直调）与 YAML 走同一条校验链。
 * 只在非空时产出 `tests`，所以未声明测试的工作流编译成与本特性之前逐字相同的 IR。
 */
import { TEST_OUTPUT_DIR_SEGMENTS } from '../workspace/fingerprint.js'
import { DOCUMENT_KINDS } from './document-contract-model.js'
import type { StepTestIR } from './ir.js'
import type { TestInputDef, TestMetricCriterion, TestOutputDef, TestOutputKind } from './types.js'

const TEST_KEYS: ReadonlySet<string> = new Set([
  'id', 'direction', 'command', 'cwd', 'label', 'timeout_s', 'required', 'keep_runs', 'scope',
  'metrics_path', 'pass', 'inputs', 'outputs',
])
const PASS_KEYS: ReadonlySet<string> = new Set(['exit_code', 'metrics'])
const METRIC_KEYS: ReadonlySet<string> = new Set(['name', 'max', 'min', 'max_regression_pct', 'better'])
const INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  document: new Set(['kind', 'ref']),
  file: new Set(['kind', 'path']),
  env: new Set(['kind', 'name']),
  service: new Set(['kind', 'name', 'url']),
}
const OUTPUT_KEYS: ReadonlySet<string> = new Set(['path', 'kind', 'required'])
const OUTPUT_KINDS: ReadonlySet<string> = new Set<TestOutputKind>([
  'report', 'coverage', 'metrics', 'trace', 'screenshot', 'log', 'other',
])
const IDENT_RE = /^[a-zA-Z0-9_-]+$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SERVICE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/
const METRIC_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/
const KINDS: ReadonlySet<string> = new Set<string>(DOCUMENT_KINDS)

function compileError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    compileError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) compileError(path, `必须是数组（实际 ${JSON.stringify(value)}）`)
  return value
}

function rejectExtraKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      compileError(path, `出现该变体不接受的附加键 '${key}'（闭集：${[...allowed].join('/')}）`)
    }
  }
}

function identifier(value: unknown, path: string, what: string): string {
  if (typeof value !== 'string' || !IDENT_RE.test(value) || value.length > 64) {
    compileError(path, `测试 ${what} '${String(value)}' 含非法字符（仅允许 a-zA-Z0-9_-）`)
  }
  return value
}

function integerInRange(value: unknown, path: string, id: string, field: string, lo: number, hi: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    compileError(path, `测试 '${id}' 的 ${field} 超出范围 ${lo}–${hi}`)
  }
  return value
}

/** 仓库内相对路径：非绝对、无 `..`、无反斜杠、无空段；`.` 表示仓库根。 */
function repoRelative(value: unknown, path: string, id: string): string {
  if (typeof value !== 'string' || value === '') compileError(path, `测试 '${id}' 的路径 '${String(value)}' 必须是仓库内相对路径`)
  const segments = value.split('/')
  const bad = value.startsWith('/')
    || value.includes('\\')
    || segments.some((segment, index) => segment === '..' || (segment === '' ) || (segment === '.' && (index > 0 || segments.length > 1)))
  if (bad) compileError(path, `测试 '${id}' 的路径 '${value}' 必须是仓库内相对路径`)
  return value
}

/** 声明式输出只能落在工作区指纹排除的测试目录下，否则产出报告会让候选版本失效。 */
function testOutputPath(value: unknown, path: string, id: string): string {
  const relative = repoRelative(value, path, id)
  if (!relative.split('/').some((segment) => (TEST_OUTPUT_DIR_SEGMENTS as readonly string[]).includes(segment))) {
    compileError(path, `测试 '${id}' 的输出 '${relative}' 必须位于 ${TEST_OUTPUT_DIR_SEGMENTS.join('/、')}/ 目录下`)
  }
  return relative
}

function compileInput(raw: unknown, path: string, id: string): TestInputDef {
  const record = asRecord(raw, path)
  const kind = record.kind
  const allowed = typeof kind === 'string' && Object.hasOwn(INPUT_KEYS, kind) ? INPUT_KEYS[kind] : undefined
  if (typeof kind !== 'string' || allowed === undefined) {
    compileError(path, `测试 '${id}' 的输入类型 '${String(kind)}' 不在闭集（document/file/env/service）`)
  }
  rejectExtraKeys(record, allowed, path)
  if (kind === 'document') {
    const ref = record.ref
    if (typeof ref !== 'string' || !KINDS.has(ref)) compileError(path, `测试 '${id}' 的输入文档类型 '${String(ref)}' 不存在`)
    return { kind, ref }
  }
  if (kind === 'file') return { kind, path: repoRelative(record.path, `${path}.path`, id) }
  if (kind === 'env') {
    const name = record.name
    if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) compileError(path, `测试 '${id}' 的输入 '${String(name)}' 非法`)
    return { kind, name }
  }
  const name = record.name
  if (typeof name !== 'string' || name === '' || name.length > 128) {
    compileError(path, `测试 '${id}' 的输入 '${String(name)}' 非法`)
  }
  if (record.url === undefined) return { kind: 'service', name }
  const url = record.url
  if (typeof url !== 'string' || !SERVICE_URL_RE.test(url)) compileError(path, `测试 '${id}' 的输入 '${String(url)}' 非法`)
  return { kind: 'service', name, url }
}

function compileOutput(
  raw: unknown,
  path: string,
  id: string,
): TestOutputDef & { readonly kind: TestOutputKind; readonly required: boolean } {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, OUTPUT_KEYS, path)
  const outputPath = testOutputPath(record.path, `${path}.path`, id)
  const kind = record.kind ?? 'other'
  if (typeof kind !== 'string' || !OUTPUT_KINDS.has(kind)) {
    compileError(`${path}.kind`, `测试 '${id}' 的输出类型 '${String(kind)}' 不在闭集（${[...OUTPUT_KINDS].join('/')}）`)
  }
  const required = record.required ?? false
  if (typeof required !== 'boolean') compileError(`${path}.required`, `测试 '${id}' 的输出 required 必须是布尔`)
  return { path: outputPath, kind: kind as TestOutputKind, required }
}

function compileMetric(
  raw: unknown,
  path: string,
  id: string,
): TestMetricCriterion & { readonly better: 'lower' | 'higher' } {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, METRIC_KEYS, path)
  const name = record.name
  if (typeof name !== 'string' || !METRIC_NAME_RE.test(name)) {
    compileError(`${path}.name`, `测试 '${id}' 的指标名 '${String(name)}' 含非法字符`)
  }
  for (const key of ['max', 'min'] as const) {
    const value = record[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      compileError(`${path}.${key}`, `测试 '${id}' 的指标 '${name}' 的 ${key} 必须是有限数字`)
    }
  }
  if (record.max_regression_pct !== undefined) {
    integerInRange(record.max_regression_pct, `${path}.max_regression_pct`, id, `指标 '${name}' 的 max_regression_pct`, 0, 1000)
  }
  if (record.max === undefined && record.min === undefined && record.max_regression_pct === undefined) {
    compileError(path, `测试 '${id}' 的指标 '${name}' 至少需要 max、min 或 max_regression_pct`)
  }
  const better = record.better ?? 'lower'
  if (better !== 'lower' && better !== 'higher') {
    compileError(`${path}.better`, `测试 '${id}' 的指标 '${name}' 的 better 只支持 lower | higher`)
  }
  return {
    name,
    ...(record.max === undefined ? {} : { max: record.max as number }),
    ...(record.min === undefined ? {} : { min: record.min as number }),
    ...(record.max_regression_pct === undefined ? {} : { max_regression_pct: record.max_regression_pct as number }),
    better,
  }
}

function compilePass(raw: unknown, path: string, id: string): StepTestIR['pass'] {
  if (raw === undefined) return { exit_code: 0, metrics: [] }
  const record = asRecord(raw, path)
  rejectExtraKeys(record, PASS_KEYS, path)
  const exitCode = record.exit_code === undefined
    ? 0
    : integerInRange(record.exit_code, `${path}.exit_code`, id, 'exit_code', 0, 255)
  const metrics = record.metrics === undefined
    ? []
    : asArray(record.metrics, `${path}.metrics`).map((metric, index) => compileMetric(metric, `${path}.metrics[${index}]`, id))
  return { exit_code: exitCode, metrics }
}

function compileTest(raw: unknown, path: string): StepTestIR {
  const record = asRecord(raw, path)
  rejectExtraKeys(record, TEST_KEYS, path)
  const id = identifier(record.id, `${path}.id`, 'id')
  const direction = identifier(record.direction, `${path}.direction`, 'direction')
  const command = record.command
  const bytes = typeof command === 'string' ? Buffer.byteLength(command, 'utf8') : 0
  if (typeof command !== 'string' || bytes === 0 || bytes > 2000 || /[\0\r\n]/.test(command)) {
    compileError(`${path}.command`, `测试 '${id}' 的 command 必须是 1–2000 字节的单行命令`)
  }
  const cwd = record.cwd === undefined ? '.' : repoRelative(record.cwd, `${path}.cwd`, id)
  if (record.label !== undefined
    && (typeof record.label !== 'string' || record.label === '' || record.label.length > 80 || /[\r\n]/.test(record.label))) {
    compileError(`${path}.label`, `测试 '${id}' 的 label 必须是 1–80 字符的单行文本`)
  }
  const timeout = record.timeout_s === undefined
    ? 900
    : integerInRange(record.timeout_s, `${path}.timeout_s`, id, 'timeout_s', 1, 14400)
  const required = record.required ?? true
  if (typeof required !== 'boolean') compileError(`${path}.required`, `测试 '${id}' 的 required 必须是布尔`)
  const keepRuns = record.keep_runs === undefined
    ? 5
    : integerInRange(record.keep_runs, `${path}.keep_runs`, id, 'keep_runs', 1, 50)
  if (record.scope !== undefined && record.scope !== 'full' && record.scope !== 'known') {
    compileError(`${path}.scope`, `测试 '${id}' 的 scope 只支持 full | known`)
  }
  const metricsPath = record.metrics_path === undefined
    ? undefined
    : testOutputPath(record.metrics_path, `${path}.metrics_path`, id)
  const inputs = record.inputs === undefined
    ? []
    : asArray(record.inputs, `${path}.inputs`).map((input, index) => compileInput(input, `${path}.inputs[${index}]`, id))
  if (inputs.length > 32) compileError(`${path}.inputs`, `测试 '${id}' 的输入超出范围 0–32`)
  const outputs = record.outputs === undefined
    ? []
    : asArray(record.outputs, `${path}.outputs`).map((output, index) => compileOutput(output, `${path}.outputs[${index}]`, id))
  if (outputs.length > 32) compileError(`${path}.outputs`, `测试 '${id}' 的输出超出范围 0–32`)
  return {
    id,
    direction,
    command,
    cwd,
    ...(record.label === undefined ? {} : { label: record.label as string }),
    timeout_s: timeout,
    required,
    keep_runs: keepRuns,
    ...(record.scope === undefined ? {} : { scope: record.scope as 'full' | 'known' }),
    ...(metricsPath === undefined ? {} : { metrics_path: metricsPath }),
    pass: compilePass(record.pass, `${path}.pass`, id),
    inputs,
    outputs,
  }
}

export function compileStepTests(raw: unknown, path: string): readonly StepTestIR[] | undefined {
  if (raw === undefined) return undefined
  const tests = asArray(raw, path).map((test, index) => compileTest(test, `${path}[${index}]`))
  const seen = new Set<string>()
  for (const test of tests) {
    if (seen.has(test.id)) compileError(path, `测试 id '${test.id}' 在步骤内重复`)
    seen.add(test.id)
  }
  return tests.length === 0 ? undefined : tests
}
