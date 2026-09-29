import { describe, expect, it } from 'vitest'
import type { WbIoSlot } from '../api/governanceTypes'
import { mergeFieldAliases, mergeStepIoAliases } from './ioSlots'

const document = (id: string): WbIoSlot => ({ kind: 'document', id, role: 'produce', scope: 'change', producers: [], consumers: [] })
const field = (id: string): WbIoSlot => ({ kind: 'field', id, type: 'file_path', producer: null, consumers: [] })

describe('mergeFieldAliases', () => {
  it('verification_report 并进 verification-report：只剩文档一行，字段名挂在 field 上', () => {
    const merged = mergeFieldAliases([field('verification_report'), document('verification-report'), document('tasks')])
    expect(merged).toEqual([{ ...document('verification-report'), field: 'verification_report' }, document('tasks')])
  })

  it('完全同名（plan ↔ plan）同样合并；没有同名文档的字段保留原位', () => {
    const merged = mergeFieldAliases([document('plan'), field('plan'), field('build_sha')])
    expect(merged.map((slot) => `${slot.kind}:${slot.id}`)).toEqual(['document:plan', 'field:build_sha'])
    expect(merged[0]).toMatchObject({ field: 'plan' })
  })

  it('没有同名对时原样返回；输入与输出各自合并', () => {
    const slots = [field('design_doc'), document('proposal')]
    expect(mergeFieldAliases(slots)).toEqual(slots)
    expect(mergeStepIoAliases(undefined)).toBeUndefined()
    const io = mergeStepIoAliases({
      inputs: [field('verification_report'), { ...document('verification-report'), role: 'read' }],
      outputs: [field('pr_url')],
    })
    expect(io?.inputs.map((slot) => slot.id)).toEqual(['verification-report'])
    expect(io?.outputs.map((slot) => slot.id)).toEqual(['pr_url'])
  })
})
