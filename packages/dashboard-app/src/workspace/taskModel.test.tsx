import { describe, expect, it } from 'vitest'
import type { WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot, Snapshot } from '../types'
import { zh } from '../i18n/translations'
import { DEFAULT_TASK_FILTER, facetTotal, filterRows, rowsOf, stagesOf, summaryOf, summaryText, taskFacets, type TaskRow } from './taskModel'

function t(key: string, vars: Record<string, string | number> = {}): string {
  let node: unknown = zh
  for (const part of key.split('.')) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined
  const text = typeof node === 'string' ? node : key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

const STEPS = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']

function change(over: Partial<ChangeSnapshot> & { fields?: Record<string, string> } = {}): ChangeSnapshot {
  return {
    name: 'demo',
    path: '/repo/openspec/changes/demo',
    phase: 'build',
    phase_status: 'pending',
    track: 'backend',
    preset: 'full',
    archived: 'false',
    updated_at: '2026-09-10T00:00:00Z',
    workflowPlanFingerprint: 'fp',
    workflowRules: {
      executionModel: 'phase-manifest',
      steps: STEPS,
      transitions: { build: [{ event: 'build-complete', to: 'verify' }, { event: 'requirements-changed', to: 'spec' }] },
      gateByStep: {},
      labelByStep: {},
      outputsByStep: {},
    },
    workflowExecution: { readinessByTransition: {} },
    owner: null,
    creator: null,
    ...over,
    fields: { workflow: 'default', build_sha: '', ...(over.fields ?? {}) },
  }
}

const BUILD_IO: WbStepIo = {
  inputs: [],
  outputs: [{ kind: 'field', id: 'build_sha', type: 'string', producer: null, consumers: ['verify'] }],
}
const OPEN_IO: WbStepIo = {
  inputs: [],
  outputs: [{ kind: 'document', id: 'proposal', producers: ['openspec-propose'], consumers: [], locked: true }],
}

describe('stagesOf', () => {
  it('按 phase 序号推 done / current / todo，todo 投影优先', () => {
    const stages = stagesOf(change(), undefined, t)
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo'])
    expect(stages[3]?.label).toBe('build')
    const projected = stagesOf(change({ todo: { hasTaskSource: true, stages: [{ id: 'spec', label: '规格', status: 'current', tasks: [] }] } }), undefined, t)
    expect(projected[2]?.status).toBe('current')
  })

  it('已归档的运行没有进行中的阶段：收尾阶段算完成，从未进入的阶段仍是 todo', () => {
    const stages = stagesOf(change({ phase: 'verify', archived: 'true' }), undefined, t)
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'todo', 'todo'])
  })
})

describe('summaryOf · 四级优先级', () => {
  it('当前阶段值输出未设 → 缺该槽位', () => {
    expect(summaryOf(change(), undefined, BUILD_IO)).toEqual({ kind: 'missing', slot: BUILD_IO.outputs[0] })
  })
  it('文档输出缺失 / 过期 → 缺文档；已登记则不算', () => {
    const c = change({ phase: 'open', documents: { governed: true, blockers: [], items: [{ kind: 'proposal', status: 'stale', requiredRead: false, paths: ['p.md'], producers: [] }] } })
    expect(summaryOf(c, undefined, OPEN_IO)).toMatchObject({ kind: 'missing', slot: { id: 'proposal' } })
    const ok = change({ phase: 'open', documents: { governed: true, blockers: [], items: [{ kind: 'proposal', status: 'recorded', requiredRead: false, paths: ['p.md'], producers: [] }] } })
    expect(summaryOf(ok, undefined, OPEN_IO)).toEqual({ kind: 'running' })
  })
  it('输出齐全 + 评审待确认 → review；转换就绪 → ready 指向前向边；否则 running', () => {
    const withSha = { fields: { build_sha: 'abc' } }
    expect(summaryOf(change({ ...withSha, reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'now' } }), undefined, BUILD_IO)).toEqual({ kind: 'review' })
    const ready = change({ ...withSha, workflowExecution: { readinessByTransition: { build: { 'build-complete': { ready: true, blockers: [] }, 'requirements-changed': { ready: true, blockers: [] } } } } })
    expect(summaryOf(ready, undefined, BUILD_IO)).toEqual({ kind: 'ready', to: 'verify' })
    expect(summaryOf(change(withSha), undefined, BUILD_IO)).toEqual({ kind: 'running' })
  })
  it('已归档恒为 archived；无物化 IO 时不判缺产出', () => {
    expect(summaryOf(change({ archived: 'true' }), undefined, BUILD_IO)).toEqual({ kind: 'archived' })
    expect(summaryOf(change(), undefined, undefined)).toEqual({ kind: 'running' })
  })
  it('summaryText 用阶段中文名与槽位中文名，不出现字段元数据', () => {
    const row: TaskRow = { key: 'k', root: '/repo', change: change(), rules: undefined, workflow: 'default', archived: false, owner: null, stages: [], summary: { kind: 'missing', slot: BUILD_IO.outputs[0] as never } }
    expect(summaryText(row, t)).toBe('build · 缺 build_sha')
    expect(summaryText({ ...row, summary: { kind: 'ready', to: 'verify' } }, t)).toBe('build · 可进入verify')
  })
})

