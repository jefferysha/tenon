import { describe, expect, it } from 'vitest'
import { draftEffectiveIo, lintWorkflow } from '../workflow/lint'
import {
  BASE_BRANCH,
  addSkillToDef,
  backTransitionOf,
  displacedBackTransitions,
  setStageBackInDef,
  addTrackBranch,
  blankWorkflow,
  branchesOf,
  cloneWorkflowDef,
  copyWorkflowDef,
  definitionForWrite,
  removeSkillFromDef,
  removeStageFromDef,
  removeTrackBranch,
  reorderStagesInDef,
  selectBranchDef,
  setStepSkillWavesInDef,
  workflowNameFromYaml,
  writeBranchDef,
  type WbStepDef,
  type WbTransition,
  type WbWorkflowDef,
} from './workbenchDefinition'

function stage(id: string, transitions: WbTransition[] = []): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions }
}

function pipeline(...steps: WbStepDef[]): WbWorkflowDef {
  return { name: 'custom', steps }
}

function edgesOf(def: WbWorkflowDef): Record<string, WbTransition[]> {
  return Object.fromEntries(def.steps.map((step) => [step.id, step.transitions]))
}

/** 重接后的不变式：没有同目标的两条边，也没有既不去下一阶段又不退回的边。 */
function expectRelinked(def: WbWorkflowDef): void {
  for (const step of def.steps) {
    const targets = step.transitions.map((transition) => transition.to)
    expect(new Set(targets).size, step.id).toBe(targets.length)
  }
  expect(lintWorkflow(def, draftEffectiveIo(def, undefined)).filter((issue) => issue.kind === 'transition-not-next-or-back')).toEqual([])
}

const VERIFY_FAIL: WbTransition = {
  event: 'verify-fail',
  to: 'build',
  guards: [{ type: 'field-nonempty', field: 'build_sha' }],
  actions: [{ type: 'mark-verification-failed' }, { type: 'reset-pre-verify-review' }],
}
const REQUIREMENTS_CHANGED: WbTransition = {
  event: 'requirements-changed',
  to: 'spec',
  guards: [{ type: 'field-nonempty', field: 'plan' }],
  actions: [{ type: 'reset-pre-verify-review' }],
}

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

  it('删中间阶段：前一阶段的正向边接到新的下一阶段；指向它的退回边改指它的下一阶段，变成自指就删，与已有同目标边冲突就丢改出来的那条', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }]),
      stage('b', [{ event: 'b-done', to: 'c' }]),
      stage('c', [{ event: 'c-done', to: 'd' }, { event: 'c-back', to: 'b' }]),
      stage('d', [{ event: 'd-back', to: 'b' }, { event: 'd-fail', to: 'c', actions: [{ type: 'mark-verification-failed' }] }]),
    )
    const removed = removeStageFromDef(def, 'b')
    expect(removed.steps.map((step) => step.id)).toEqual(['a', 'c', 'd'])
    expect(edgesOf(removed)).toEqual({
      a: [{ event: 'a-done', to: 'c' }],
      c: [{ event: 'c-done', to: 'd' }],
      d: [{ event: 'd-fail', to: 'c', actions: [{ type: 'mark-verification-failed' }] }],
    })
    expectRelinked(removed)
  })

  it('删阶段：退回边改指它的下一阶段后仍在来源之前 → 保留 event / guards / actions', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }]),
      stage('b', [{ event: 'b-done', to: 'c' }]),
      stage('c', [{ event: 'c-done', to: 'd' }]),
      stage('d', [{ ...VERIFY_FAIL, to: 'b' }]),
    )
    const removed = removeStageFromDef(def, 'b')
    expect(edgesOf(removed).d).toEqual([{ ...VERIFY_FAIL, to: 'c' }])
    expectRelinked(removed)
  })

  it('删阶段：前一阶段另有往后跳到新下一阶段的边 → 不留两条同目标边', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }, { event: 'a-skip', to: 'c' }]),
      stage('b', [{ event: 'b-done', to: 'c' }]),
      stage('c'),
    )
    const removed = removeStageFromDef(def, 'b')
    expect(edgesOf(removed)).toEqual({ a: [{ event: 'a-done', to: 'c' }], c: [] })
    expectRelinked(removed)
  })
})

