import { describe, expect, it } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { countDraftChanges } from './draftChanges'

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
  effectiveIo: {},
}

function copy(): WbWorkflowDef {
  return JSON.parse(JSON.stringify(BASE)) as WbWorkflowDef
}

describe('countDraftChanges：「未保存 N 处」按阶段 / 轨道 / 工作流级字段计数', () => {
  it('没有改动、或只有读接口附带字段不同 → 0；任一边为 null → 0', () => {
    expect(countDraftChanges(BASE, copy())).toBe(0)
    expect(countDraftChanges(BASE, { ...BASE, source: 'builtin', effectiveIo: undefined })).toBe(0)
    expect(countDraftChanges(null, BASE)).toBe(0)
  })

  it('改名 + 换门禁在同一阶段算 1 处；另一轨道再改一处算 2 处', () => {
    const draft = copy()
    draft.tracks!.pm!.steps[0] = stage('a', { label: 'A', gate: 'review' })
    expect(countDraftChanges(BASE, draft)).toBe(1)
    draft.tracks!.be!.steps[0] = stage('x', { gate: 'auto' })
    expect(countDraftChanges(BASE, draft)).toBe(2)
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
})