describe('rowsOf / filterRows / taskFacets', () => {
  const customRules = {
    executionModel: 'step-graph' as const,
    steps: ['draft', 'done'],
    transitions: { draft: [{ event: 'go', to: 'done' }], done: [] },
    gateByStep: { draft: null, done: null },
    labelByStep: { draft: '起草', done: '完成' },
    outputsByStep: {},
  }
  const snapshot: Snapshot = {
    snapshot_protocol: 'tenon-snapshot/v2',
    version: '1',
    generated_at: 'now',
    project_count: 1,
    change_count: 4,
    projects: [{
      root: '/repo',
      ok: true,
      changes: [
        change({ name: 'a', phase: 'build', updated_at: '2026-09-01T00:00:00Z' }),
        change({ name: 'b', phase: 'spec', track: 'frontend', updated_at: '2026-09-02T00:00:00Z' }),
        change({ name: 'c', phase: 'archive', archived: 'true', updated_at: '2026-09-03T00:00:00Z' }),
        change({ name: 'd', phase: 'draft', workflowRules: customRules, updated_at: '2026-09-04T00:00:00Z', fields: { workflow: 'compact' } }),
      ],
    }],
  } as unknown as Snapshot
  const rows = rowsOf({ snapshot, currentRoot: '/repo', rulesByKey: new Map(), ioOf: () => ({ build: BUILD_IO }), t })

  it('活跃任务按更新时间倒序，已归档排最后', () => {
    expect(rows.map((row) => row.change.name)).toEqual(['d', 'b', 'a', 'c'])
  })
  it('工作流 / 轨道 / 阶段三层过滑与含已归档开关', () => {
    expect(filterRows(rows, DEFAULT_TASK_FILTER).map((row) => row.change.name)).toEqual(['d', 'b', 'a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default' }).map((row) => row.change.name)).toEqual(['b', 'a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default', track: 'frontend' }).map((row) => row.change.name)).toEqual(['b'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default', stage: 'build' }).map((row) => row.change.name)).toEqual(['a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, stage: 'build' }).map((row) => row.change.name)).toEqual(['a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, includeArchived: true })).toHaveLength(4)
  })
  it('facet：未选工作流时无阶段行；选定后阶段序取该工作流，计数受其它层约束', () => {
    const open = taskFacets(rows, DEFAULT_TASK_FILTER)
    expect(open.workflows.map((chip) => [chip.id, chip.count])).toEqual([['compact', 1], ['default', 2]])
    expect(open.tracks.map((chip) => [chip.id, chip.count])).toEqual([['backend', 2], ['frontend', 1]])
    expect(open.stages).toBeNull()
    // 只有一条工作流但多条轨道 → 阶段仍不可比；再选定一条轨道（或只剩一条）阶段行才出现
    const single = rows.filter((row) => row.workflow === 'default')
    expect(taskFacets(single, DEFAULT_TASK_FILTER).stages).toBeNull()
    expect(taskFacets(single, { ...DEFAULT_TASK_FILTER, track: 'backend' }).stages?.map((chip) => chip.id)).toEqual(STEPS)
    const compact = taskFacets(rows, { ...DEFAULT_TASK_FILTER, workflow: 'compact' })
    expect(compact.stages?.map((chip) => [chip.id, chip.label, chip.count])).toEqual([['draft', '起草', 1], ['done', '完成', 0]])
    const fe = taskFacets(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default', track: 'frontend' })
    expect(fe.stages?.map((chip) => chip.id)).toEqual(STEPS)
    expect(fe.stages?.find((chip) => chip.id === 'spec')?.count).toBe(1)
    expect(fe.stages?.find((chip) => chip.id === 'build')?.count).toBe(0)
    // 轨道计数忽略自身层：frontend 在 default 下仍计 1、backend 计 1
    expect(fe.tracks.map((chip) => [chip.id, chip.count])).toEqual([['backend', 1], ['frontend', 1]])
    expect(facetTotal(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default' }, 'workflow')).toBe(3)
  })
})
