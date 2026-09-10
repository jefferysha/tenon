import { describe, expect, it } from 'vitest'
import type { WbStepIo } from '../api/governanceTypes'
import type { ChangeSnapshot, Snapshot } from '../types'
import { zh } from '../i18n/translations'
import { filterRows, rowsOf, stageChips, stagesOf, summaryOf, summaryText, type TaskRow } from './taskModel'

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
    expect(stages[3]?.label).toBe('实现')
    const projected = stagesOf(change({ todo: { hasTaskSource: true, stages: [{ id: 'spec', label: '规格', status: 'current', tasks: [] }] } }), undefined, t)
    expect(projected[2]?.status).toBe('current')
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
    const row: TaskRow = { key: 'k', root: '/repo', change: change(), rules: undefined, workflow: 'default', archived: false, stages: [], summary: { kind: 'missing', slot: BUILD_IO.outputs[0] as never } }
    expect(summaryText(row, t)).toBe('实现 · 缺 构建提交')
    expect(summaryText({ ...row, summary: { kind: 'ready', to: 'verify' } }, t)).toBe('实现 · 可进入验证')
  })
})

describe('rowsOf / filterRows / stageChips', () => {
  const snapshot: Snapshot = {
    snapshot_protocol: 'tenon-snapshot/v2',
    version: '1',
    generated_at: 'now',
    project_count: 1,
    change_count: 3,
    projects: [{
      root: '/repo',
      ok: true,
      changes: [
        change({ name: 'a', phase: 'build', updated_at: '2026-09-01T00:00:00Z' }),
        change({ name: 'b', phase: 'spec', updated_at: '2026-09-02T00:00:00Z' }),
        change({ name: 'c', phase: 'archive', archived: 'true', updated_at: '2026-09-03T00:00:00Z' }),
      ],
    }],
  } as unknown as Snapshot
  const rows = rowsOf({ snapshot, currentRoot: '/repo', rulesByKey: new Map(), ioOf: () => ({ build: BUILD_IO }), t })

  it('活跃任务按更新时间倒序，已归档排最后', () => {
    expect(rows.map((row) => row.change.name)).toEqual(['b', 'a', 'c'])
  })
  it('阶段筛选与含已归档开关', () => {
    expect(filterRows(rows, { stage: 'all', includeArchived: false }).map((row) => row.change.name)).toEqual(['b', 'a'])
    expect(filterRows(rows, { stage: 'build', includeArchived: false }).map((row) => row.change.name)).toEqual(['a'])
    expect(filterRows(rows, { stage: 'all', includeArchived: true })).toHaveLength(3)
  })
  it('阶段芯片按流水线顺序、只计当前阶段', () => {
    const chips = stageChips(rows, false)
    expect(chips.map((chip) => chip.id)).toEqual(STEPS)
    expect(chips.find((chip) => chip.id === 'spec')?.count).toBe(1)
    expect(chips.find((chip) => chip.id === 'archive')?.count).toBe(0)
    expect(stageChips(rows, true).find((chip) => chip.id === 'archive')?.count).toBe(1)
  })
})
