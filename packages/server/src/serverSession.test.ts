import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_CODE_TTL_MS,
  MAX_OUTSTANDING_CODES,
  MAX_PRESENCE_PER_SESSION,
  MAX_SESSIONS,
  PRESENCE_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  createSessionAuthority,
  type PresenceBinding,
} from './serverSession.js'

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const binding: PresenceBinding = { root: '/repo', change: 'demo', ref: 'decision:abc', expectedRevision: 3 }

describe('one-time login codes', () => {
  it('are random, single-use and exchange for an unguessable session secret', () => {
    const authority = createSessionAuthority()
    const code = authority.mintCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authority.mintCode()).not.toBe(code)
    const secret = authority.exchange(code)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secret).not.toBe(code)
    expect(authority.exchange(code)).toBeNull()
  })

  it('expire after the TTL and reject unknown, empty and oversized values', () => {
    const time = clock()
    const authority = createSessionAuthority({ now: time.now })
    const late = authority.mintCode()
    time.advance(BOOTSTRAP_CODE_TTL_MS)
    expect(authority.exchange(late)).toBeNull()
    expect(authority.exchange('')).toBeNull()
    expect(authority.exchange('x'.repeat(500))).toBeNull()
    expect(authority.exchange('never-minted')).toBeNull()
  })

  it('a discarded code (delivery failed) can no longer be exchanged', () => {
    const authority = createSessionAuthority()
    const code = authority.mintCode()
    authority.discardCode(code)
    expect(authority.exchange(code)).toBeNull()
  })

  it('keeps only a bounded number of outstanding codes, dropping the oldest', () => {
    const authority = createSessionAuthority()
    const first = authority.mintCode()
    for (let i = 0; i < MAX_OUTSTANDING_CODES; i += 1) authority.mintCode()
    expect(authority.exchange(first)).toBeNull()
  })
})

describe('sessions', () => {
  it('resolve the secret, never the code, and refuse anything else', () => {
    const authority = createSessionAuthority()
    const code = authority.mintCode()
    const secret = authority.exchange(code)
    expect(secret).not.toBeNull()
    expect(authority.resolve(secret ?? '')).not.toBeNull()
    expect(authority.resolve(code)).toBeNull()
    expect(authority.resolve(undefined)).toBeNull()
    expect(authority.resolve('')).toBeNull()
    expect(authority.resolve('y'.repeat(500))).toBeNull()
  })

  it('expire after the idle window and after the absolute lifetime even if kept busy', () => {
    const time = clock()
    const authority = createSessionAuthority({ now: time.now })
    const idle = authority.exchange(authority.mintCode()) ?? ''
    time.advance(SESSION_IDLE_MS - 1)
    expect(authority.resolve(idle)).not.toBeNull()
    time.advance(SESSION_IDLE_MS - 1)
    expect(authority.resolve(idle)).not.toBeNull() // each use refreshes the idle timer
    time.advance(SESSION_IDLE_MS)
    expect(authority.resolve(idle)).toBeNull()

    const busy = authority.exchange(authority.mintCode()) ?? ''
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_MS; elapsed += SESSION_IDLE_MS / 2) {
      expect(authority.resolve(busy)).not.toBeNull()
      time.advance(SESSION_IDLE_MS / 2)
    }
    expect(authority.resolve(busy)).toBeNull()
  })

  it('caps the table and evicts the least recently used session', () => {
    const time = clock()
    const authority = createSessionAuthority({ now: time.now })
    const first = authority.exchange(authority.mintCode()) ?? ''
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      time.advance(1)
      authority.exchange(authority.mintCode())
    }
    expect(authority.sessionCount()).toBe(MAX_SESSIONS)
    expect(authority.resolve(first)).toBeNull()
  })
})

describe('presence nonces', () => {
  function session(authority = createSessionAuthority()) {
    const secret = authority.exchange(authority.mintCode()) ?? ''
    const info = authority.resolve(secret)
    if (info === null) throw new Error('no session')
    return { authority, info }
  }

  it('are single-use and bound to session, root, change, ref and revision', () => {
    const { authority, info } = session()
    const other = authority.resolve(authority.exchange(authority.mintCode()) ?? '')
    if (other === null) throw new Error('no second session')

    const nonce = authority.issuePresence(info, binding)
    expect(authority.consumePresence(other, binding, nonce)).toBe(false) // another session
    expect(authority.consumePresence(info, binding, nonce)).toBe(false) // the failed attempt burned it

    for (const tampered of [
      { ...binding, root: '/other' },
      { ...binding, change: 'other' },
      { ...binding, ref: 'decision:zzz' },
      { ...binding, expectedRevision: 4 },
    ]) {
      const fresh = authority.issuePresence(info, binding)
      expect(authority.consumePresence(info, tampered, fresh)).toBe(false)
    }

    const good = authority.issuePresence(info, binding)
    expect(authority.consumePresence(info, binding, good)).toBe(true)
    expect(authority.consumePresence(info, binding, good)).toBe(false)
    expect(authority.consumePresence(info, binding, undefined)).toBe(false)
    expect(authority.consumePresence(info, binding, 'guess')).toBe(false)
  })

  it('expire after their short TTL', () => {
    const time = clock()
    const { authority, info } = session(createSessionAuthority({ now: time.now }))
    const nonce = authority.issuePresence(info, binding)
    time.advance(PRESENCE_TTL_MS)
    expect(authority.consumePresence(info, binding, nonce)).toBe(false)
  })

  it('keep a bounded number per session', () => {
    const { authority, info } = session()
    const first = authority.issuePresence(info, binding)
    for (let i = 0; i < MAX_PRESENCE_PER_SESSION; i += 1) authority.issuePresence(info, binding)
    expect(authority.consumePresence(info, binding, first)).toBe(false)
  })
})
