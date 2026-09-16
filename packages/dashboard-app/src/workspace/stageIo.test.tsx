import { describe, expect, it } from 'vitest'
import type { WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot } from '../types'
import { gateProgress, readableFiles, skillsFromRuns, stageInputs, stageOutputs, type IoRow } from './stageIo'

const change = {
  name: 'demo',
  phase: 'spec',
  archived: 'false',
  fields: { plan: 'docs/plan.md', design_doc: '', build_sha: 'null' },
  documents: {
    governed: true,
    blockers: [],
    items: [
      { kind: 'proposal', status: 'recorded', requiredRead: true, paths: ['openspec/changes/demo/proposal.md'], producers: ['tenon-explore'], timeline: [{ producer: 'tenon-explore', recordedAt: '2026-09-10T01:02:00Z' }] },
      { kind: 'tasks', status: 'missing', requiredRead: false, paths: [], producers: [] },
    ],
  },
  workflowRules: { executionModel: 'phase-manifest', steps: [], transitions: {}, gateByStep: {}, labelByStep: {}, outputsByStep: {} },
  workflowExecution: { readinessByTransition: {} },
} as unknown as ChangeSnapshot

const io: WbStepIo = {
  outputs: [
    { kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: [], consumers: [] },
    { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: [], consumers: [] },
    { kind: 'field', id: 'plan', type: 'file_path', producer: null, consumers: [] },
    { kind: 'field', id: 'build_sha', type: 'string', producer: null, consumers: [] },
  ],
  inputs: [{ kind: 'field', id: 'design_doc', type: 'file_path', producer: 'explore', consumers: [] }],
}

describe('stageOutputs / stageInputs', () => {
  it('文档槽位取台账状态、路径、最近产出者与时间', () => {
    const rows = stageOutputs(change, io)
    expect(rows[0]).toMatchObject({ status: 'recorded', path: 'openspec/changes/demo/proposal.md', producer: 'tenon-explore', at: '2026-09-10T01:02:00Z' })
    expect(rows[1]).toMatchObject({ status: 'missing', path: null, producer: null })
  })
  it('值槽位：file_path 有值可读；空 / null 为未设', () => {
    const rows = stageOutputs(change, io)
    expect(rows[2]).toMatchObject({ status: 'set', path: 'docs/plan.md' })
    expect(rows[3]).toMatchObject({ status: 'unset', path: null, value: '' })
    expect(stageInputs(change, io)[0]).toMatchObject({ status: 'unset', path: null })
  })
  it('readableFiles 只收可读路径并去重', () => {
    const rows = [...stageOutputs(change, io), ...stageOutputs(change, io)]
    expect(readableFiles(rows).map((file) => file.path)).toEqual(['openspec/changes/demo/proposal.md', 'docs/plan.md'])
  })
  it('无物化 IO → 空列表', () => {
    expect(stageOutputs(change, undefined)).toEqual([])
  })
  it('缺失行带上应产出的技能：契约候选 ∩ 本阶段技能，没命中就用契约候选；输入侧与值槽位为空', () => {
    const documents: WbStepIo = {
      outputs: [{ kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose', 'opsx:propose'], consumers: [] }],
      inputs: [{ kind: 'document', id: 'proposal', role: 'read', scope: 'change', producers: ['open'], consumers: [] }],
    }
    expect(stageOutputs(change, documents, ['tenon-open', 'openspec-propose'])[0]?.producers).toEqual(['openspec-propose'])
    expect(stageOutputs(change, documents, ['tenon-open'])[0]?.producers).toEqual(['openspec-propose', 'opsx:propose'])
    expect(stageInputs(change, documents)[0]?.producers).toEqual([])
    expect(stageOutputs(change, io)[2]?.producers).toEqual([])
  })
  it('过期原因原样带到行上；其它状态为 null', () => {
    const stale = {
      ...change,
      documents: { governed: true, blockers: [], items: [{ kind: 'proposal', status: 'stale', reason: 'changed', requiredRead: true, paths: ['openspec/changes/demo/proposal.md'], producers: [] }] },
    } as unknown as ChangeSnapshot
    expect(stageOutputs(stale, io)[0]).toMatchObject({ status: 'stale', reason: 'changed' })
    expect(stageOutputs(change, io)[0]?.reason).toBeNull()
  })
})

describe('gateProgress', () => {
  const row = (status: IoRow['status']): IoRow => ({
    slot: { kind: 'field', id: 'x', type: 'string', producer: null, consumers: [] },
    status, path: null, value: '', producer: null, at: null, reason: null, producers: [],
  })

  it('auto 数输出齐全；review 多一条人工确认；没有门禁或零条件 → null', () => {
    expect(gateProgress('auto', [row('set'), row('unset')], false)).toEqual({ gate: 'auto', done: 1, total: 2 })
    expect(gateProgress('review', [row('recorded'), row('missing')], false)).toEqual({ gate: 'review', done: 1, total: 3 })
    expect(gateProgress('review', [row('recorded'), row('missing')], true)).toEqual({ gate: 'review', done: 2, total: 3 })
    expect(gateProgress('review', [], true)).toEqual({ gate: 'review', done: 1, total: 1 })
    expect(gateProgress(null, [row('set')], true)).toBeNull()
    expect(gateProgress('auto', [], true)).toBeNull()
  })
})

describe('skillsFromRuns', () => {
  it('按波次还原列模型：第 k 波依赖第 k-1 波全部技能；无快照为空', () => {
    expect(skillsFromRuns(undefined)).toEqual([])
    expect(skillsFromRuns({ stepId: 'verify', skills: [{ id: 'tenon-verify', status: 'done', wave: 0 }, { id: 'browser-qa', status: 'running', wave: 1 }, { id: 'e2e-testing', status: 'idle', wave: 1 }] }))
      .toEqual([{ id: 'tenon-verify' }, { id: 'browser-qa', depends_on: ['tenon-verify'] }, { id: 'e2e-testing', depends_on: ['tenon-verify'] }])
  })
})
