import { describe, expect, it } from 'vitest'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { UserRefView } from '../types'
import { DEFAULT_TASK_FILTER, facetTotal, filterRows, rowsOf, taskFacets } from './taskModel'

const ann: UserRefView = { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' }
const bob: UserRefView = { id: 'bob@x.io', name: 'Bob', slug: 'bob-at-x.io' }

function rows(owners: ReadonlyArray<UserRefView | null>) {
  const changes = owners.map((owner, index) => makeChange(`c${index}`, 'build', { owner }))
  return rowsOf({ snapshot: makeSnapshot([makeProject('/repo', changes)]), currentRoot: '/repo', rulesByKey: new Map(), t: (key) => key })
}

describe('owner facet', () => {
  it('counts tasks per owner, keyed by slug, and filters by the chosen owner', () => {
    const all = rows([ann, bob, ann, null])
    expect(taskFacets(all, DEFAULT_TASK_FILTER).owners).toEqual([
      { id: 'ann-at-x.io', label: 'Ann', count: 2 },
      { id: 'bob-at-x.io', label: 'Bob', count: 1 },
    ])
    expect(facetTotal(all, DEFAULT_TASK_FILTER, 'owner')).toBe(4)
    expect(filterRows(all, { ...DEFAULT_TASK_FILTER, owner: 'ann-at-x.io' }).map((row) => row.change.name)).toEqual(['c0', 'c2'])
  })

  it('owner counts respect the other facets; an owner change moves a task out of 我的', () => {
    const mine = { ...DEFAULT_TASK_FILTER, owner: 'ann-at-x.io' }
    expect(filterRows(rows([ann, bob]), mine).map((row) => row.change.name)).toEqual(['c0'])
    expect(filterRows(rows([bob, bob]), mine)).toEqual([])
    const tracked = rows([ann, ann])
    expect(taskFacets(tracked, { ...DEFAULT_TASK_FILTER, track: 'frontend' }).owners).toEqual([{ id: 'ann-at-x.io', label: 'Ann', count: 0 }])
  })
})
