import { describe, expect, it } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { assertOwner, creatorOf, OwnerRequiredError, ownerDecision, ownerOf, ownerRequiredMessage } from './owner.js'

const A = { id: 'Ann@x.io', name: 'Ann', trust: 'declared' } as const
const B = { id: 'b@x.io', name: 'B', trust: 'declared' } as const

function fields(assignee: string, createdBy = 'Ann <ann@x.io>') {
  return { ...emptyFields(), assignee, created_by: createdBy }
}

describe('owner rule', () => {
  it('projects creator and owner; legacy values are null', () => {
    expect(ownerOf(fields('Ann <ann@x.io>'))).toEqual({ id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' })
    expect(creatorOf(fields('null', 'unknown'))).toBeNull()
    expect(ownerOf(fields('null'))).toBeNull()
  })

  it('allows the owner (compared by slug) and refuses another user with the owner ref', () => {
    expect(ownerDecision(fields('Ann <ann@x.io>'), A)).toEqual({ allowed: true })
    expect(ownerDecision(fields('Ann <ann@x.io>'), B)).toEqual({
      allowed: false, owner: { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' },
    })
    expect(ownerDecision(fields('null'), A)).toEqual({ allowed: false, owner: null })
  })

  it('messages name the owner or say there is none, with the take-over command', () => {
    expect(ownerRequiredMessage('x', { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' }))
      .toBe('任务 x 的负责人是 Ann <ann@x.io>；先接手：tenon owner take x')
    expect(ownerRequiredMessage('x', null)).toBe('任务 x 没有负责人；先接手：tenon owner take x')
    expect(() => assertOwner('x', fields('Ann <ann@x.io>'), B)).toThrow(OwnerRequiredError)
    try {
      assertOwner('x', fields('unknown'), A)
    } catch (error) {
      expect(error).toMatchObject({ code: 'owner-required', change: 'x', owner: null })
    }
  })
})
