import { describe, expect, it } from 'vitest'
import { createDecisionCommandAdapter } from './commands.js'
import type { DecisionRef } from './types.js'

const ref: DecisionRef = { id: 'decision:x', kind: 'review', change: 'demo', anchor: 'verify:verify-pass', revision: 2 }

describe('decision command adapter', () => {
  it('rejects stale revisions before touching the decision', async () => {
    let applied = false
    const adapter = createDecisionCommandAdapter({
      readRevision: async () => 3, isPending: async () => true, apply: async () => { applied = true },
      hasIdempotencyKey: async () => false, rememberIdempotencyKey: async () => undefined,
    })
    const result = await adapter.execute({ ref, expectedRevision: 2, idempotencyKey: 'k', channel: 'dashboard' })
    expect(result).toMatchObject({ ok: false, code: 'revision-conflict' })
    expect(applied).toBe(false)
  })

  it('makes retries idempotent', async () => {
    const result = await createDecisionCommandAdapter({
      readRevision: async () => 2, isPending: async () => true, apply: async () => undefined,
      hasIdempotencyKey: async () => true, rememberIdempotencyKey: async () => undefined,
    }).execute({ ref, expectedRevision: 2, idempotencyKey: 'k', channel: 'terminal' })
    expect(result).toMatchObject({ ok: true, idempotent: true })
  })
})
