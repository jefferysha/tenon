import type { WbEffectiveIo, WbFieldRef, WbWorkflowDef } from '../api/governanceTypes'

/** 可作为阶段输出的 change 字段（kernel FIELD_ORDER 里与工作流产出相关的子集）。 */
export const FIELD_CATALOG: readonly WbFieldRef[] = [
  { field: 'design_doc', type: 'file_path' },
  { field: 'plan', type: 'file_path' },
  { field: 'verification_report', type: 'file_path' },
  { field: 'prd_path', type: 'file_path' },
  { field: 'build_sha', type: 'string' },
  { field: 'pr_url', type: 'string' },
  { field: 'branch', type: 'string' },
  { field: 'scope', type: 'string' },
  { field: 'archived', type: 'boolean' },
]

/** 文档 kind 闭集（kernel DOCUMENT_KINDS）。 */
export const DOCUMENT_KINDS = [
  'proposal',
  'openspec-design',
  'tasks',
  'superpower-design',
  'adr',
  'delta-spec',
  'superpower-plan',
  'plan',
  'verification-report',
  'applied-spec',
] as const

export type SlotCandidate =
  | { kind: 'document'; id: string }
  | { kind: 'field'; id: string; type: WbFieldRef['type'] }

/** 某阶段还能添加的输出槽位：未被任何阶段占用的文档 kind（契约固定时无）+ 本阶段尚未声明的字段。 */
export function availableOutputSlots(def: WbWorkflowDef, stepId: string, io: WbEffectiveIo | undefined): SlotCandidate[] {
  const step = def.steps.find((candidate) => candidate.id === stepId)
  if (!step) return []
  const lockedDocuments = def.openspecContract === 'required' || def.name === 'default'
  const usedDocuments = new Set<string>()
  for (const stepIo of Object.values(io ?? {})) {
    for (const slot of stepIo.outputs) if (slot.kind === 'document') usedDocuments.add(slot.id)
  }
  for (const slot of def.documentContract?.slots ?? []) usedDocuments.add(slot.kind)
  const documents: SlotCandidate[] = lockedDocuments
    ? []
    : DOCUMENT_KINDS.filter((kind) => !usedDocuments.has(kind)).map((kind) => ({ kind: 'document', id: kind }))
  const declared = new Set(step.outputs.map((output) => output.field))
  const fields: SlotCandidate[] = FIELD_CATALOG.filter((field) => !declared.has(field.field)).map((field) => ({ kind: 'field', id: field.field, type: field.type }))
  return [...documents, ...fields]
}

/** 上游阶段的全部输出（供输入区勾选）。 */
export function upstreamOutputs(def: WbWorkflowDef, stepId: string, io: WbEffectiveIo | undefined): SlotCandidate[] {
  const index = def.steps.findIndex((candidate) => candidate.id === stepId)
  if (index <= 0) return []
  const seen = new Set<string>()
  const out: SlotCandidate[] = []
  for (const upstream of def.steps.slice(0, index)) {
    for (const slot of io?.[upstream.id]?.outputs ?? []) {
      const key = `${slot.kind}:${slot.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(slot.kind === 'document' ? { kind: 'document', id: slot.id } : { kind: 'field', id: slot.id, type: slot.type })
    }
  }
  return out
}
