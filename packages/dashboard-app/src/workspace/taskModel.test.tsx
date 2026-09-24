import { describe, expect, it } from 'vitest'
import type { ChangeSnapshot, Snapshot } from '../types'
import { zh } from '../i18n/translations'
import { archivedRowsOf, DEFAULT_TASK_FILTER, facetTotal, filterRows, forwardExitOf, linearSteps, needsYouCount, rowsOf, stagesOf, statusCounts, statusOf, summaryOf, summaryShort, summaryText, taskFacets, uncommittedDeletionsOf, type TaskRow } from './taskModel'

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

const SKILL_BLOCKER = { kind: 'step-exit' as const, source: 'skill' as const, code: 'skill-incomplete', message: '尚未完成声明的 skill：tdd' }
const TASKS_BLOCKER = { kind: 'step-exit' as const, source: 'tasks' as const, code: 'tasks-incomplete', message: 'tasks.md 仍有 2 项未勾', items: ['a', 'b'] }
const BLOCKED = {
  readinessByTransition: {
    build: {
      'build-complete': { ready: false, blockers: [SKILL_BLOCKER, TASKS_BLOCKER] },
      'requirements-changed': { ready: false, blockers: [SKILL_BLOCKER] },
    },
  },
}

describe('stagesOf', () => {
  it('按 phase 序号推 done / current / todo，todo 投影优先', () => {
    const stages = stagesOf(change(), undefined, t)
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo'])
    expect(stages[3]?.label).toBe('build')
    const projected = stagesOf(change({ todo: { hasTaskSource: true, stages: [{ id: 'spec', label: '规格', status: 'current', tasks: [] }] } }), undefined, t)
    expect(projected[2]?.status).toBe('current')
  })

  it('已完结的运行没有进行中的阶段：收尾阶段算完成，从未进入的阶段仍是 todo', () => {
    const stages = stagesOf(change({ phase: 'verify', archived: 'true' }), undefined, t)
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'todo', 'todo'])
  })
})

describe('linearSteps', () => {
  it('第一个终点之后的旁路终点（simple 的 escalated）不作为线性阶段格', () => {
    const rules = {
      executionModel: 'step-graph' as const,
      steps: ['change', 'verify', 'done', 'escalated'],
      transitions: {
        change: [{ event: 'change-complete', to: 'verify' }, { event: 'scope-expanded', to: 'escalated' }],
        verify: [{ event: 'verify-pass', to: 'done' }, { event: 'scope-expanded', to: 'escalated' }],
        done: [{ event: 'archived', to: 'done' }],
        escalated: [{ event: 'archived', to: 'escalated' }],
      },
      gateByStep: {}, labelByStep: {}, outputsByStep: {},
    }
    expect(linearSteps(rules)).toEqual(['change', 'verify', 'done'])
    expect(stagesOf(change({ phase: 'verify', workflowRules: rules }), undefined, t).map((stage) => stage.id)).toEqual(['change', 'verify', 'done'])
  })
})