describe('workbenchDefinition · 排序', () => {
  it('E2E 复现：把末阶段 verify 拖到它的退回目标 build 之前 → 旧退回边删掉，不再变成第二条去 build 的边', () => {
    const def = pipeline(
      stage('stage-1', [{ event: 'stage-1-complete', to: 'build' }]),
      stage('build', [{ event: 'build-complete', to: 'verify' }]),
      stage('verify', [{ event: 'verify-back', to: 'build' }]),
    )
    const moved = reorderStagesInDef(def, 'verify', 'build', false)
    expect(moved.steps.map((step) => step.id)).toEqual(['stage-1', 'verify', 'build'])
    expect(edgesOf(moved)).toEqual({
      'stage-1': [{ event: 'stage-1-complete', to: 'verify' }],
      verify: [{ event: 'verify-complete', to: 'build' }],
      build: [],
    })
    expectRelinked(moved)
  })

  it('仍然指向更早阶段的退回边原样保留（同一个对象，guards / actions 不动）；失效的退回边删掉', () => {
    const def = pipeline(
      stage('spec', [{ event: 'spec-complete', to: 'build' }]),
      stage('build', [{ event: 'build-complete', to: 'verify' }, REQUIREMENTS_CHANGED]),
      stage('verify', [VERIFY_FAIL]),
    )
    const moved = reorderStagesInDef(def, 'verify', 'build', false)
    expect(edgesOf(moved)).toEqual({
      spec: [{ event: 'spec-complete', to: 'verify' }],
      verify: [{ event: 'verify-complete', to: 'build' }],
      build: [REQUIREMENTS_CHANGED],
    })
    expect(edgesOf(moved).build?.[0]).toBe(REQUIREMENTS_CHANGED)
    expectRelinked(moved)
  })

  it('移动中间阶段：正向边保留事件名改指新的下一阶段；变成往后指的退回边删掉，别的退回边保留', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }]),
      stage('b', [{ event: 'b-done', to: 'c' }]),
      stage('c', [{ event: 'c-done', to: 'd' }, { event: 'c-back', to: 'b' }]),
      stage('d', [{ ...VERIFY_FAIL, to: 'c' }, { ...REQUIREMENTS_CHANGED, to: 'a' }]),
    )
    const moved = reorderStagesInDef(def, 'b', 'c', true)
    expect(moved.steps.map((step) => step.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(edgesOf(moved)).toEqual({
      a: [{ event: 'a-done', to: 'c' }],
      c: [{ event: 'c-done', to: 'b' }],
      b: [{ event: 'b-done', to: 'd' }],
      d: [{ ...VERIFY_FAIL, to: 'c' }, { ...REQUIREMENTS_CHANGED, to: 'a' }],
    })
    expectRelinked(moved)
  })

  it('移动第一个阶段到末尾：指向它的退回边全部失效；原末阶段合成正向边，不与旧退回边同目标', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }]),
      stage('b', [{ event: 'b-done', to: 'c' }, { event: 'b-back', to: 'a' }]),
      stage('c', [{ event: 'c-back', to: 'a' }]),
    )
    const moved = reorderStagesInDef(def, 'a', 'c', true)
    expect(moved.steps.map((step) => step.id)).toEqual(['b', 'c', 'a'])
    expect(edgesOf(moved)).toEqual({
      b: [{ event: 'b-done', to: 'c' }],
      c: [{ event: 'c-complete', to: 'a' }],
      a: [],
    })
    expectRelinked(moved)
  })

  it('往后跳的边在排序后成了去下一阶段的边也不留：正向边只有一条', () => {
    const def = pipeline(
      stage('a', [{ event: 'a-done', to: 'b' }, { event: 'a-skip', to: 'c' }]),
      stage('b', [{ event: 'b-done', to: 'c' }]),
      stage('c'),
    )
    const moved = reorderStagesInDef(def, 'b', 'c', true)
    expect(edgesOf(moved)).toEqual({ a: [{ event: 'a-done', to: 'c' }], c: [{ event: 'c-complete', to: 'b' }], b: [] })
    expectRelinked(moved)
  })
})

describe('workbenchDefinition · 排序与删阶段丢掉的退回边', () => {
  const governedLike = (): WbWorkflowDef => pipeline(
    stage('spec', [{ event: 'spec-complete', to: 'build' }]),
    stage('build', [{ event: 'build-complete', to: 'verify' }, REQUIREMENTS_CHANGED]),
    stage('verify', [VERIFY_FAIL]),
  )

  it('拖走再拖回：丢掉的 verify-fail 被报出来，作为模板重新选回时整条装回', () => {
    const def = governedLike()
    const moved = reorderStagesInDef(def, 'verify', 'build', false)
    const displaced = displacedBackTransitions(def, moved)
    expect([...displaced]).toEqual([['verify', VERIFY_FAIL]])
    const back = reorderStagesInDef(moved, 'verify', 'build', true)
    expect(back.steps.map((step) => step.id)).toEqual(['spec', 'build', 'verify'])
    expect(backTransitionOf(back, 'verify')).toBeNull()
    const restored = setStageBackInDef(back, 'verify', 'build', displaced.get('verify'))
    expect(backTransitionOf(restored, 'verify')).toEqual(VERIFY_FAIL)
    expectRelinked(restored)
  })

  it('删掉退回目标、改指后成了自指：丢掉的边被报出来；退回边还在的阶段与被删阶段不报', () => {
    const def = governedLike()
    const removed = removeStageFromDef(def, 'build')
    expect([...displacedBackTransitions(def, removed)]).toEqual([['verify', VERIFY_FAIL]])
    // 删 spec：build 的 requirements-changed 改指自己被删；verify-fail 仍指向更早的 build，不报。
    const withoutSpec = removeStageFromDef(def, 'spec')
    expect([...displacedBackTransitions(def, withoutSpec)]).toEqual([['build', REQUIREMENTS_CHANGED]])
    expect(backTransitionOf(withoutSpec, 'verify')).toEqual(VERIFY_FAIL)
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
