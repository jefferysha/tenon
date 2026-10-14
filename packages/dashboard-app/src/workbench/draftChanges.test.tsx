import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { countDraftChanges } from './draftChanges'
import { setStepTestLevelInDef } from './workbenchDefinition'

function stage(id: string, extra: Partial<WbStepDef> = {}): WbStepDef {
  return { id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [], ...extra }
}

const BASE: WbWorkflowDef = {
  name: 'flow',
  steps: [],
  tracks: {
    pm: { label: '产品', steps: [stage('a'), stage('b'), stage('c')] },
    be: { label: '后端', steps: [stage('x')] },
  },
  source: 'global',
  branches: { _base: {}, pm: { label: '产品' } },
}

function copy(): WbWorkflowDef {
  return JSON.parse(JSON.stringify(BASE)) as WbWorkflowDef
}

describe('countDraftChanges：「未保存 N 处」按阶段 / 轨道 / 工作流级字段计数', () => {
  it('没有改动、或只有读接口附带字段不同 → 0；任一边为 null → 0', () => {
    expect(countDraftChanges(BASE, copy())).toBe(0)
    expect(countDraftChanges(BASE, { ...BASE, source: 'builtin', branches: undefined })).toBe(0)
    expect(countDraftChanges(null, BASE)).toBe(0)
  })

  it('改名 + 换门禁在同一阶段算 1 处；另一轨道再改一处算 2 处', () => {
    const draft = copy()
    draft.tracks!.pm!.steps[0] = stage('a', { label: 'A', gate: 'review' })
    expect(countDraftChanges(BASE, draft)).toBe(1)
    draft.tracks!.be!.steps[0] = stage('x', { gate: 'review' })
    expect(countDraftChanges(BASE, draft)).toBe(2)
  })

  it('gate null 与 auto 同义：null 改成 auto 不算改动，写回时统一是 auto', () => {
    const draft = copy()
    draft.tracks!.be!.steps[0] = stage('x', { gate: 'auto' })
    expect(countDraftChanges(BASE, draft)).toBe(0)
  })

  it('删一个阶段 = 1；只换顺序 = 1；新增轨道 = 1；工作流级开关 = 1', () => {
    const removed = copy()
    removed.tracks!.pm!.steps = [stage('a'), stage('c')]
    expect(countDraftChanges(BASE, removed)).toBe(1)
    const reordered = copy()
    reordered.tracks!.pm!.steps = [stage('b'), stage('a'), stage('c')]
    expect(countDraftChanges(BASE, reordered)).toBe(1)
    const added = copy()
    added.tracks!.fe = { label: '前端', steps: [stage('y')] }
    expect(countDraftChanges(BASE, added)).toBe(1)
    expect(countDraftChanges(BASE, { ...BASE, openspec: true })).toBe(1)
  })

  it('加阶段连带改写前一阶段的转移只算 1 处；删阶段同理', () => {
    const base: WbWorkflowDef = { name: 'flow', steps: [stage('a', { transitions: [{ event: 'a-complete', to: 'b' }] }), stage('b')] }
    const added: WbWorkflowDef = { name: 'flow', steps: [
      stage('a', { transitions: [{ event: 'a-complete', to: 'n' }] }),
      stage('n', { transitions: [{ event: 'n-complete', to: 'b' }] }),
      stage('b'),
    ] }
    expect(countDraftChanges(base, added)).toBe(1)
    expect(countDraftChanges(added, base)).toBe(1)
  })

  it('结构不变时改退回目标算在该阶段上；只是键顺序不同不算改动', () => {
    const base: WbWorkflowDef = { name: 'flow', steps: [stage('a', { transitions: [{ event: 'a-complete', to: 'b' }] }), stage('b')] }
    const back: WbWorkflowDef = { name: 'flow', steps: [stage('a', { transitions: [{ event: 'a-complete', to: 'b' }] }), stage('b', { transitions: [{ event: 'b-back', to: 'a' }] })] }
    expect(countDraftChanges(base, back)).toBe(1)
    const reordered = JSON.parse(JSON.stringify(base), (_key, value: unknown) => (
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse())
        : value
    )) as WbWorkflowDef
    expect(countDraftChanges(base, reordered)).toBe(0)
  })

  it('阶段里的必须产出、技能、测试策略的改动都记到所属阶段：同一阶段两处改动 = 1 处；OpenSpec 开关只算开关 1 处', () => {
    const base: WbWorkflowDef = { name: 'flow', openspec: true, steps: [stage('a'), stage('b')] }
    const edited: WbWorkflowDef = { ...base, steps: [
      stage('a', { guards: [{ type: 'required-output', path: 'docs/specs/*.md' }], skills: [{ id: 'brainstorming' }] }),
      stage('b'),
    ] }
    expect(countDraftChanges(base, edited)).toBe(1)
    expect(countDraftChanges(edited, { ...edited, steps: [edited.steps[0]!, stage('b', { gate: 'review' })] })).toBe(1)
    expect(countDraftChanges(base, { ...base, openspec: false })).toBe(1)
  })
})

describe('countDraftChanges · 轨道设置', () => {
  const governed: WbWorkflowDef = { ...BASE, openspec: true }

  it('改关键词 = 轨道 1 处；改规范 = 1 处', () => {
    const words = JSON.parse(JSON.stringify(governed)) as WbWorkflowDef
    words.tracks!.pm!.route = { keywords: ['产品'], exclude: [], priority: 100, fallback: false }
    expect(countDraftChanges(governed, words)).toBe(1)
    const none = JSON.parse(JSON.stringify(governed)) as WbWorkflowDef
    none.tracks!.pm!.spec = 'none'
    expect(countDraftChanges(governed, none)).toBe(1)
    none.tracks!.pm!.route = { keywords: ['产品'], exclude: [], priority: 100, fallback: false }
    expect(countDraftChanges(governed, none)).toBe(2)
  })

  it('同样的设置、只是键顺序不同不算改动', () => {
    const before = JSON.parse(JSON.stringify(governed)) as WbWorkflowDef
    before.tracks!.pm!.route = { keywords: ['a'], exclude: [], priority: 1, fallback: false }
    const after = JSON.parse(JSON.stringify(before)) as WbWorkflowDef
    after.tracks!.pm!.route = { fallback: false, priority: 1, exclude: [], keywords: ['a'] }
    expect(countDraftChanges(before, after)).toBe(0)
  })
})

describe('countDraftChanges · 测试档位', () => {
  it('改档位算所属阶段的 1 处，换档位仍是 1 处', () => {
    const flat: WbWorkflowDef = { name: 'flat', steps: [stage('s')] }
    const edited = setStepTestLevelInDef(flat, 's', 'changed')
    expect(countDraftChanges(flat, edited)).toBe(1)
    const twice = setStepTestLevelInDef(edited, 's', 'full')
    expect(countDraftChanges(edited, twice)).toBe(1)
    expect(countDraftChanges(flat, twice)).toBe(1)
  })

  it('选档替换旧策略也是 1 处；选回不要求的原状（没有声明）不产生草稿改动', () => {
    const flat: WbWorkflowDef = { name: 'flat', steps: [stage('s')] }
    expect(countDraftChanges(flat, setStepTestLevelInDef(flat, 's', 'none'))).toBe(0)
    const legacy: WbWorkflowDef = { name: 'flat', steps: [{ ...stage('s'), test_policy: { plan: 'required' } }] }
    expect(countDraftChanges(legacy, setStepTestLevelInDef(legacy, 's', 'plan'))).toBe(1)
  })
})
