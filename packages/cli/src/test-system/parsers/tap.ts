/**
 * TAP → 用例，覆盖 node:test 的嵌套输出（`# Subtest:` 缩进块、YAML 诊断块里的 location / error / expected / actual）
 * 与扁平 TAP（`ok 1 - 描述`）。没有子块的结果行是用例，带子块的是分组。
 * TAP 本身不带文件信息：失败用例的 `location` 给出文件，同一顶层分组里其余用例沿用它；仍然没有就记为 (unknown)，
 * 这样「已登记文件未出现在报告里」的核对会如实报出，而不是靠猜测放行。
 */
import { cleanFailureMessage, cleanName, clip, repoPath, stripAnsi } from './text.js'
import type { CaseReport, ParseContext, ParsedCase } from './types.js'

interface Diagnostics {
  duration?: number
  type?: string
  location?: string
  error?: string
  expected?: string
  actual?: string
  stack?: string
}

interface TapNode {
  name: string
  status: 'pass' | 'fail' | 'skip'
  children: TapNode[]
  diag: Diagnostics
}

interface Frame {
  readonly indent: number
  readonly name: string
  readonly children: TapNode[]
}

const RESULT = /^(\s*)(not ok|ok)\b(?:\s+\d+)?\s*(?:-\s*)?(.*)$/
const SUBTEST = /^(\s*)# Subtest:\s*(.*)$/
const DIRECTIVE = /\s+#\s*(skip|to-?do)\b.*$/i
const LOCATION = /^(.*?):(\d+)(?::\d+)?$/

function readYaml(lines: readonly string[], start: number, indent: number): { diag: Diagnostics; next: number } {
  const diag: Diagnostics = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^\s*\.\.\.\s*$/.test(line)) return { diag, next: index + 1 }
    const entry = /^(\s*)([A-Za-z_]+):\s?(.*)$/.exec(line)
    if (entry === null || (entry[1] ?? '').length !== indent) { index++; continue }
    const key = entry[2] ?? ''
    let value = (entry[3] ?? '').trim()
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = []
      index++
      while (index < lines.length && (lines[index] ?? '').startsWith(`${' '.repeat(indent + 2)}`) && !/^\s*\.\.\.\s*$/.test(lines[index] ?? '')) {
        block.push((lines[index] ?? '').slice(indent + 2))
        index++
      }
      value = block.join('\n')
    } else {
      index++
      value = value.replace(/^'(.*)'$/, '$1')
    }
    if (key === 'duration_ms') diag.duration = Number(value)
    else if (key === 'type') diag.type = value
    else if (key === 'location') diag.location = value
    else if (key === 'error') diag.error = value
    else if (key === 'expected') diag.expected = value
    else if (key === 'actual') diag.actual = value
    else if (key === 'stack') diag.stack = value
  }
  return { diag, next: index }
}

function parseTree(text: string): TapNode[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  const root: TapNode[] = []
  const frames: Frame[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const subtest = SUBTEST.exec(line)
    if (subtest !== null) {
      frames.push({ indent: (subtest[1] ?? '').length, name: subtest[2] ?? '', children: [] })
      continue
    }
    const result = RESULT.exec(line)
    if (result === null) continue
    const indent = (result[1] ?? '').length
    const body = result[3] ?? ''
    const directive = DIRECTIVE.exec(body)
    const name = body.replace(DIRECTIVE, '').trim()
    let children: TapNode[] = []
    const top = frames.at(-1)
    if (top !== undefined && top.indent === indent) {
      children = top.children
      frames.pop()
    }
    const failed = result[2] === 'not ok'
    const status: TapNode['status'] = directive !== null ? 'skip' : failed ? 'fail' : 'pass'
    let diag: Diagnostics = {}
    if (/^\s*---\s*$/.test(lines[index + 1] ?? '')) {
      const yaml = readYaml(lines, index + 2, indent + 2)
      diag = yaml.diag
      index = yaml.next - 1
    }
    const node: TapNode = { name, status, children, diag }
    const parent = frames.at(-1)
    if (parent !== undefined && parent.indent < indent) parent.children.push(node)
    else root.push(node)
  }
  return root
}

function locate(node: TapNode): { file: string; line?: number } | undefined {
  const own = node.diag.location
  if (own !== undefined) {
    const parts = LOCATION.exec(own)
    return parts === null ? { file: own } : { file: parts[1] ?? own, line: Number(parts[2]) }
  }
  for (const child of node.children) {
    const found = locate(child)
    if (found !== undefined) return found
  }
  return undefined
}

function failureOf(node: TapNode): ParsedCase['failure'] {
  const message = cleanFailureMessage(node.diag.error ?? node.name)
  return {
    message,
    ...(node.diag.stack === undefined ? {} : { stack: clip(stripAnsi(node.diag.stack)) }),
    ...(node.diag.expected === undefined ? {} : { expected: clip(node.diag.expected, 4000) }),
    ...(node.diag.actual === undefined ? {} : { actual: clip(node.diag.actual, 4000) }),
  }
}

function hasFailedLeaf(node: TapNode): boolean {
  return node.children.some((child) => (child.children.length === 0 ? child.status === 'fail' : hasFailedLeaf(child)))
}

function collect(node: TapNode, groups: readonly string[], file: string | undefined, ctx: ParseContext, out: ParsedCase[]): void {
  const here = locate(node)
  const fileName = here?.file ?? file
  const isFileWrapper = node.children.length === 0 && node.diag.location === undefined && /^[^\s/]+\.[cm]?[jt]sx?$/.test(node.name)
  const suiteFailedAlone = node.children.length > 0 && node.status === 'fail' && !hasFailedLeaf(node)
  if (node.children.length > 0 && !suiteFailedAlone) {
    for (const child of node.children) collect(child, [...groups, node.name], fileName ?? locate(child)?.file, ctx, out)
    return
  }
  if (isFileWrapper || (node.children.length === 0 && node.diag.type === 'suite')) return
  const line = here?.line
  out.push({
    file: fileName === undefined ? '(unknown)' : repoPath(ctx, fileName),
    ...(line === undefined ? {} : { line }),
    name: cleanName(node.name, '(未命名用例)'),
    suite_path: groups.map((group) => cleanName(group, '(分组)')),
    project: null,
    status: node.status,
    duration_ms: Math.round(Number.isFinite(node.diag.duration) ? (node.diag.duration ?? 0) : 0),
    attempts: 1,
    ...(node.status === 'fail' ? { failure: failureOf(node) } : {}),
    attachments: [],
  })
}

export function parseTap(text: string, ctx: ParseContext): CaseReport {
  if (!/^\s*TAP version \d+/m.test(text) && !/^\s*(?:not ok|ok)\b/m.test(text)) {
    return { ok: false, reason: '没有 TAP 头，也没有 ok / not ok 行：不是 TAP 报告' }
  }
  const cases: ParsedCase[] = []
  for (const node of parseTree(text)) {
    const start = locate(node)?.file
    collect(node, [], start, ctx, cases)
  }
  return { ok: true, cases, projects: [] }
}
