import { describe, expect, it } from 'vitest'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { decodeHistory } from './governanceDecoders'
import { decodeSnapshot } from './snapshotDecoder'
import { decodeCurrentUser } from './userClient'

const ann = { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' }

function rawSnapshot(mutate: (change: Record<string, unknown>) => void): unknown {
  const body = JSON.parse(JSON.stringify(makeSnapshot([makeProject('/repo', [makeChange('a', 'build')])]))) as {
    projects: Array<{ changes: Array<Record<string, unknown>> }>
  }
  const change = body.projects[0]?.changes[0]
  if (change !== undefined) mutate(change)
  return body
}

function decodedChange(mutate: (change: Record<string, unknown>) => void) {
  return decodeSnapshot(rawSnapshot(mutate))?.projects[0]?.changes.find((change) => change.name === 'a')
}

describe('snapshot owner / creator', () => {
  it('accepts null and an exact {id,name,slug}', () => {
    expect(decodedChange(() => undefined)?.owner).toBeNull()
    expect(decodedChange((change) => { change.owner = ann; change.creator = ann })).toMatchObject({ owner: ann, creator: ann })
  })

  it('rejects a change whose owner key is missing or malformed', () => {
    expect(decodedChange((change) => { delete change.owner })).toBeUndefined()
    expect(decodedChange((change) => { change.creator = { id: 'ann@x.io', name: 'Ann' } })).toBeUndefined()
  })

  it('keeps a document timeline actor', () => {
    const decoded = decodedChange((change) => {
      change.documents = {
        governed: true, blockers: [],
        items: [{ kind: 'proposal', status: 'recorded', requiredRead: false, paths: ['p.md'], producers: ['openspec-propose'], timeline: [{ producer: 'openspec-propose', recordedAt: 't', actor: { id: 'ann@x.io', name: 'Ann' } }] }],
      }
    })
    expect(decoded?.documents?.items[0]?.timeline?.[0]?.actor).toEqual({ id: 'ann@x.io', name: 'Ann' })
  })
})

describe('/api/user body', () => {
  it('decodes a set user, a missing user and rejects other shapes', () => {
    expect(decodeCurrentUser({ ok: true, user: { ...ann, source: 'git', trust: 'declared' } })).toEqual({ kind: 'set', user: { ...ann, source: 'git' } })
    expect(decodeCurrentUser({ ok: true, user: null })).toEqual({ kind: 'missing' })
    expect(decodeCurrentUser({ ok: true, user: null, invalid: 'config' })).toEqual({ kind: 'missing', invalid: 'config' })
    expect(decodeCurrentUser({ ok: true, user: null, invalid: 'nope' })).toBeNull()
    expect(decodeCurrentUser({ ok: true, user: { ...ann, source: 'ldap' } })).toBeNull()
  })
})

describe('history actor', () => {
  it('keeps a declared actor and rejects a malformed one', () => {
    const actor = { id: 'ann@x.io', name: 'Ann', trust: 'declared' }
    expect(decodeHistory({ entries: [{ ts: 't', kind: 'init', actor }] })).toEqual([{ ts: 't', kind: 'init', actor }])
    expect(decodeHistory({ entries: [{ ts: 't', kind: 'init', actor: { id: 'ann@x.io', name: 'Ann', trust: 'human' } }] })).toBeNull()
  })
})
