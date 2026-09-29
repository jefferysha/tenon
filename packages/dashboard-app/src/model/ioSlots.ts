import type { WbIoSlot, WbStepIo } from '../api/governanceTypes'

/** 值字段与文档 kind 同名（`_` 与 `-` 视为同一个字）即是同一概念。 */
function conceptOf(id: string): string {
  return id.replace(/_/gu, '-')
}

/**
 * 同一概念只显示一个名字：值字段与同侧某个文档槽位同名时（`verification_report` ↔
 * `verification-report`、`plan` ↔ `plan`），去掉字段行，字段名挂到文档槽位的 `field` 上放 Tooltip。
 * 没有同名文档的字段原样保留；顺序不变。
 */
export function mergeFieldAliases(slots: readonly WbIoSlot[]): WbIoSlot[] {
  const documents = new Set(slots.filter((slot) => slot.kind === 'document').map((slot) => slot.id))
  const aliasOf = new Map<string, string>()
  for (const slot of slots) {
    const concept = conceptOf(slot.id)
    if (slot.kind === 'field' && documents.has(concept) && !aliasOf.has(concept)) aliasOf.set(concept, slot.id)
  }
  if (aliasOf.size === 0) return [...slots]
  return slots.flatMap((slot): WbIoSlot[] => {
    if (slot.kind === 'field') return aliasOf.get(conceptOf(slot.id)) === slot.id ? [] : [slot]
    const field = aliasOf.get(slot.id)
    return [field === undefined ? slot : { ...slot, field }]
  })
}

export function mergeStepIoAliases(io: WbStepIo | undefined): WbStepIo | undefined {
  return io === undefined ? undefined : { inputs: mergeFieldAliases(io.inputs), outputs: mergeFieldAliases(io.outputs) }
}