describe('summaryOf · 只读快照', () => {
  it('前进出口有阻断 → blocked，列出阻断最少的前进出口（退回边不参与）', () => {
    expect(summaryOf(change({ workflowExecution: BLOCKED }), undefined)).toEqual({
      kind: 'blocked',
      blockers: ['尚未完成声明的 skill：tdd', 'tasks.md 仍有 2 项未勾'],
    })
    expect(forwardExitOf(change({ workflowExecution: BLOCKED }), undefined)).toEqual({
      to: 'verify', ready: false, blockers: ['尚未完成声明的 skill：tdd', 'tasks.md 仍有 2 项未勾'],
    })
  })
  it('评审待确认 → review；前进出口就绪 → ready 指向前向边；没有 readiness → running', () => {
    expect(summaryOf(change({ reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'now' } }), undefined)).toEqual({ kind: 'review' })
    const ready = change({ workflowExecution: { readinessByTransition: { build: { 'build-complete': { ready: true, blockers: [] }, 'requirements-changed': { ready: true, blockers: [] } } } } })
    expect(summaryOf(ready, undefined)).toEqual({ kind: 'ready', to: 'verify' })
    expect(summaryOf(change(), undefined)).toEqual({ kind: 'running' })
  })
  it('已归档恒为 completed', () => {
    expect(summaryOf(change({ archived: 'true', workflowExecution: BLOCKED }), undefined)).toEqual({ kind: 'completed' })
  })
  it('summaryText 用阶段名，阻断写数量', () => {
    const row: TaskRow = { key: 'k', root: '/repo', change: change(), rules: undefined, workflow: 'default', archived: false, owner: null, stages: [], summary: { kind: 'blocked', blockers: ['x', 'y'] } }
    expect(summaryText(row, t)).toBe('build · 阻塞 2')
    expect(summaryText({ ...row, summary: { kind: 'ready', to: 'verify' } }, t)).toBe('build · 可进入verify')
    // 详情页的状态行不重复阶段名（阶段轨已写明）。
    expect(summaryShort({ ...row, summary: { kind: 'ready', to: 'verify' } }, t)).toBe('可进入verify')
  })
  it('需要你只算评审待确认；阻断与可前进都由智能体继续，算进行中', () => {
    expect(statusOf({ kind: 'review' })).toBe('needs-you')
    expect(statusOf({ kind: 'ready', to: 'verify' })).toBe('running')
    expect(statusOf({ kind: 'blocked', blockers: ['x'] })).toBe('running')
    expect(statusOf({ kind: 'running' })).toBe('running')
    expect(statusOf({ kind: 'completed' })).toBe('done')
  })
  it('所有项目与单项目视图对同一任务给出同一状态与同一「需要你」计数', () => {
    const snap = {
      projects: [
        { root: '/a', ok: true, changes: [change({ name: 'x', workflowExecution: BLOCKED }), change({ name: 'y', reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'now' } })] },
        { root: '/b', ok: true, changes: [change({ name: 'z', reviewHandshake: { status: 'pending', event: 'build-complete', requestedAt: 'now' } })] },
      ],
    } as unknown as Snapshot
    const all = rowsOf({ snapshot: snap, currentRoot: '', rulesByKey: new Map(), t })
    const one = rowsOf({ snapshot: snap, currentRoot: '/a', rulesByKey: new Map(), t })
    for (const row of one) expect(all.find((candidate) => candidate.key === row.key)?.summary).toEqual(row.summary)
    expect(needsYouCount({ snapshot: snap, currentRoot: '/a', rulesByKey: new Map(), t })).toBe(1)
    expect(needsYouCount({ snapshot: snap, currentRoot: '', rulesByKey: new Map(), t })).toBe(2)
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
  const rows = rowsOf({ snapshot, currentRoot: '/repo', rulesByKey: new Map(), t })

  it('活跃任务按更新时间倒序，已归档排最后', () => {
    expect(rows.map((row) => row.change.name)).toEqual(['d', 'b', 'a', 'c'])
  })
  it('状态 / 工作流 / 轨道 / 阶段逐层过滤；「全部」含已完结，已完结只在「已完成」里单独出现', () => {
    expect(filterRows(rows, DEFAULT_TASK_FILTER).map((row) => row.change.name)).toEqual(['d', 'b', 'a', 'c'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, status: 'done' }).map((row) => row.change.name)).toEqual(['c'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, status: 'running' }).map((row) => row.change.name)).toEqual(['d', 'b', 'a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default' }).map((row) => row.change.name)).toEqual(['b', 'a', 'c'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default', track: 'frontend' }).map((row) => row.change.name)).toEqual(['b'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, workflow: 'default', stage: 'build' }).map((row) => row.change.name)).toEqual(['a'])
    expect(filterRows(rows, { ...DEFAULT_TASK_FILTER, stage: 'build' }).map((row) => row.change.name)).toEqual(['a'])
    expect(statusCounts(rows, DEFAULT_TASK_FILTER)).toEqual({ all: 4, 'needs-you': 0, running: 3, done: 1 })
    // 状态计数受其它维度约束，忽略状态本身。
    expect(statusCounts(rows, { ...DEFAULT_TASK_FILTER, status: 'done', workflow: 'compact' })).toEqual({ all: 1, 'needs-you': 0, running: 1, done: 0 })
  })
  it('facet：未选工作流时无阶段行；选定后阶段序取该工作流，计数受其它层约束', () => {
    const running = { ...DEFAULT_TASK_FILTER, status: 'running' as const }
    const open = taskFacets(rows, running)
    expect(open.workflows.map((chip) => [chip.id, chip.count])).toEqual([['compact', 1], ['default', 2]])
    expect(open.tracks.map((chip) => [chip.id, chip.count])).toEqual([['backend', 2], ['frontend', 1]])
    expect(open.stages).toBeNull()
    // 只有一条工作流但多条轨道 → 阶段仍不可比；再选定一条轨道（或只剩一条）阶段行才出现
    const single = rows.filter((row) => row.workflow === 'default')
    expect(taskFacets(single, running).stages).toBeNull()
    expect(taskFacets(single, { ...running, track: 'backend' }).stages?.map((chip) => chip.id)).toEqual(STEPS)
    const compact = taskFacets(rows, { ...running, workflow: 'compact' })
    expect(compact.stages?.map((chip) => [chip.id, chip.label, chip.count])).toEqual([['draft', '起草', 1], ['done', '完成', 0]])
    const fe = taskFacets(rows, { ...running, workflow: 'default', track: 'frontend' })
    expect(fe.stages?.map((chip) => chip.id)).toEqual(STEPS)
    expect(fe.stages?.find((chip) => chip.id === 'spec')?.count).toBe(1)
    expect(fe.stages?.find((chip) => chip.id === 'build')?.count).toBe(0)
    // 轨道计数忽略自身层：frontend 在 default 下仍计 1、backend 计 1
    expect(fe.tracks.map((chip) => [chip.id, chip.count])).toEqual([['backend', 1], ['frontend', 1]])
    expect(facetTotal(rows, { ...running, workflow: 'default' }, 'workflow')).toBe(3)
  })
})

