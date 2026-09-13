import type { DecisionCommandAdapter, DecisionCommandInput, DecisionCommandResult, DecisionRef } from './types.js'

export interface DecisionCommandPort {
  readonly readRevision: () => Promise<number | null>
  readonly isPending: (ref: DecisionRef) => Promise<boolean>
  readonly apply: (input: DecisionCommandInput) => Promise<void>
  readonly hasIdempotencyKey: (key: string) => Promise<boolean>
  readonly rememberIdempotencyKey: (key: string) => Promise<void>
}

export function createDecisionCommandAdapter(port: DecisionCommandPort): DecisionCommandAdapter {
  return { execute: async (input) => {
    if (input.idempotencyKey === '') return { ok: false, code: 'invalid-command', message: 'idempotency key is required' }
    // A recorded key is already bound by the caller's transaction to its ref/revision. Check it
    // before the live CAS revision: a retry is allowed after the successful approval advanced the
    // canonical revision, while an unrecorded stale command must still fail closed below.
    if (await port.hasIdempotencyKey(input.idempotencyKey)) return { ok: true, idempotent: true, ref: input.ref }
    const current = await port.readRevision()
    if (current !== input.expectedRevision) return { ok: false, code: 'revision-conflict', message: 'decision revision conflict' }
    if (!await port.isPending(input.ref)) return { ok: false, code: 'decision-not-pending', message: 'decision is no longer pending' }
    await port.apply(input)
    await port.rememberIdempotencyKey(input.idempotencyKey)
    return { ok: true, idempotent: false, ref: input.ref }
  } }
}
