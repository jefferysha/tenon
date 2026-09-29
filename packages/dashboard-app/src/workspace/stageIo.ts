import { isEngineWrittenOutput } from '@tenon/kernel/workflow/auto-gate'
import type { WbIoSlot, WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot, DocumentStaleReason } from '../types'
import { producerSkills } from '../workflow/producers'
import { fieldStr, isUnset } from './taskModel'

const FILE_FIELDS = new Set(['design_doc', 'plan', 'verification_report', 'prd_path'])

/**
 * 聚合语境（未选项目）不发 per-root 请求时的退化 IO：只有快照里冻结的每步输出字段名，
 * 没有文档槽位与输入。选中项目后由服务端物化 IO 取代。
 */
export function fallbackStepIo(change: ChangeSnapshot, stepId: string): WbStepIo {
  const fields = change.workflowRules.outputsByStep?.[stepId] ?? []
  return {
    inputs: [],
    outputs: fields.map((field) => ({ kind: 'field', id: field, type: FILE_FIELDS.has(field) ? 'file_path' : 'string', producer: null, consumers: [] })),
  }
}

/** 文档槽位沿用台账状态；值槽位只有 set / unset。 */
export type IoRowStatus = 'recorded' | 'missing' | 'stale' | 'unread' | 'set' | 'unset'

export interface IoRow {
  slot: WbIoSlot
  status: IoRowStatus
  /** 可阅读的项目根相对路径；值槽位或未产出时为 null。 */
  path: string | null
  value: string
  /** 最近一次登记该文档的技能；值槽位为 null。 */
  producer: string | null
  /** 最近一次登记时间（ISO）；无则 null。 */
  at: string | null
  /** 最近一次登记的操作人名字；无则缺省。 */
  actor?: string | null
  /** 过期原因；其它状态为 null。 */
  reason: DocumentStaleReason | null
  /** 应产出它的技能（输出侧文档槽位：契约候选 ∩ 本阶段技能）；其余为空。 */
  producers: readonly string[]
}

export function ioRowOf(change: ChangeSnapshot, slot: WbIoSlot, stageSkills: readonly string[] = []): IoRow {
  if (slot.kind === 'document') {
    const item = change.documents?.items.find((candidate) => candidate.kind === slot.id)
    const last = item?.timeline?.at(-1)
    const produced = slot.role === 'produce' || slot.role === 'update'
    const matched = produced ? producerSkills(slot.producers, stageSkills) : []
    return {
      slot,
      status: item?.status ?? 'missing',
      path: item?.paths[0] ?? null,
      value: item?.paths[0] ?? '',
      producer: last?.producer ?? item?.producers.at(-1) ?? null,
      at: last?.recordedAt ?? null,
      actor: last?.actor?.name ?? null,
      reason: item?.status === 'stale' ? item.reason ?? null : null,
      producers: produced ? (matched.length > 0 ? matched : [...slot.producers]) : [],
    }
  }
  const value = fieldStr(change, slot.id)
  const set = !isUnset(value)
  return {
    slot,
    status: set ? 'set' : 'unset',
    path: set && slot.type === 'file_path' ? value : null,
    value: set ? value : '',
    producer: null,
    at: null,
    reason: null,
    producers: [],
  }
}

export function stageOutputs(change: ChangeSnapshot, stepIo: WbStepIo | undefined, stageSkills: readonly string[] = []): IoRow[] {
  return (stepIo?.outputs ?? []).map((slot) => ioRowOf(change, slot, stageSkills))
}

export function stageInputs(change: ChangeSnapshot, stepIo: WbStepIo | undefined): IoRow[] {
  return (stepIo?.inputs ?? []).map((slot) => ioRowOf(change, slot))
}

/**
 * 门禁行的条件计数：auto = 声明的输出齐全；review 在此之上多一条人工确认。
 * 没有门禁或一个条件都没有 → null（不显示这一行）。
 */
export function gateProgress(
  gate: 'review' | 'auto' | null,
  outputs: readonly IoRow[],
  reviewSatisfied: boolean,
): { gate: 'review' | 'auto'; done: number; total: number } | null {
  if (gate === null) return null
  // 自动门禁不检查引擎自己写的输出（build_sha 等：离开本阶段之前不会有值），计数与内核同口径。
  const checked = gate === 'auto'
    ? outputs.filter((row) => !(row.slot.kind === 'field' && isEngineWrittenOutput(row.slot.id)))
    : outputs
  const total = checked.length + (gate === 'review' ? 1 : 0)
  if (total === 0) return null
  const done = checked.filter(isReadyRow).length + (gate === 'review' && reviewSatisfied ? 1 : 0)
  return { gate, done, total }
}

export function isReadyRow(row: IoRow): boolean {
  return row.status === 'recorded' || row.status === 'unread' || row.status === 'set'
}

export function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** 可阅读文件的有序列表（先输出后输入，去重），供抽屉上一份 / 下一份。 */
export function readableFiles(rows: readonly IoRow[]): Array<{ path: string; label: string }> {
  const seen = new Set<string>()
  const out: Array<{ path: string; label: string }> = []
  for (const row of rows) {
    if (row.path === null || seen.has(row.path)) continue
    seen.add(row.path)
    out.push({ path: row.path, label: row.slot.id })
  }
  return out
}
