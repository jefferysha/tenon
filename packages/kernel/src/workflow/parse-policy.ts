import {
  compileWorkflowDecompositionPolicy,
  compileWorkflowInteractionPolicy,
} from './policy.js'
import type {
  WorkflowDecompositionPolicyV1,
  WorkflowDef,
  WorkflowInteractionPolicyV1,
} from './types.js'
import type { WorkflowParseCursor } from './parse-document-contract.js'

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function inlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '[]') return []
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`workflow 解析错误：期望 [a, b] 形态的单行列表，实际 '${raw}'`)
  }
  const items = trimmed.slice(1, -1).split(',').map((item) => item.trim())
  if (items.some((item) => item === '')) {
    throw new Error(`workflow 解析错误：单行列表不得包含空项，实际 '${raw}'`)
  }
  return items
}

function parsePolicyBlock(
  cur: WorkflowParseCursor,
  key: 'decomposition' | 'interaction',
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i] ?? ''
    if (line.trim() === '') { cur.i++; continue }
    if (indentOf(line) === 0) break
    const match = /^\s{2}([a-z_]+):\s*(.*?)\s*$/.exec(line)
    if (!match) throw new Error(`workflow 解析错误：${key} 出现未知字段行 '${line.trim()}'`)
    const field = match[1] ?? ''
    const raw = match[2] ?? ''
    if (!allowedKeys.includes(field)) throw new Error(`workflow 解析错误：${key} 未知字段 '${field}'`)
    if (Object.hasOwn(result, field)) throw new Error(`workflow 解析错误：${key}.${field} 重复声明`)
    if (raw === '') throw new Error(`workflow 解析错误：${key}.${field} 缺值`)
    if (field === 'auto_when' || field === 'ask_when') result[field] = inlineList(raw)
    else if (field === 'max_items' || field === 'max_depth') {
      if (!/^-?\d+$/.test(raw)) throw new Error(`workflow 解析错误：${key}.${field} 必须是整数`)
      result[field] = Number(raw)
    } else result[field] = raw
    cur.i++
  }
  return result
}

export function parseDecompositionPolicy(cur: WorkflowParseCursor): WorkflowDef['decomposition'] {
  const raw = parsePolicyBlock(cur, 'decomposition', [
    'version', 'mode', 'target', 'strategy', 'max_items', 'max_depth', 'auto_when', 'ask_when',
  ])
  compileWorkflowDecompositionPolicy(raw)
  return raw as Omit<Partial<WorkflowDecompositionPolicyV1>, 'version'> & { readonly version: 'v1' }
}

export function parseInteractionPolicy(cur: WorkflowParseCursor): WorkflowDef['interaction'] {
  const raw = parsePolicyBlock(cur, 'interaction', ['version', 'mode'])
  compileWorkflowInteractionPolicy(raw)
  return raw as Omit<Partial<WorkflowInteractionPolicyV1>, 'version'> & { readonly version: 'v1' }
}
