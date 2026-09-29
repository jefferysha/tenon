import { describe, expect, it } from 'vitest'
import { decodeChangeOrchestration, decodeDefinitionOrchestration } from './workflowOrchestrationClient'

const entry = (extra: Record<string, unknown>) => ({ kind: 'test', id: 'kind:unit', label: 'unit', wave: 1, dependsOn: [], required: true, source: 'declared', ...extra })
const stage = (entries: unknown[]) => ({ id: 'build', label: '实现', gate: null, entries })
const definition = (entries: unknown[]) => ({ workflow: 'default', track: null, overlay: {}, stages: [stage(entries)], returns: [], flows: [] })
const change = (entries: unknown[]) => ({ change: 'c', workflow: 'default', track: null, current: 'build', io: {}, stages: [stage(entries)], returns: [], flows: [] })

describe('编排响应解码 · 策略要求运行的测试种类', () => {
  it('测试节点可带 testKind；未知种类或非测试节点带 testKind 一律拒绝', () => {
    expect(decodeDefinitionOrchestration(definition([entry({ testKind: 'unit' })]))?.stages[0]?.entries[0]).toMatchObject({ kind: 'test', testKind: 'unit' })
    expect(decodeDefinitionOrchestration(definition([entry({})]))?.stages[0]?.entries[0]).not.toHaveProperty('testKind')
    expect(decodeDefinitionOrchestration(definition([entry({ testKind: 'nope' })]))).toBeNull()
    expect(decodeDefinitionOrchestration(definition([entry({ kind: 'skill', testKind: 'unit' })]))).toBeNull()
  })

  it('任务编排的状态多一个 stale（测试过期）', () => {
    const decoded = decodeChangeOrchestration(change([entry({ testKind: 'unit', status: 'stale' })]))
    expect(decoded?.stages[0]?.entries[0]).toMatchObject({ status: 'stale', testKind: 'unit' })
    expect(decodeChangeOrchestration(change([entry({ status: 'weird' })]))).toBeNull()
  })
})
