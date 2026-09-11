import type { WbIoSlot, WbSkillRef, WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot, SkillRunsSnapshot } from '../types'
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
}

export function ioRowOf(change: ChangeSnapshot, slot: WbIoSlot): IoRow {
  if (slot.kind === 'document') {
    const item = change.documents?.items.find((candidate) => candidate.kind === slot.id)
    const last = item?.timeline?.at(-1)
    return {
      slot,
      status: item?.status ?? 'missing',
      path: item?.paths[0] ?? null,
      value: item?.paths[0] ?? '',
      producer: last?.producer ?? item?.producers.at(-1) ?? null,
      at: last?.recordedAt ?? null,
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
  }
}

export function stageOutputs(change: ChangeSnapshot, stepIo: WbStepIo | undefined): IoRow[] {
  return (stepIo?.outputs ?? []).map((slot) => ioRowOf(change, slot))
}

export function stageInputs(change: ChangeSnapshot, stepIo: WbStepIo | undefined): IoRow[] {
  return (stepIo?.inputs ?? []).map((slot) => ioRowOf(change, slot))
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

/** 工作台的技能运行快照 → 技能引用：第 k 波依赖第 k-1 波全部技能（列模型），供 SkillFlow 画布。 */
export function skillsFromRuns(runs: SkillRunsSnapshot[number] | undefined): WbSkillRef[] {
  if (runs === undefined) return []
  const waves = new Map<number, string[]>()
  for (const skill of runs.skills) waves.set(skill.wave, [...(waves.get(skill.wave) ?? []), skill.id])
  const ordered = [...waves.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids)
  const out: WbSkillRef[] = []
  ordered.forEach((wave, index) => {
    const previous = ordered[index - 1] ?? []
    for (const id of wave) out.push(previous.length > 0 ? { id, depends_on: [...previous] } : { id })
  })
  return out
}
