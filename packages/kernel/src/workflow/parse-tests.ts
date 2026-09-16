/**
 * `tests:` 块的窄解析（modelled on parse-skill-refs.ts）。值域与范围校验留给 compileStepTests，
 * 这里只做语法层：闭集键、必填子键、数字/布尔字面量、单行标量解码。未知字段行 fail-loud。
 */
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf } from './parse-primitives.js'
import { parseScalar } from './yaml-scalar.js'
import type {
  StepTestDef, StepTestPassDef, TestInputDef, TestMetricCriterion, TestOutputDef, TestOutputKind,
} from './types.js'

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/
const OUTPUT_KINDS: readonly string[] = ['report', 'coverage', 'metrics', 'trace', 'screenshot', 'log', 'other']

function fail(message: string): never {
  throw new Error(`workflow 解析错误：${message}`)
}

function number(raw: string, what: string): number {
  const value = raw.trim()
  if (!NUMBER_RE.test(value)) fail(`${what} 必须是数字（实际 '${value}'）`)
  return Number(value)
}

function integer(raw: string, what: string): number {
  const value = number(raw, what)
  if (!Number.isInteger(value)) fail(`${what} 必须是整数（实际 '${raw.trim()}'）`)
  return value
}

function boolean(raw: string, what: string): boolean {
  const value = raw.trim()
  if (value !== 'true' && value !== 'false') fail(`${what} 必须是 true 或 false（实际 '${value}'）`)
  return value === 'true'
}

/** 逐项读一个 `- <leadKey>: <value>` 序列；子字段由 each 消费，返回 false 表示未知字段行。 */
function parseItems<T>(
  cur: Cursor,
  baseIndent: number,
  leadKey: string,
  build: (lead: string, cur: Cursor, itemIndent: number) => T,
): T[] {
  const items: T[] = []
  const lead = new RegExp(`^\\s*-\\s+${leadKey}:\\s*(.+?)\\s*$`)
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) < baseIndent) break
    const match = lead.exec(line)
    if (!match) break
    const itemIndent = indentOf(line)
    cur.i++
    items.push(build(parseScalar(match[1] ?? ''), cur, itemIndent))
  }
  return items
}

function parseInput(kind: string, cur: Cursor, itemIndent: number): TestInputDef {
  let ref: string | undefined
  let path: string | undefined
  let name: string | undefined
  let url: string | undefined
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= itemIndent) break
    let m: RegExpExecArray | null
    if ((m = /^\s*ref:\s*(.+?)\s*$/.exec(line))) ref = parseScalar(m[1] ?? '')
    else if ((m = /^\s*path:\s*(.+?)\s*$/.exec(line))) path = parseScalar(m[1] ?? '')
    else if ((m = /^\s*name:\s*(.+?)\s*$/.exec(line))) name = parseScalar(m[1] ?? '')
    else if ((m = /^\s*url:\s*(.+?)\s*$/.exec(line))) url = parseScalar(m[1] ?? '')
    else fail(`测试输入 '${kind}' 出现未知字段行 '${line.trim()}'`)
    cur.i++
  }
  if (kind === 'document') {
    if (ref === undefined) fail("测试输入 'document' 缺 ref")
    return { kind, ref }
  }
  if (kind === 'file') {
    if (path === undefined) fail("测试输入 'file' 缺 path")
    return { kind, path }
  }
  if (kind === 'env') {
    if (name === undefined) fail("测试输入 'env' 缺 name")
    return { kind, name }
  }
  if (kind === 'service') {
    if (name === undefined) fail("测试输入 'service' 缺 name")
    return url === undefined ? { kind, name } : { kind, name, url }
  }
  return fail(`未知测试输入类型 '${kind}'（闭集：document/file/env/service）`)
}

function parseOutput(path: string, cur: Cursor, itemIndent: number): TestOutputDef {
  let kind: TestOutputKind | undefined
  let required: boolean | undefined
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= itemIndent) break
    let m: RegExpExecArray | null
    if ((m = /^\s*kind:\s*(\S+)\s*$/.exec(line))) {
      if (!OUTPUT_KINDS.includes(m[1] ?? '')) fail(`测试输出 '${path}' 的 kind '${m[1]}' 不在闭集（${OUTPUT_KINDS.join('/')}）`)
      kind = m[1] as TestOutputKind
    } else if ((m = /^\s*required:\s*(\S+)\s*$/.exec(line))) required = boolean(m[1] ?? '', `测试输出 '${path}' 的 required`)
    else fail(`测试输出 '${path}' 出现未知字段行 '${line.trim()}'`)
    cur.i++
  }
  return { path, ...(kind === undefined ? {} : { kind }), ...(required === undefined ? {} : { required }) }
}

