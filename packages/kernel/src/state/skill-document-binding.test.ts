import { describe, expect, it } from 'vitest'
import { documentGovernancePolicy } from '../workflow/document-contract.js'
import type { StepDef, WorkflowDocumentContractV1 } from '../workflow/types.js'
import type { DocumentRecord } from './document-ledger.js'
import { judgeStepSkillSlots, missingStepSkillMessages } from './skill-document-binding.js'

const step = (id: string): StepDef => ({ id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] })

const CONTRACT: WorkflowDocumentContractV1 = {
  version: 'v1',
  slots: [
    { kind: 'superpower-design', ownerStep: 'explore', producers: ['brainstorming', 'superpowers:brainstorming'] },
    { kind: 'adr', ownerStep: 'explore', producers: ['brainstorming'] },
    { kind: 'proposal', ownerStep: 'explore', role: 'update', producers: ['tenon'] },
  ],
  reads: [],
}
const policy = documentGovernancePolicy('custom', { openspec: true, documentContract: CONTRACT, steps: [step('explore')] })

function record(kind: DocumentRecord['kind'], producer: string): DocumentRecord {
  return { kind, path: `docs/${kind}.md`, sha256: 'a'.repeat(64), producer, recordedAt: '2026-07-07T00:00:00Z', reads: [] }
}

const SLOTS = [
  { token: 'brainstorming', alternatives: ['brainstorming'] },
  { token: 'grilling', alternatives: ['grilling'] },
]

describe('judgeStepSkillSlots：必需技能 = 调用 + 本步绑定的产物', () => {
  it('空回执：producer 技能停在「已调用、欠文档」，不产出文档的技能调用即完成', () => {
    const slots = judgeStepSkillSlots({
      slots: SLOTS, completed: new Set(['brainstorming', 'grilling']), policy, stepId: 'explore', visitRecords: [],
    })
    expect(slots).toEqual([
      { token: 'brainstorming', invoked: true, pendingDocuments: ['superpower-design', 'adr'], done: false },
      { token: 'grilling', invoked: true, pendingDocuments: [], done: true },
    ])
    expect(missingStepSkillMessages(slots)).toEqual([
      'brainstorming（已调用，本次步骤访问尚未登记它产出的 document：superpower-design, adr）',
    ])
  })

  it('本次访问由它（按别名等价）登记了全部产物才完成；别的 producer 登记的不算它的', () => {
    const partial = judgeStepSkillSlots({
      slots: SLOTS, completed: new Set(['brainstorming', 'grilling']), policy, stepId: 'explore',
      visitRecords: [record('superpower-design', 'superpowers:brainstorming'), record('adr', 'someone-else')],
    })
    expect(partial[0]).toEqual({ token: 'brainstorming', invoked: true, pendingDocuments: ['adr'], done: false })
    const complete = judgeStepSkillSlots({
      slots: SLOTS, completed: new Set(['tenon:brainstorming', 'grilling']), policy, stepId: 'explore',
      visitRecords: [record('superpower-design', 'brainstorming'), record('adr', 'brainstorming')],
    })
    expect(complete.every((slot) => slot.done)).toBe(true)
  })

  it('未调用：文案先说调用后还要交哪些文档；没有文档契约时只看调用', () => {
    const slots = judgeStepSkillSlots({ slots: SLOTS, completed: new Set(), policy, stepId: 'explore', visitRecords: [] })
    expect(missingStepSkillMessages(slots)).toEqual([
      'brainstorming（调用后还须在本步登记它产出的 document：superpower-design, adr）',
      'grilling',
    ])
    const ungoverned = judgeStepSkillSlots({
      slots: SLOTS, completed: new Set(['brainstorming']), policy: undefined, stepId: 'explore', visitRecords: [],
    })
    expect(ungoverned[0]?.done).toBe(true)
  })

  it('`a|b` 备选：任一备选调用且交齐自己的产物即完成', () => {
    const slots = judgeStepSkillSlots({
      slots: [{ token: 'brainstorming|grilling', alternatives: ['brainstorming', 'grilling'] }],
      completed: new Set(['brainstorming', 'grilling']), policy, stepId: 'explore', visitRecords: [],
    })
    expect(slots[0]?.done).toBe(true)
  })
})

describe('missingStepSkillMessages 的 exclude：生成文案前按槽位技能 id 剔除', () => {
  const pending = (token: string) => ({ token, invoked: false, pendingDocuments: [], done: false }) as const

  it('exclude 里的槽位不出文案，其余槽位逐字不变', () => {
    const slots = [pending('test-driven-development'), pending('verification-before-completion')]
    expect(missingStepSkillMessages(slots, new Set(['test-driven-development']))).toEqual(['verification-before-completion'])
    expect(missingStepSkillMessages(slots, new Set(['unrelated']))).toEqual(missingStepSkillMessages(slots))
  })

  it('exclude 缺省或为空：与不传完全相同', () => {
    const slots = [pending('a'), pending('b')]
    expect(missingStepSkillMessages(slots, undefined)).toEqual(['a', 'b'])
    expect(missingStepSkillMessages(slots, new Set())).toEqual(['a', 'b'])
  })

  it('`a|b` 备选：每个备选都被剔除才剔除整槽；只剔除一部分时槽位仍要求', () => {
    const slots = [pending('brainstorming|grilling')]
    expect(missingStepSkillMessages(slots, new Set(['brainstorming']))).toEqual(['brainstorming|grilling'])
    expect(missingStepSkillMessages(slots, new Set(['brainstorming', 'grilling']))).toEqual([])
  })

  it('`tenon:` 前缀与裸名等价（双向）', () => {
    expect(missingStepSkillMessages([pending('tenon:test-driven-development')], new Set(['test-driven-development']))).toEqual([])
    expect(missingStepSkillMessages([pending('test-driven-development')], new Set(['tenon:test-driven-development']))).toEqual([])
  })

  it('已完成的槽位本来就不出文案；exclude 只剔除自己点名的槽位，不连带别的未完成槽位', () => {
    const done = { token: 'a', invoked: true, pendingDocuments: [], done: true } as const
    expect(missingStepSkillMessages([done, pending('b')], new Set(['a']))).toEqual(['b'])
  })
})
