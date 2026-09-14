import { describe, expect, it } from 'vitest'
import { createReviewDecisionLedger, reviewDecisionPayloadDigest, type ReviewDecisionLedgerFs } from './idempotency.js'

function memoryFs(initial = ''): ReviewDecisionLedgerFs & { text: () => string } {
  let text = initial
  return {
    readText: async () => (text === '' ? undefined : text),
    appendText: async (_path, line) => { text += line },
    text: () => text,
  }
}

const NOW = '2026-09-14T00:00:00.000Z'

describe('review decision ledger', () => {
  it('stores successes and replays or conflicts by payload digest', async () => {
    const fs = memoryFs()
    const ledger = createReviewDecisionLedger('/change', fs)
    const digest = reviewDecisionPayloadDigest('decision:a', 3, 'dashboard')
    expect(await ledger.lookup('k1', digest)).toEqual({ kind: 'missing' })
    await ledger.remember({ key: 'k1', ref: 'decision:a', expectedRevision: 3, channel: 'dashboard', payloadDigest: digest, acknowledgedAt: NOW, code: 'approved' })
    expect(await ledger.lookup('k1', digest)).toEqual({ kind: 'replay', code: 'approved' })
    expect(await ledger.lookup('k1', reviewDecisionPayloadDigest('decision:a', 4, 'dashboard'))).toEqual({ kind: 'conflict' })
  })

  it('ignores legacy rejected records and derives digests for legacy success records', async () => {
    const rejected = JSON.stringify({ key: 'k1', ref: 'decision:a', expectedRevision: 3, channel: 'dashboard', acknowledgedAt: NOW, outcome: 'rejected', code: 'revision-conflict' })
    const legacy = JSON.stringify({ key: 'k2', ref: 'decision:b', expectedRevision: null, channel: 'terminal', acknowledgedAt: NOW })
    const ledger = createReviewDecisionLedger('/change', memoryFs(`${rejected}\n${legacy}\n`))
    expect(await ledger.lookup('k1', reviewDecisionPayloadDigest('decision:a', 3, 'dashboard'))).toEqual({ kind: 'missing' })
    expect(await ledger.lookup('k2', reviewDecisionPayloadDigest('decision:b', null, 'terminal'))).toEqual({ kind: 'replay', code: 'approved' })
  })

  it('fails closed on truncated or invalid ledgers', async () => {
    await expect(createReviewDecisionLedger('/c', memoryFs('{"key":"k"}')).lookup('k', 'd')).rejects.toThrow('truncated')
    await expect(createReviewDecisionLedger('/c', memoryFs('{broken\n')).lookup('k', 'd')).rejects.toThrow('invalid')
    await expect(createReviewDecisionLedger('/c', memoryFs('{"key":1}\n')).lookup('k', 'd')).rejects.toThrow('invalid')
  })
})
