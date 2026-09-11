import { describe, expect, it } from 'vitest'
import {
  BASE_BRANCH,
  addSkillToDef,
  addTrackBranch,
  blankWorkflow,
  branchesOf,
  cloneWorkflowDef,
  copyWorkflowDef,
  definitionForWrite,
  removeSkillFromDef,
  removeStageFromDef,
  removeTrackBranch,
  selectBranchDef,
  setStepSkillWavesInDef,
  workflowNameFromYaml,
  writeBranchDef,
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

describe('workbenchDefinition · 删除阶段', () => {
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
  it('copyWorkflowDef 从 default 复制：不写 openspec 契约（default 的 chat 轨本就不满足它），artifact policy 改为 custom 允许的 effective-step-skills', () => {
    const fromDefault: WbWorkflowDef = { ...twoStep(), name: 'default', steps: twoStep().steps.map((step) => ({ ...step, artifacts: step.artifacts?.map((artifact) => ({ ...artifact, producerPolicy: 'effective-phase-skills' as const })) })) }
    const copied = copyWorkflowDef(fromDefault, 'mine')
    // 曾经在这里补盖 'required'，服务端校验第一次真跑就 400（tracks.chat 缺契约技能）。
    expect(copied.openspecContract).toBeUndefined()
    expect(copied.steps[0]?.artifacts?.[0]?.producerPolicy).toBe('effective-step-skills')
    expect(copyWorkflowDef(twoStep(), 'other').openspecContract).toBeUndefined()
  })

  it('blankWorkflow 一个阶段、无输出；workflowNameFromYaml 取 name 行', () => {
    expect(blankWorkflow('fresh', '阶段 1').steps).toEqual([{ id: 'stage-1', label: '阶段 1', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }])
    expect(workflowNameFromYaml('name: imported\nsteps: []\n')).toBe('imported')
    expect(workflowNameFromYaml('steps: []\n')).toBe('')
  })
})

describe('workbenchDefinition · track 分支', () => {
  it('branchesOf：有 tracks 只列 track；selectBranchDef 提升分支 steps 与分支 IO，不存在的分支退到第一条；writeBranchDef 只写回对应分支', () => {
    const def: WbWorkflowDef = {
      ...twoStep(),
      steps: [],
      tracks: {
        web: { label: '网页', steps: twoStep().steps },
        mobile: { label: '移动端', steps: [{ id: 'm1', label: 'M1', gate: null, skills: [{ id: 'sm' }], inputs: [], outputs: [], guards: [], transitions: [] }] },
      },
      branches: { web: { label: '网页', effectiveIo: { a: { inputs: [], outputs: [] } } }, mobile: { label: '移动端', effectiveIo: { m1: { inputs: [], outputs: [] } } } },
    }
    expect(branchesOf(def)).toEqual([{ id: 'web', label: '网页' }, { id: 'mobile', label: '移动端' }])
    expect(branchesOf(twoStep())).toEqual([{ id: BASE_BRANCH, label: null }])
    const mobile = selectBranchDef(def, 'mobile')
    expect(mobile.steps.map((step) => step.id)).toEqual(['m1'])
    expect(Object.keys(mobile.effectiveIo ?? {})).toEqual(['m1'])
    expect(mobile).not.toHaveProperty('tracks')
    expect(selectBranchDef(def, 'nope').steps.map((step) => step.id)).toEqual(['a', 'b'])

    const edited = writeBranchDef(def, 'mobile', { ...mobile, steps: [{ ...mobile.steps[0]!, label: 'M1 改' }] })
    expect(edited.tracks?.mobile?.steps[0]?.label).toBe('M1 改')
    expect(edited.tracks?.web?.steps.map((step) => step.id)).toEqual(['a', 'b'])
    expect(edited.steps).toEqual([])
    const single = twoStep()
    expect(writeBranchDef(single, BASE_BRANCH, { ...single, steps: single.steps.slice(0, 1) }).steps.map((step) => step.id)).toEqual(['a'])
  })

  it('addTrackBranch：单条 pipeline 的工作流搬进 main 再加新分支；已有 tracks 复制指定分支；removeTrackBranch 删到最后一条时 steps 回到顶层', () => {
    const def = twoStep()
    const withTrack = addTrackBranch(def, 'web', '网页')
    expect(withTrack.steps).toEqual([])
    expect(Object.keys(withTrack.tracks ?? {})).toEqual(['main', 'web'])
    expect(withTrack.tracks?.web?.label).toBe('网页')
    expect(withTrack.tracks?.web?.steps.map((step) => step.id)).toEqual(['a', 'b'])
    expect(withTrack.tracks?.web?.steps[0]).not.toBe(def.steps[0])
    const more = addTrackBranch(withTrack, 'api', '', 'web')
    expect(more.tracks?.api).not.toHaveProperty('label')
    expect(more.tracks?.api?.steps.map((step) => step.id)).toEqual(['a', 'b'])
    const one = removeTrackBranch(removeTrackBranch(more, 'api'), 'web')
    expect(Object.keys(one.tracks ?? {})).toEqual(['main'])
    const none = removeTrackBranch(one, 'main')
    expect(none).not.toHaveProperty('tracks')
    expect(none.steps.map((step) => step.id)).toEqual(['a', 'b'])
    expect(definitionForWrite({ ...withTrack, branches: {} })).not.toHaveProperty('branches')
  })
})
