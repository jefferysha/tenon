import { describe, expect, it } from 'vitest'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { EndedTask } from '../types'
import { endedCountOf, endedRowsOf, endedKey, resultOf } from './endedModel'
import { DEFAULT_TASK_FILTER, filterEnded, filterRows, statusCounts, taskFacets } from './taskFilter'
import { rowsOf } from './taskModel'

function task(name: string, endedAt: string, over: Partial<EndedTask> = {}): EndedTask {
  return { name, workflow: 'default', track: 'lite', result: 'finished', endedAt, archivedDir: `openspec/changes/archive/2026-10-11-${name}`, ...over }
}

const tr = (key: string): string => key

const SNAPSHOT = makeSnapshot([
  makeProject('/repo', [makeChange('live', 'build'), makeChange('wrapped', 'archive', { archived: 'true' })], {
    ended: [
      task('older', '2026-10-09T00:00:00Z'),
      task('newest', '2026-10-11T09:00:00Z', { result: 'terminated' }),
      task('mid', '2026-10-10T00:00:00Z', { result: 'escalated', workflow: 'design-system', track: '' }),
    ],
  }),
  makeProject('/other', [], { ended: [task('elsewhere', '2026-10-10T12:00:00Z', { result: 'unknown' })] }),
])

function endedOf(currentRoot: string) {
  return endedRowsOf({ snapshot: SNAPSHOT, currentRoot })
}

describe('endedRowsOf', () => {
  it('按结束时间倒序，跨项目也一起排', () => {
    expect(endedOf('').map((row) => row.task.name)).toEqual(['newest', 'elsewhere', 'mid', 'older'])
  })

  it('只取当前项目；没有选项目时取全部可读项目', () => {
    expect(endedOf('/repo').map((row) => row.task.name)).toEqual(['newest', 'mid', 'older'])
    expect(endedOf('/nowhere')).toEqual([])
    expect(endedRowsOf({ snapshot: null, currentRoot: '' })).toEqual([])
  })

  it('行的身份是归档目录名；key 与 URL 引用都不会和同名的活跃任务相撞', () => {
    const [row] = endedOf('/repo')
    expect(row?.dir).toBe('2026-10-11-newest')
    expect(row?.key).toBe(endedKey('/repo', '2026-10-11-newest'))
    expect(row?.key).not.toBe('newest@/repo')
  })

  it('旧归档没有结果字段（unknown）按「完结」算', () => {
    expect(resultOf(task('x', 'now', { result: 'unknown' }))).toBe('finished')
    expect(resultOf(task('x', 'now', { result: 'terminated' }))).toBe('terminated')
    expect(resultOf(task('x', 'now', { result: 'escalated' }))).toBe('escalated')
  })

  it('不可读的项目（ok:false）不出现', () => {
    const broken = makeSnapshot([makeProject('/gone', [], { ok: false, ended: [task('ghost', 'now')] })])
    expect(endedRowsOf({ snapshot: broken, currentRoot: '' })).toEqual([])
  })
})

describe('endedCountOf', () => {
  it('列出 N、共 M：只有快照带 endedTotal（被截断）时 M 才大于 N', () => {
    expect(endedCountOf(SNAPSHOT, '/repo')).toEqual({ shown: 3, total: 3 })
    const truncated = makeSnapshot([
      makeProject('/repo', [], { ended: [task('a', '2026-10-11T00:00:00Z'), task('b', '2026-10-10T00:00:00Z')], endedTotal: 1203 }),
      makeProject('/other', [], { ended: [task('c', '2026-10-09T00:00:00Z')] }),
    ])
    expect(endedCountOf(truncated, '')).toEqual({ shown: 3, total: 1204 })
    expect(endedCountOf(truncated, '/other')).toEqual({ shown: 1, total: 1 })
    expect(endedCountOf(null, '')).toEqual({ shown: 0, total: 0 })
  })
})

describe('已结束 in the status filter', () => {
  const rows = rowsOf({ snapshot: SNAPSHOT, currentRoot: '/repo', rulesByKey: new Map(), t: tr })
  const ended = endedOf('/repo')

  it('「已结束」计数 = 归档任务 + 已完结但还没移走的活跃任务；全部包含它们', () => {
    expect(statusCounts(rows, DEFAULT_TASK_FILTER, ended)).toEqual({ all: 5, 'needs-you': 0, running: 1, ended: 4 })
  })

  it('选「已结束」时活跃列表只剩已完结的行，归档任务全部列出', () => {
    const filter = { ...DEFAULT_TASK_FILTER, status: 'ended' as const }
    expect(filterRows(rows, filter).map((row) => row.change.name)).toEqual(['wrapped'])
    expect(filterEnded(ended, filter).map((row) => row.task.name)).toEqual(['newest', 'mid', 'older'])
    const running = { ...DEFAULT_TASK_FILTER, status: 'running' as const }
    expect(filterEnded(ended, running)).toEqual([])
  })

  it('工作流与轨道两层也作用于归档任务；负责人与阶段无从判断，选了就不列出', () => {
    expect(filterEnded(ended, { ...DEFAULT_TASK_FILTER, workflow: 'design-system' }).map((row) => row.task.name)).toEqual(['mid'])
    expect(filterEnded(ended, { ...DEFAULT_TASK_FILTER, track: 'lite' }).map((row) => row.task.name)).toEqual(['newest', 'older'])
    expect(filterEnded(ended, { ...DEFAULT_TASK_FILTER, owner: 'ann' })).toEqual([])
    expect(filterEnded(ended, { ...DEFAULT_TASK_FILTER, stage: 'build' })).toEqual([])
  })

  it('工作流 / 轨道候选也算上归档任务，计数受其它层约束', () => {
    const facets = taskFacets(rows, DEFAULT_TASK_FILTER, ended)
    expect(facets.workflows.map((chip) => [chip.id, chip.count])).toEqual([['default', 4], ['design-system', 1]])
    expect(facets.tracks.map((chip) => [chip.id, chip.count])).toEqual([['backend', 2], ['lite', 2]])
    const running = taskFacets(rows, { ...DEFAULT_TASK_FILTER, status: 'running' }, ended)
    expect(running.workflows.map((chip) => [chip.id, chip.count])).toEqual([['default', 1], ['design-system', 0]])
  })
})
