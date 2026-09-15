import { describe, expect, it } from 'vitest'
import {
  actorOf, decodeRecordActor, formatUserRef, normalizeUserName, parseUserRef, userSlug, validateUserId,
} from './user.js'

describe('user identity primitives', () => {
  it('slug: lowercase, @ → -at-, other characters → -, runs collapsed', () => {
    expect(userSlug('Jeff.Sha@Example.COM')).toBe('jeff.sha-at-example.com')
    expect(userSlug('a+b@x.io')).toBe('a-b-at-x.io')
    expect(userSlug('a-@b.c')).toBe('a-at-b.c')
  })

  it('id: printable ASCII with exactly one @, at most 200 characters', () => {
    expect(validateUserId('  jeff@example.com ')).toBe('jeff@example.com')
    for (const bad of ['jeff', 'a@b@c', 'je ff@x.io', 'jéff@x.io', 'a<b@x.io', '@x.io', 'a@', `${'a'.repeat(196)}@x.io`]) {
      expect(validateUserId(bad), bad).toBeNull()
    }
    expect(validateUserId(`${'a'.repeat(195)}@x.io`)).toHaveLength(200)
  })

  it('name: invalid or absent falls back to the id local part', () => {
    expect(normalizeUserName(' Jeff Sha ', 'jeff@x.io')).toBe('Jeff Sha')
    expect(normalizeUserName('沙杰夫', 'jeff@x.io')).toBe('沙杰夫')
    for (const bad of [undefined, '', 'a: b', 'a #b', 'Jeff:', '"Jeff', "'Jeff", 'J<e>', 'a\tb', 'x'.repeat(101)]) {
      expect(normalizeUserName(bad, 'jeff@x.io'), String(bad)).toBe('jeff')
    }
  })

  it('user ref round trip; legacy values are not refs', () => {
    const actor = actorOf({ id: 'jeff@example.com', name: 'Jeff Sha' })
    expect(actor).toEqual({ id: 'jeff@example.com', name: 'Jeff Sha', trust: 'declared' })
    expect(formatUserRef(actor)).toBe('Jeff Sha <jeff@example.com>')
    expect(parseUserRef(formatUserRef(actor))).toEqual({ id: 'jeff@example.com', name: 'Jeff Sha', slug: 'jeff-at-example.com' })
    for (const legacy of ['unknown', 'null', 'jeff', '', undefined, ['Jeff <jeff@x.io>'], 'Jeff <bad>']) {
      expect(parseUserRef(legacy)).toBeNull()
    }
  })

  it('decodeRecordActor: absent, invalid, valid', () => {
    expect(decodeRecordActor(undefined)).toBeUndefined()
    expect(decodeRecordActor({ id: 'jeff@x.io', name: 'Jeff', trust: 'declared' }))
      .toEqual({ id: 'jeff@x.io', name: 'Jeff', trust: 'declared' })
    for (const bad of [null, 'Jeff <jeff@x.io>', [], { id: 'jeff@x.io', name: 'Jeff' },
      { id: 'jeff@x.io', name: 'Jeff', trust: 'human' }, { id: 'jeff', name: 'Jeff', trust: 'declared' },
      { id: 'jeff@x.io', name: 'a: b', trust: 'declared' }, { id: 'jeff@x.io', name: 'Jeff', trust: 'declared', x: 1 }]) {
      expect(decodeRecordActor(bad)).toBeNull()
    }
  })
})