describe('archivedRowsOf / uncommittedDeletionsOf', () => {
  const archivedSnapshot = {
    projects: [{
      root: '/repo',
      ok: true,
      changes: [change({ name: 'shown' })],
      archived: [
        { ...change({ name: 'older', phase: 'spec' }), archive: { archivedAt: '2026-09-14T00:00:00Z', phase: 'spec', actor: { id: 'a@x.io', name: 'A', trust: 'declared' } } },
        { ...change({ name: 'newer', phase: 'build' }), archive: { archivedAt: '2026-09-15T00:00:00Z', phase: 'build', actor: { id: 'b@x.io', name: 'B', trust: 'declared' } } },
      ],
      uncommittedDeletions: 2,
    }],
  } as unknown as Snapshot

  it('lists archived rows newest first with the phase, time and actor of the archive', () => {
    const rows = archivedRowsOf({ snapshot: archivedSnapshot, currentRoot: '/repo', rulesByKey: new Map(), t })
    expect(rows.map((row) => row.change.name)).toEqual(['newer', 'older'])
    expect(rows[0]?.archive).toEqual({ archivedAt: '2026-09-15T00:00:00Z', phase: 'build', actor: { id: 'b@x.io', name: 'B', trust: 'declared' } })
    expect(rows[0]?.stages.map((stage) => stage.status))
      .toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo'])
    expect(rows.every((row) => row.key.endsWith('@/repo'))).toBe(true)
  })

  // 归档只是对我隐藏：归档前有阻断的任务，归档后仍是同一句，而不是编造的「进行中」。
  it('derives the same readiness as the live row instead of claiming 进行中', () => {
    const blocked = {
      projects: [{
        root: '/repo', ok: true, changes: [],
        archived: [{ ...change({ name: 'newer', workflowExecution: BLOCKED }), archive: { archivedAt: '2026-09-15T00:00:00Z', phase: 'build', actor: { id: 'b@x.io', name: 'B', trust: 'declared' } } }],
      }],
    } as unknown as Snapshot
    const rows = archivedRowsOf({ snapshot: blocked, currentRoot: '/repo', rulesByKey: new Map(), t })
    const newer = rows.find((row) => row.change.name === 'newer') as TaskRow
    expect(newer.summary.kind).toBe('blocked')
    expect(summaryText(newer, t)).toBe('build · 阻塞 2')
  })

  it('reports no archived rows when the server sends none', () => {
    const plain = { projects: [{ root: '/repo', ok: true, changes: [change()] }] } as unknown as Snapshot
    expect(archivedRowsOf({ snapshot: plain, currentRoot: '/repo', rulesByKey: new Map(), t })).toEqual([])
    expect(archivedRowsOf({ snapshot: null, currentRoot: '', rulesByKey: new Map(), t })).toEqual([])
  })

  it('sums 未提交删除 within the selected project only', () => {
    expect(uncommittedDeletionsOf(archivedSnapshot, '/repo')).toBe(2)
    expect(uncommittedDeletionsOf(archivedSnapshot, '/other')).toBe(0)
    expect(uncommittedDeletionsOf(archivedSnapshot, '')).toBe(2)
    expect(uncommittedDeletionsOf(null, '')).toBe(0)
  })
})

describe('已完结 wording', () => {
  it('summaryText reads 已完结 for a closed run', () => {
    const rows = rowsOf({
      snapshot: { projects: [{ root: '/repo', ok: true, changes: [change({ name: 'c', phase: 'archive', archived: 'true' })] }] } as unknown as Snapshot,
      currentRoot: '/repo', rulesByKey: new Map(), t,
    })
    expect(rows[0]?.summary).toEqual({ kind: 'completed' })
    expect(summaryText(rows[0] as TaskRow, t)).toBe('已完结')
  })
})
