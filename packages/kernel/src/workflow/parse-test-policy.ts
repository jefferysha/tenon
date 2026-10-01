/**
 * 步骤 `test_policy:` 块的窄解析（语法层；值域与组合约束在 compileStepTestPolicy）。
 * 块形态每行一个键；列表写单行 `[a, b]`；coverage / flaky / benchmark 写单行 `{ k: v }` 或下一层块。
 * 也接受整块单行 `test_policy: { run: [smoke] }`（此形态下嵌套映射不可用）。未知键 fail-loud。
 */
import type { WorkflowParseCursor as Cursor } from './parse-document-contract.js'
import { indentOf, parseInlineList, parseInlineMap } from './parse-primitives.js'
import type { StepTestPolicyDef } from './types.js'

const SCALAR_KEYS = ['plan', 'scope', 'files', 'scenarios', 'integrity'] as const
const LIST_KEYS = ['kinds', 'run', 'run_if_registered', 'browsers'] as const
const MAP_KEYS = ['coverage', 'flaky', 'benchmark'] as const
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/

type Mutable = { -readonly [K in keyof StepTestPolicyDef]: StepTestPolicyDef[K] }

function fail(message: string): never {
  throw new Error(`workflow 解析错误：${message}`)
}

function typed(raw: string): number | boolean | string {
  const value = raw.trim()
  if (NUMBER_RE.test(value)) return Number(value)
  if (value === 'true' || value === 'false') return value === 'true'
  return value
}

function nestedMap(raw: Record<string, string | string[]>, where: string): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) fail(`${where}.${key} 不接受列表`)
    out[key] = typed(value)
  }
  return out
}

function assign(policy: Mutable, key: string, value: string | string[] | Record<string, number | boolean | string>, where: string): void {
  if (Object.hasOwn(policy, key)) fail(`${where} 重复声明 ${key}`)
  if ((SCALAR_KEYS as readonly string[]).includes(key)) {
    if (typeof value !== 'string') fail(`${where}.${key} 必须是单个值`)
    Object.assign(policy, { [key]: value })
    return
  }
  if ((LIST_KEYS as readonly string[]).includes(key)) {
    if (!Array.isArray(value)) fail(`${where}.${key} 必须是 [a, b] 列表`)
    Object.assign(policy, { [key]: value })
    return
  }
  if ((MAP_KEYS as readonly string[]).includes(key)) {
    if (typeof value !== 'object' || Array.isArray(value)) fail(`${where}.${key} 必须是 { k: v } 映射`)
    Object.assign(policy, { [key]: value })
    return
  }
  fail(`${where} 出现未知键 '${key}'（支持 ${[...SCALAR_KEYS, ...LIST_KEYS, ...MAP_KEYS].join('/')}）`)
}

function parseNestedBlock(cur: Cursor, keyIndent: number, where: string): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const match = /^\s*([a-z_]+):\s*(\S.*?)\s*$/.exec(line)
    if (!match) fail(`${where} 出现无法识别的行 '${line.trim()}'`)
    const key = match[1] ?? ''
    if (Object.hasOwn(out, key)) fail(`${where} 重复声明 ${key}`)
    out[key] = typed(match[2] ?? '')
    cur.i++
  }
  return out
}

/** 单行形态：`test_policy: { run: [smoke], scope: full }`。 */
export function parseInlineTestPolicy(raw: string, stepId: string): StepTestPolicyDef {
  const where = `step '${stepId}' 的 test_policy`
  const policy: Mutable = {}
  for (const [key, value] of Object.entries(parseInlineMap(raw))) {
    if ((MAP_KEYS as readonly string[]).includes(key)) fail(`${where} 的单行形态不支持 ${key}，请改用块形态`)
    assign(policy, key, value, where)
  }
  return policy
}

export function parseStepTestPolicy(cur: Cursor, keyIndent: number, stepId: string): StepTestPolicyDef {
  const where = `step '${stepId}' 的 test_policy`
  const policy: Mutable = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const match = /^\s*([a-z_]+):\s*(.*?)\s*$/.exec(line)
    if (!match) fail(`${where} 出现无法识别的行 '${line.trim()}'`)
    const key = match[1] ?? ''
    const rest = match[2] ?? ''
    const lineIndent = indentOf(line)
    cur.i++
    if (rest === '') {
      if (!(MAP_KEYS as readonly string[]).includes(key)) fail(`${where}.${key} 缺值`)
      assign(policy, key, parseNestedBlock(cur, lineIndent, `${where}.${key}`), where)
      continue
    }
    if (rest.startsWith('[')) { assign(policy, key, parseInlineList(rest), where); continue }
    if (rest.startsWith('{')) { assign(policy, key, nestedMap(parseInlineMap(rest), `${where}.${key}`), where); continue }
    assign(policy, key, rest, where)
  }
  return policy
}
