import type {
  WorkflowDocumentContractV1,
  WorkflowDocumentRead,
  WorkflowDocumentSlot,
} from './types.js'
import { indentOf, parseInlineList, parseInlineMap } from './parse-primitives.js'

export interface WorkflowParseCursor {
  lines: string[]
  i: number
}

const SLOT_ROLES = ['produce', 'update', 'require'] as const

/** 一条 slot 的原始键值 → 定义层 slot（role / producers 规则同 compile）。 */
function buildSlot(kind: string, fields: Record<string, string | string[]>): WorkflowDocumentSlot {
  for (const key of Object.keys(fields)) {
    if (key !== 'kind' && key !== 'owner_step' && key !== 'role' && key !== 'producers') {
      throw new Error(`workflow 解析错误：document slot '${kind}' 出现未知字段 '${key}'`)
    }
  }
  const ownerStep = fields.owner_step
  if (typeof ownerStep !== 'string' || ownerStep === '') throw new Error(`workflow 解析错误：document slot '${kind}' 缺 owner_step`)
  const role = fields.role ?? 'produce'
  if (typeof role !== 'string' || !(SLOT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`workflow 解析错误：document slot '${kind}' 的 role 只支持 produce | update | require`)
  }
  const producers = fields.producers
  if (producers !== undefined && !Array.isArray(producers)) {
    throw new Error(`workflow 解析错误：document slot '${kind}' 的 producers 必须是 [a, b] 列表`)
  }
  if (role === 'require') {
    if (producers !== undefined) throw new Error(`workflow 解析错误：document slot '${kind}' 的 role require 不声明 producers`)
    return { kind, ownerStep, role, producers: [] }
  }
  if (!producers || producers.length === 0) {
    throw new Error(`workflow 解析错误：document slot '${kind}' 缺非空 producers`)
  }
  return role === 'update' ? { kind, ownerStep, role, producers } : { kind, ownerStep, producers }
}

function parseSlots(cursor: WorkflowParseCursor, baseIndent: number): WorkflowDocumentSlot[] {
  const slots: WorkflowDocumentSlot[] = []
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? ''
    if (line.trim() === '') { cursor.i++; continue }
    if (indentOf(line) < baseIndent) break
    const flowMatch = /^\s*-\s+(\{.*\})\s*$/.exec(line)
    if (flowMatch) {
      const fields = parseInlineMap(flowMatch[1] ?? '')
      const kind = fields.kind
      if (typeof kind !== 'string') throw new Error(`workflow 解析错误：document slot 缺 kind：'${line.trim()}'`)
      slots.push(buildSlot(kind, fields))
      cursor.i++
      continue
    }
    const kindMatch = /^\s*-\s+kind:\s*(\S+)\s*$/.exec(line)
    if (!kindMatch) break
    const kind = kindMatch[1] ?? ''
    const itemIndent = indentOf(line)
    cursor.i++
    const fields: Record<string, string | string[]> = {}
    while (cursor.i < cursor.lines.length) {
      const child = cursor.lines[cursor.i] ?? ''
      if (child.trim() === '') { cursor.i++; continue }
      if (indentOf(child) <= itemIndent) break
      const fieldMatch = /^\s*(owner_step|role|producers):\s*(\S.*?)\s*$/.exec(child)
      if (!fieldMatch) throw new Error(`workflow 解析错误：document slot '${kind}' 出现未知字段行 '${child.trim()}'`)
      const key = fieldMatch[1] ?? ''
      if (Object.hasOwn(fields, key)) throw new Error(`workflow 解析错误：document slot '${kind}' 重复声明 ${key}`)
      const value = fieldMatch[2] ?? ''
      fields[key] = key === 'producers' ? parseInlineList(value) : value
      cursor.i++
    }
    slots.push(buildSlot(kind, fields))
  }
  return slots
}

function parseReads(cursor: WorkflowParseCursor, baseIndent: number): WorkflowDocumentRead[] {
  const reads: WorkflowDocumentRead[] = []
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? ''
    if (line.trim() === '') { cursor.i++; continue }
    if (indentOf(line) < baseIndent) break
    const flowMatch = /^\s*-\s+(\{.*\})\s*$/.exec(line)
    let step: string
    let kinds: string[]
    if (flowMatch) {
      const fields = parseInlineMap(flowMatch[1] ?? '')
      const unknown = Object.keys(fields).find((key) => key !== 'step' && key !== 'kinds')
      if (unknown !== undefined) throw new Error(`workflow 解析错误：document read 出现未知字段 '${unknown}'`)
      if (typeof fields.step !== 'string') throw new Error(`workflow 解析错误：document read 缺 step：'${line.trim()}'`)
      step = fields.step
      if (!Array.isArray(fields.kinds)) throw new Error(`workflow 解析错误：document read '${step}' 缺 kinds`)
      kinds = fields.kinds
      cursor.i++
    } else {
      const stepMatch = /^\s*-\s+step:\s*(\S+)\s*$/.exec(line)
      if (!stepMatch) break
      step = stepMatch[1] ?? ''
      const itemIndent = indentOf(line)
      cursor.i++
      const kindsLine = cursor.lines[cursor.i] ?? ''
      const kindsMatch = /^\s*kinds:\s*(\[.*\])\s*$/.exec(kindsLine)
      if (!kindsMatch || indentOf(kindsLine) <= itemIndent) {
        throw new Error(`workflow 解析错误：document read '${step}' 缺 kinds`)
      }
      kinds = parseInlineList(kindsMatch[1] ?? '')
      cursor.i++
    }
    if (kinds.length === 0) {
      throw new Error(`workflow 解析错误：document read '${step}' 的 kinds 不得为空`)
    }
    reads.push({ step, kinds })
  }
  return reads
}

export function parseDocumentContract(
  cursor: WorkflowParseCursor,
  keyIndent: number,
): WorkflowDocumentContractV1 {
  let version: 'v1' | undefined
  let slots: WorkflowDocumentSlot[] | undefined
  let reads: WorkflowDocumentRead[] | undefined
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? ''
    if (line.trim() === '') { cursor.i++; continue }
    if (indentOf(line) <= keyIndent) break
    const versionMatch = /^\s*version:\s*(\S+)\s*$/.exec(line)
    if (versionMatch) {
      if (versionMatch[1] !== 'v1') {
        throw new Error("workflow 解析错误：document_contract version 只支持 'v1'")
      }
      version = 'v1'
      cursor.i++
      continue
    }
    if (/^\s*slots:\s*$/.test(line)) {
      const blockIndent = indentOf(line)
      cursor.i++
      slots = parseSlots(cursor, blockIndent + 2)
      continue
    }
    if (/^\s*reads:\s*\[\]\s*$/.test(line)) { reads = []; cursor.i++; continue }
    if (/^\s*reads:\s*$/.test(line)) {
      const blockIndent = indentOf(line)
      cursor.i++
      reads = parseReads(cursor, blockIndent + 2)
      continue
    }
    throw new Error(`workflow 解析错误：document_contract 出现未知字段行 '${line.trim()}'`)
  }
  if (!version) throw new Error('workflow 解析错误：document_contract 缺 version: v1')
  if (!slots || slots.length === 0) throw new Error('workflow 解析错误：document_contract 缺非空 slots')
  if (!reads) throw new Error('workflow 解析错误：document_contract 缺 reads')
  return { version, slots, reads }
}
