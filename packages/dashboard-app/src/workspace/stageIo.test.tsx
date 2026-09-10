import { describe, expect, it } from 'vitest'
import type { WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot } from '../types'
import { readableFiles, stageInputs, stageOutputs } from './stageIo'

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
    { kind: 'document', id: 'proposal', producers: [], consumers: [], locked: true },
    { kind: 'document', id: 'tasks', producers: [], consumers: [], locked: true },
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
})
