import { describe, expect, it } from 'vitest'
import { decodeChangeOrchestration, decodeDefinitionOrchestration } from './workflowOrchestrationClient'

const entry = (extra: Record<string, unknown>) => ({ kind: 'test', id: 'kind:unit', label: 'unit', wave: 1, dependsOn: [], required: true, source: 'declared', ...extra })
const stage = (entries: unknown[]) => ({ id: 'build', label: '实现', gate: null, entries })
const definition = (entries: unknown[]) => ({ workflow: 'default', track: null, stages: [stage(entries)], returns: [], flows: [] })
const change = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ change: 'c', workflow: 'default', track: null, current: 'build', stages: [stage(entries)], returns: [], flows: [], ...extra })

describe('编排响应解码 · 策略要求运行的测试种类', () => {
  it('测试节点可带 testKind；未知种类或非测试节点带 testKind 一律拒绝', () => {
    expect(decodeDefinitionOrchestration(definition([entry({ testKind: 'unit' })]))?.stages[0]?.entries[0]).toMatchObject({ kind: 'test', testKind: 'unit' })
    expect(decodeDefinitionOrchestration(definition([entry({})]))?.stages[0]?.entries[0]).not.toHaveProperty('testKind')
    expect(decodeDefinitionOrchestration(definition([entry({ testKind: 'nope' })]))).toBeNull()
    expect(decodeDefinitionOrchestration(definition([entry({ kind: 'skill', testKind: 'unit' })]))).toBeNull()
  })

  it('定义编排没有 manifest 叠加层：响应里不带 overlay 照常解码，解码结果也不含它', () => {
    const decoded = decodeDefinitionOrchestration({ ...definition([entry({})]), overlay: { build: ['x'] } })
    expect(decoded).not.toBeNull()
    expect(decoded).not.toHaveProperty('overlay')
  })

  it('任务编排的状态多一个 stale（测试过期）', () => {
    const decoded = decodeChangeOrchestration(change([entry({ testKind: 'unit', status: 'stale' })]))
    expect(decoded?.stages[0]?.entries[0]).toMatchObject({ status: 'stale', testKind: 'unit' })
    expect(decodeChangeOrchestration(change([entry({ status: 'weird' })]))).toBeNull()
  })
})

describe('编排响应解码 · stepIo（每步真实的输入、输出与必须产出）', () => {
  const stepIo = {
    explore: {
      inputs: [],
      outputs: [
        { path: 'docs/specs/a-design.md', change: 'added', skill: 'brainstorming' },
        { path: 'src/a.ts', change: 'modified', skill: null },
        { path: 'old.md', change: 'deleted', skill: null },
      ],
      required: [{ path: 'docs/specs/*.md', produced: true }],
    },
    spec: {
      inputs: [{ path: 'docs/specs/a-design.md', skill: 'brainstorming', fromStep: 'explore', read: false }],
      outputs: [],
      required: [{ path: 'docs/plans/c-plan.md', produced: false }],
    },
  }

  const running = [entry({ status: 'done' })]

  it('输入、输出、必须产出原样解出；来源技能推断不出来是 null', () => {
    const decoded = decodeChangeOrchestration(change(running, { stepIo }))
    expect(decoded?.stepIo).toEqual(stepIo)
    expect(decoded?.stepIo.explore?.outputs[1]?.skill).toBeNull()
  })

  it('契约模式（旧任务）的文件没有变化类型，照样解出', () => {
    const legacy = { open: { inputs: [], outputs: [{ path: 'openspec/changes/c/proposal.md', skill: 'openspec-propose' }], required: [] } }
    const decoded = decodeChangeOrchestration(change(running, { stepIo: legacy }))
    expect(decoded?.stepIo.open?.outputs[0]).toEqual({ path: 'openspec/changes/c/proposal.md', skill: 'openspec-propose' })
    expect(decoded?.stepIo.open?.outputs[0]).not.toHaveProperty('change')
  })

  it('旧服务端没有 stepIo：解成空对象，任务详情照常显示', () => {
    expect(decodeChangeOrchestration(change(running))?.stepIo).toEqual({})
  })

  it('旧的 io 字段不再读；响应里带着也不出现在解码结果里', () => {
    const decoded = decodeChangeOrchestration(change(running, { io: { build: { inputs: [], outputs: [] } } }))
    expect(decoded).not.toBeNull()
    expect(decoded).not.toHaveProperty('io')
  })

  it('形状不符整份作废（走现有的错误路径），不猜', () => {
    const wrap = (override: Record<string, unknown>) => decodeChangeOrchestration(change(running, { stepIo: { explore: { inputs: [], outputs: [], required: [], ...override } } }))
    expect(wrap({})).not.toBeNull()
    expect(decodeChangeOrchestration(change(running, { stepIo: [] }))).toBeNull()
    expect(decodeChangeOrchestration(change(running, { stepIo: { explore: 'x' } }))).toBeNull()
    expect(wrap({ inputs: 'x' })).toBeNull()
    expect(wrap({ required: undefined })).toBeNull()
    expect(wrap({ outputs: [{ path: 3, skill: null }] })).toBeNull()
    expect(wrap({ outputs: [{ path: 'a.md', skill: null, change: 'renamed' }] })).toBeNull()
    expect(wrap({ outputs: [{ path: 'a.md' }] })).toBeNull()
    expect(wrap({ inputs: [{ path: 'a.md', skill: null, fromStep: 3 }] })).toBeNull()
    expect(wrap({ inputs: [{ path: 'a.md', skill: null, read: 'yes' }] })).toBeNull()
    expect(wrap({ required: [{ path: 'a.md' }] })).toBeNull()
    expect(wrap({ required: [{ path: 'a.md', produced: 1 }] })).toBeNull()
  })
})
