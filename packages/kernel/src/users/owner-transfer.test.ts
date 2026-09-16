import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHistoryWriter, createStateStore, HISTORY_FILE, readCurrentRunRevision } from '../state/index.js'
import type { StateStore } from '../types.js'
import { transferOwner } from './owner-transfer.js'

const A = { id: 'a@x.io', name: 'A', trust: 'declared' } as const
const B = { id: 'b@x.io', name: 'B', trust: 'declared' } as const
const C = { id: 'c@x.io', name: 'C', trust: 'declared' } as const

let repo: string
let store: StateStore
let changeDir: string
const deps = () => ({ store, history: createHistoryWriter(), clock: () => '2026-09-16T00:00:00Z' })

async function historyRows(): Promise<unknown[]> {
  const raw = await readFile(join(changeDir, HISTORY_FILE), 'utf8').catch(() => '')
  return raw.trim() === '' ? [] : raw.trim().split('\n').map((line) => JSON.parse(line) as unknown)
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-owner-'))
  store = createStateStore()
  changeDir = await store.init({
    repoRoot: repo, name: 'x', track: 'backend', reviewSeed: 'pending', preset: 'full', creator: A,
    clock: () => '2026-09-16T00:00:00Z',
  })
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('transferOwner', () => {
  it('take over writes assignee and one set history row with the actor', async () => {
    const result = await transferOwner(deps(), { changeDir, change: 'x', actor: B })
    expect(result).toEqual({
      kind: 'changed',
      from: { id: 'a@x.io', name: 'A', slug: 'a-at-x.io' },
      to: { id: 'b@x.io', name: 'B', slug: 'b-at-x.io' },
    })
    expect(await store.get(changeDir, 'assignee')).toBe('B <b@x.io>')
    expect(await store.get(changeDir, 'created_by')).toBe('A <a@x.io>')
    expect(await historyRows()).toEqual([
      { ts: '2026-09-16T00:00:00Z', kind: 'set', field: 'assignee', from: 'A <a@x.io>', to: 'B <b@x.io>', actor: B },
    ])
  })

  it('hand-over by a non-owner leaves state, revision and history unchanged', async () => {
    const before = await readCurrentRunRevision(changeDir)
    const result = await transferOwner(deps(), { changeDir, change: 'x', actor: B, to: C })
    expect(result).toEqual({ kind: 'owner-required', owner: { id: 'a@x.io', name: 'A', slug: 'a-at-x.io' } })
    expect(await store.get(changeDir, 'assignee')).toBe('A <a@x.io>')
    expect((await readCurrentRunRevision(changeDir))?.revision).toBe(before?.revision)
    expect(await historyRows()).toEqual([])
  })

  it("the owner's take is unchanged with no row; the owner can hand over", async () => {
    expect(await transferOwner(deps(), { changeDir, change: 'x', actor: A })).toMatchObject({ kind: 'unchanged' })
    expect(await historyRows()).toEqual([])
    expect(await transferOwner(deps(), { changeDir, change: 'x', actor: A, to: C })).toMatchObject({ kind: 'changed' })
    expect(await store.get(changeDir, 'assignee')).toBe('C <c@x.io>')
  })
})