function parseMetric(name: string, cur: Cursor, itemIndent: number): TestMetricCriterion {
  let max: number | undefined
  let min: number | undefined
  let maxRegressionPct: number | undefined
  let better: 'lower' | 'higher' | undefined
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= itemIndent) break
    let m: RegExpExecArray | null
    if ((m = /^\s*max:\s*(\S+)\s*$/.exec(line))) max = number(m[1] ?? '', `指标 '${name}' 的 max`)
    else if ((m = /^\s*min:\s*(\S+)\s*$/.exec(line))) min = number(m[1] ?? '', `指标 '${name}' 的 min`)
    else if ((m = /^\s*max_regression_pct:\s*(\S+)\s*$/.exec(line))) {
      maxRegressionPct = number(m[1] ?? '', `指标 '${name}' 的 max_regression_pct`)
    } else if ((m = /^\s*better:\s*(lower|higher)\s*$/.exec(line))) better = m[1] as 'lower' | 'higher'
    else fail(`指标 '${name}' 出现未知字段行 '${line.trim()}'`)
    cur.i++
  }
  return {
    name,
    ...(max === undefined ? {} : { max }),
    ...(min === undefined ? {} : { min }),
    ...(maxRegressionPct === undefined ? {} : { max_regression_pct: maxRegressionPct }),
    ...(better === undefined ? {} : { better }),
  }
}

function parsePass(cur: Cursor, keyIndent: number, id: string): StepTestPassDef {
  let exitCode: number | undefined
  let metrics: TestMetricCriterion[] | undefined
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const exit = /^\s*exit_code:\s*(\S+)\s*$/.exec(line)
    if (exit) { exitCode = integer(exit[1] ?? '', `测试 '${id}' 的 exit_code`); cur.i++; continue }
    if (/^\s*metrics:\s*\[\]\s*$/.test(line)) { metrics = []; cur.i++; continue }
    if (/^\s*metrics:\s*$/.test(line)) {
      const metricsIndent = indentOf(line)
      cur.i++
      metrics = parseItems(cur, metricsIndent, 'name', parseMetric)
      continue
    }
    fail(`测试 '${id}' 的 pass 出现未知字段行 '${line.trim()}'`)
  }
  if (exitCode === undefined && metrics === undefined) fail(`测试 '${id}' 的 pass 至少需要 exit_code 或 metrics`)
  return {
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    ...(metrics === undefined ? {} : { metrics }),
  }
}

/** 一个测试项除 `id` 外的全部字段；itemIndent 是项首行缩进，-1 表示字段从缩进 0 开始（方向文件）。 */
export function parseTestBody(id: string, cur: Cursor, itemIndent: number): StepTestDef {
  const seen = new Set<string>()
  const once = (key: string): void => {
    if (seen.has(key)) fail(`测试 '${id}' 重复声明 ${key}`)
    seen.add(key)
  }
  const fields: Record<string, unknown> = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= itemIndent) break
    const scalar = /^\s*(direction|command|cwd|label|metrics_path|scope):\s*(.+?)\s*$/.exec(line)
    if (scalar) {
      const key = scalar[1] ?? ''
      once(key)
      fields[key] = parseScalar(scalar[2] ?? '')
      cur.i++
      continue
    }
    const numeric = /^\s*(timeout_s|keep_runs):\s*(\S+)\s*$/.exec(line)
    if (numeric) {
      const key = numeric[1] ?? ''
      once(key)
      fields[key] = integer(numeric[2] ?? '', `测试 '${id}' 的 ${key}`)
      cur.i++
      continue
    }
    const flag = /^\s*required:\s*(\S+)\s*$/.exec(line)
    if (flag) { once('required'); fields.required = boolean(flag[1] ?? '', `测试 '${id}' 的 required`); cur.i++; continue }
    if (/^\s*pass:\s*$/.test(line)) { once('pass'); const pi = indentOf(line); cur.i++; fields.pass = parsePass(cur, pi, id); continue }
    if (/^\s*inputs:\s*\[\]\s*$/.test(line)) { once('inputs'); fields.inputs = []; cur.i++; continue }
    if (/^\s*inputs:\s*$/.test(line)) {
      once('inputs')
      const blockIndent = indentOf(line)
      cur.i++
      fields.inputs = parseItems(cur, blockIndent, 'kind', parseInput)
      continue
    }
    if (/^\s*outputs:\s*\[\]\s*$/.test(line)) { once('outputs'); fields.outputs = []; cur.i++; continue }
    if (/^\s*outputs:\s*$/.test(line)) {
      once('outputs')
      const blockIndent = indentOf(line)
      cur.i++
      fields.outputs = parseItems(cur, blockIndent, 'path', parseOutput)
      continue
    }
    fail(`测试 '${id}' 出现未知字段行 '${line.trim()}'`)
  }
  if (fields.direction === undefined) fail(`测试 '${id}' 缺 direction`)
  if (fields.command === undefined) fail(`测试 '${id}' 缺 command`)
  return { id, ...fields } as StepTestDef
}

export function parseStepTests(cur: Cursor, baseIndent: number): StepTestDef[] {
  return parseItems(cur, baseIndent, 'id', parseTestBody)
}
