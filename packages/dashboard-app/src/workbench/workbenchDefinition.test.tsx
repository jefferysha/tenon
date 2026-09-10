import { describe, expect, it } from 'vitest'
import {
  addDocumentSlotInDef,
  addFieldOutputInDef,
  addSkillToDef,
  blankWorkflow,
  cloneWorkflowDef,
  copyWorkflowDef,
  definitionForWrite,
  removeDocumentSlotInDef,
  removeFieldOutputInDef,
  removeSkillFromDef,
  removeStageFromDef,
  setDocumentReadInDef,
  setFieldInputInDef,
  setStepSkillWavesInDef,
  workflowNameFromYaml,
  type WbWorkflowDef,
} from './workbenchDefinition'

function twoStep(): WbWorkflowDef {
  return {
    name: 'two',
    source: 'project',
    effectiveIo: {},
    steps: [
      { id: 'a', label: 'A', gate: null, skills: [{ id: 's1' }, { id: 's2', depends_on: ['s1'] }], inputs: [], outputs: [{ field: 'plan', type: 'file_path' }], artifacts: [{ field: 'plan', type: 'file_path', producerPolicy: 'effective-step-skills' }], guards: [], transitions: [{ event: 'go', to: 'b' }] },
      { id: 'b', label: 'B', gate: 'review', skills: [], inputs: [{ field: 'plan', type: 'file_path' }], outputs: [], guards: [], transitions: [] },
    ],
  }
}

describe('workbenchDefinition · 写回投影', () => {
  it('definitionForWrite 剔除 source / effectiveIo；clone 深拷贝且不带投影字段', () => {
    const def = twoStep()
    expect(Object.keys(definitionForWrite(def))).toEqual(['name', 'steps'])
    const cloned = cloneWorkflowDef(def, 'copy')
    expect(cloned.name).toBe('copy')
    expect('source' in cloned).toBe(false)
    expect(cloned.steps[0]?.skills[1]).not.toBe(def.steps[0]?.skills[1])
    expect(cloned.steps[0]?.skills[1]?.depends_on).toEqual(['s1'])
  })
})

describe('workbenchDefinition · 技能列模型', () => {
  it('setStepSkillWaves：同列并行、邻列串行 → depends_on 指向上一列全部技能', () => {
    const next = setStepSkillWavesInDef(twoStep(), 'a', [['s1', 's3'], ['s2']])
    expect(next.steps[0]?.skills).toEqual([{ id: 's1' }, { id: 's3' }, { id: 's2', depends_on: ['s1', 's3'] }])
  })
  it('addSkill 追加为新的末列；removeSkill 顺带清掉依赖', () => {
    const added = addSkillToDef(twoStep(), 'a', 's3')
    expect(added.steps[0]?.skills.at(-1)).toEqual({ id: 's3', depends_on: ['s2'] })
    const removed = removeSkillFromDef(added, 'a', 's2')
    expect(removed.steps[0]?.skills).toEqual([{ id: 's1' }, { id: 's3', depends_on: ['s1'] }])
  })
})

describe('workbenchDefinition · 输入 / 输出槽位', () => {
  it('addFieldOutput 文件字段同步登记 artifact；removeFieldOutput 撤掉下游对它的输入', () => {
    const added = addFieldOutputInDef(twoStep(), 'b', { field: 'verification_report', type: 'file_path' })
    expect(added.steps[1]?.outputs).toEqual([{ field: 'verification_report', type: 'file_path' }])
    expect(added.steps[1]?.artifacts).toEqual([{ field: 'verification_report', type: 'file_path', producerPolicy: 'effective-step-skills' }])
    const removed = removeFieldOutputInDef(twoStep(), 'a', 'plan')
    expect(removed.steps[0]?.outputs).toEqual([])
    expect(removed.steps[0]?.artifacts).toEqual([])
    expect(removed.steps[1]?.inputs).toEqual([])
  })
  it('setFieldInput 幂等勾选 / 取消', () => {
    const off = setFieldInputInDef(twoStep(), 'b', { field: 'plan', type: 'file_path' }, false)
    expect(off.steps[1]?.inputs).toEqual([])
    const on = setFieldInputInDef(off, 'b', { field: 'plan', type: 'file_path' }, true)
    expect(on.steps[1]?.inputs).toEqual([{ field: 'plan', type: 'file_path' }])
    expect(setFieldInputInDef(on, 'b', { field: 'plan', type: 'file_path' }, true)).toBe(on)
  })
  it('文档槽位写入 document_contract：producers 取本阶段技能；reads 勾选；移除槽位连带 reads；契约固定的工作流不可改', () => {
    const withSlot = addDocumentSlotInDef(twoStep(), 'a', 'proposal')
    expect(withSlot.documentContract).toEqual({ version: 'v1', slots: [{ kind: 'proposal', ownerStep: 'a', producers: ['s1', 's2'] }], reads: [] })
    const withRead = setDocumentReadInDef(withSlot, 'b', 'proposal', true)
    expect(withRead.documentContract?.reads).toEqual([{ step: 'b', kinds: ['proposal'] }])
    const removed = removeDocumentSlotInDef(withRead, 'proposal')
    expect(removed.documentContract).toBeUndefined()
    const locked: WbWorkflowDef = { ...twoStep(), openspecContract: 'required' }
    expect(addDocumentSlotInDef(locked, 'a', 'proposal')).toBe(locked)
  })
  it('removeStage 连带清掉该阶段拥有的文档槽位与 reads，并重接转换边', () => {
    const three: WbWorkflowDef = {
      ...twoStep(),
      documentContract: { version: 'v1', slots: [{ kind: 'proposal', ownerStep: 'a', producers: ['s1'] }], reads: [{ step: 'b', kinds: ['proposal'] }] },
    }
    const removed = removeStageFromDef(three, 'b')
    expect(removed.steps.map((step) => step.id)).toEqual(['a'])
    expect(removed.steps[0]?.transitions).toEqual([])
    expect(removed.documentContract?.reads).toEqual([])
  })
})

describe('workbenchDefinition · 新建', () => {
  it('copyWorkflowDef 从 default 复制：保住 openspec 契约、artifact policy 改为 custom 允许的 effective-step-skills', () => {
    const fromDefault: WbWorkflowDef = { ...twoStep(), name: 'default', steps: twoStep().steps.map((step) => ({ ...step, artifacts: step.artifacts?.map((artifact) => ({ ...artifact, producerPolicy: 'effective-phase-skills' as const })) })) }
    const copied = copyWorkflowDef(fromDefault, 'mine')
    expect(copied.openspecContract).toBe('required')
    expect(copied.steps[0]?.artifacts?.[0]?.producerPolicy).toBe('effective-step-skills')
    expect(copyWorkflowDef(twoStep(), 'other').openspecContract).toBeUndefined()
  })

  it('blankWorkflow 一个阶段、无输出；workflowNameFromYaml 取 name 行', () => {
    expect(blankWorkflow('fresh', '阶段 1').steps).toEqual([{ id: 'stage-1', label: '阶段 1', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }])
    expect(workflowNameFromYaml('name: imported\nsteps: []\n')).toBe('imported')
    expect(workflowNameFromYaml('steps: []\n')).toBe('')
  })
})
