import { describe, expect, it } from 'vitest'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { appendSkill, explicitSkillRefs, minimalSkillRefs, removeSkill, skillExecutionWaves, skillOrderSignature, wavesOf } from '../workbench/skillWaves'
import { draftEffectiveIo, lintWorkflow } from './lint'
import { backTargetOf, backTransitionOf, setStageBackInDef } from '../workbench/workbenchDefinition'
import { backEdgesFrom, linkedToNext, pipelineEdges } from './pipelineModel'

const DEF: WbWorkflowDef = {
  name: 'flow',
  steps: [
    { id: 'a', label: 'A', gate: null, skills: [], inputs: [], outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [], transitions: [{ event: 'a-done', to: 'b' }] },
    { id: 'b', label: 'B', gate: 'review', skills: [], inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [{ field: 'build_sha', type: 'string' }], guards: [], transitions: [{ event: 'b-done', to: 'c' }, { event: 'b-back', to: 'a' }] },
    { id: 'c', label: 'C', gate: null, skills: [], inputs: [{ field: 'plan', type: 'file_path' }], outputs: [], guards: [], transitions: [] },
  ],
}

describe('skillWaves · 画布与阶段技能的换算', () => {
  it('显式图的波次：未写依赖的节点在第 0 波', () => {
    expect(wavesOf([{ id: 's1' }, { id: 's2' }, { id: 's3', depends_on: ['s1', 's2'] }])).toEqual([['s1', 's2'], ['s3']])
    expect(skillExecutionWaves(['x'], {})).toEqual([['x']])
  })
  it('explicitSkillRefs：没写 depends_on = 前面全部（约简到上一个）；depends_on: [] = 并行根', () => {
    expect(explicitSkillRefs([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual([{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['b'] }])
    expect(wavesOf(explicitSkillRefs([{ id: 'a' }, { id: 'b', depends_on: [] }, { id: 'c' }]))).toEqual([['a', 'b'], ['c']])
  })
  it('minimalSkillRefs 与 explicitSkillRefs 互逆，顺序签名不变', () => {
    const drawn = [{ id: 'a' }, { id: 'b' }, { id: 'c', depends_on: ['a', 'b'] }, { id: 'd', depends_on: ['a', 'b'] }]
    const minimal = minimalSkillRefs(drawn)
    expect(minimal).toEqual([{ id: 'a' }, { id: 'b', depends_on: [] }, { id: 'c' }, { id: 'd', depends_on: ['a', 'b'] }])
    expect(wavesOf(explicitSkillRefs(minimal))).toEqual([['a', 'b'], ['c', 'd']])
    expect(skillOrderSignature(minimal)).toBe(skillOrderSignature(explicitSkillRefs(minimal)))
    expect(skillOrderSignature([{ id: 'a' }, { id: 'b' }])).not.toBe(skillOrderSignature([{ id: 'a' }, { id: 'b', depends_on: [] }]))
  })
  it('appendSkill / removeSkill', () => {
    expect(appendSkill([{ id: 'a' }], 'b')).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(appendSkill([{ id: 'a' }], 'a')).toEqual([{ id: 'a' }])
    expect(removeSkill([{ id: 'a' }, { id: 'b', depends_on: ['a'] }, { id: 'c', depends_on: ['a', 'b'] }], 'a'))
      .toEqual([{ id: 'b' }, { id: 'c', depends_on: ['b'] }])
  })
})

describe('pipelineModel', () => {
  it('前向边连线、回流边单列', () => {
    const edges = pipelineEdges(DEF.steps)
    expect(edges.forward.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['a>b', 'b>c'])
    expect(backEdgesFrom(edges, 'b')).toEqual([{ from: 'b', to: 'a', event: 'b-back' }])
    expect(linkedToNext(edges, 'a', 'b')).toBe(true)
    expect(linkedToNext(edges, 'c', undefined)).toBe(false)
  })
})

describe('lint / draftEffectiveIo / slotCatalog', () => {
  const io = draftEffectiveIo(DEF)
  it('草稿物化 IO：字段生产者 / 消费者按阶段序推导', () => {
    expect(io.a?.outputs).toEqual([{ kind: 'field', id: 'design_doc', type: 'file_path', producer: null, consumers: ['b'] }])
    expect(io.b?.inputs).toEqual([{ kind: 'field', id: 'design_doc', type: 'file_path', producer: 'a', consumers: [] }])
  })
  it('lint：开启 OpenSpec 时无输出阶段是警告，无上游的输入是错误', () => {
    expect(lintWorkflow({ ...DEF, openspec: true }, io)).toEqual([
      { kind: 'step-no-output', stepId: 'c', severity: 'warning' },
      { kind: 'input-not-upstream', stepId: 'c', field: 'plan', severity: 'error' },
    ])
    expect(lintWorkflow(DEF, io)).toEqual([
      { kind: 'input-not-upstream', stepId: 'c', field: 'plan', severity: 'error' },
    ])
  })
  it('lint 转移：事件名为空 / 本阶段内重名', () => {
    const def: WbWorkflowDef = {
      ...DEF,
      steps: DEF.steps.map((step) => step.id !== 'a' ? step : {
        ...step,
        transitions: [{ event: '', to: 'b' }, { event: 'dup', to: 'b' }, { event: 'dup', to: 'c' }],
      }),
    }
    const issues = lintWorkflow(def, draftEffectiveIo(def))
    expect(issues).toContainEqual({ kind: 'transition-empty-event', stepId: 'a', severity: 'error' })
    expect(issues).toContainEqual({ kind: 'transition-duplicate-event', stepId: 'a', event: 'dup', severity: 'error' })
  })
  it('lint 转移：受治理工作流缺必需去向才报，未受治理不报', () => {
    const steps = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].map((id, index, all) => ({
      id, label: id, gate: null, skills: [], inputs: [], outputs: [{ field: `${id}_out`, type: 'string' as const }], guards: [],
      transitions: all[index + 1] ? [{ event: `${id}-done`, to: all[index + 1]! }] : [],
    }))
    // 线性七阶段：缺两条回流 build→spec 与 verify→build。
    const governed: WbWorkflowDef = { name: 'default', openspec: true, steps }
    const issues = lintWorkflow(governed, draftEffectiveIo(governed))
    expect(issues).toContainEqual({ kind: 'transition-contract-required', stepId: 'build', to: 'spec', severity: 'error' })
    expect(issues).toContainEqual({ kind: 'transition-contract-required', stepId: 'verify', to: 'build', severity: 'error' })
    // 同样的形状换个名字、不接入 OpenSpec → 不管
    const free: WbWorkflowDef = { name: 'mine', steps }
    expect(lintWorkflow(free, draftEffectiveIo(free)).filter((issue) => issue.kind === 'transition-contract-required')).toEqual([])
  })
})

describe('阶段退回', () => {
  const WITH_ACTIONS: WbWorkflowDef = {
    ...DEF,
    steps: DEF.steps.map((step) => step.id !== 'b' ? step : {
      ...step,
      transitions: [{ event: 'b-done', to: 'c' }, { event: 'b-back', to: 'a', actions: [{ type: 'reset-pre-verify-review' }] }],
    }),
  }

  it('backTargetOf 只认指向靠前阶段的边；正向边不算退回', () => {
    expect(backTargetOf(DEF, 'b')).toBe('a')
    expect(backTargetOf(DEF, 'a')).toBeNull()
    expect(backTargetOf(DEF, 'c')).toBeNull()
  })

  it('改退回目标保留 event 与 actions，正向边不动', () => {
    const next = setStageBackInDef(WITH_ACTIONS, 'b', 'a')
    const b = next.steps.find((step) => step.id === 'b')
    expect(b?.transitions).toEqual([
      { event: 'b-done', to: 'c' },
      { event: 'b-back', to: 'a', actions: [{ type: 'reset-pre-verify-review' }] },
    ])
  })

  it('选不退回只删退回边，正向边留着', () => {
    const next = setStageBackInDef(WITH_ACTIONS, 'b', null)
    expect(next.steps.find((step) => step.id === 'b')?.transitions).toEqual([{ event: 'b-done', to: 'c' }])
  })

  it('本来没有退回边时新建一条，事件名合成 <id>-back', () => {
    const next = setStageBackInDef(DEF, 'c', 'a')
    expect(next.steps.find((step) => step.id === 'c')?.transitions).toEqual([{ event: 'c-back', to: 'a' }])
  })

  it('不退回再选回来：给了 template 就整条装回来，不把 b-back 降级成合成名、不丢 actions', () => {
    const removed = backTransitionOf(WITH_ACTIONS, 'b')
    expect(removed).toEqual({ event: 'b-back', to: 'a', actions: [{ type: 'reset-pre-verify-review' }] })
    const off = setStageBackInDef(WITH_ACTIONS, 'b', null)
    expect(backTransitionOf(off, 'b')).toBeNull()
    const on = setStageBackInDef(off, 'b', 'a', removed ?? undefined)
    expect(backTransitionOf(on, 'b')).toEqual({ event: 'b-back', to: 'a', actions: [{ type: 'reset-pre-verify-review' }] })
  })

  it('不给 template 的话就是新建：这正是修复前丢事件名和 actions 的路径', () => {
    const off = setStageBackInDef(WITH_ACTIONS, 'b', null)
    expect(backTransitionOf(setStageBackInDef(off, 'b', 'a'), 'b')).toEqual({ event: 'b-back', to: 'a' })
  })
})
