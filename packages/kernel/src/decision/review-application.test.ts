import { describe, expect, it } from 'vitest'
import { emptyFields, type PipelineState } from '../index.js'
import { reviewGateBindingForState, type ReviewGateBinding } from '../state/review-gate-binding.js'
import type { RunRevision } from '../state/run-revision-codec.js'
import { createReviewDecisionLedger, reviewDecisionPayloadDigest } from './idempotency.js'
import { reviewDecisionRef, selectReviewAnchor } from './projection.js'
import {
  executeReviewAcknowledge,
  reviewAcknowledgeExitCode,
  reviewAcknowledgeHistoryEntry,
  type ReviewAcknowledgeCommand,
  type ReviewAcknowledgePorts,
} from './review-application.js'
import { reviewGateDecisionStateDigest } from '../state/review-gate-binding.js'

const REQUESTED_AT = '2026-09-13T00:00:00.000Z'
const NOW = '2026-09-13T00:01:00.000Z'

function pendingState(overrides: Record<string, string> = {}): PipelineState {
  return {
    fields: {
      ...emptyFields(),
      phase: 'verify',
      workflow: 'default',
      track: 'backend',
      review_gate_phase: 'verify',
      review_gate_event: 'verify-pass',
      review_gate_status: 'pending',
      review_requested_at: REQUESTED_AT,
      ...overrides,
    },
    runMetadata: { runId: 'run-1', transitionSequence: 2, workflowPlanFingerprint: 'a'.repeat(64) },
    opaqueTail: '',
  } as PipelineState
}

function fixture(input: {
  readonly state?: PipelineState
  readonly binding?: ReviewGateBinding | null
  readonly command?: ReviewAcknowledgeCommand
  readonly ledger?: string
  readonly exits?: readonly string[] | null
  readonly fail?: ReadonlySet<'interaction' | 'history' | 'marker' | 'ledger-append' | 'state'>
} = {}) {
  let state = input.state ?? pendingState()
  const binding = input.binding === null
    ? undefined
    : input.binding ?? reviewGateBindingForState(state, 'verify', 'verify-pass', REQUESTED_AT)
  let ledgerText = input.ledger ?? ''
  let revision = 4
  const writes: string[] = []
  const reads: string[] = []
  const fail = input.fail ?? new Set()
  const revisionFor = (): RunRevision => ({ revision, stateDigest: `${revision}`.padStart(64, '0'), state } as unknown as RunRevision)
  const ports: ReviewAcknowledgePorts = {
    change: 'demo',
    command: input.command ?? { channel: 'terminal' },
    withLock: async (fn) => fn(),
    readState: async () => { reads.push('state'); return state },
    readRevision: async () => revisionFor(),
    readBinding: async () => { reads.push('binding'); return binding },
    ledger: createReviewDecisionLedger('/change', {
      readText: async () => { reads.push('ledger'); return ledgerText === '' ? undefined : ledgerText },
      appendText: async (_path, text) => {
        if (fail.has('ledger-append')) throw new Error('disk full')
        writes.push('ledger')
        ledgerText += text
      },
    }),
    reviewExits: async () => { reads.push('exits'); return input.exits === undefined ? ['verify-pass', 'verify-fail'] : input.exits },
    clock: () => NOW,
    writeState: async (next) => {
      if (fail.has('state')) throw new Error('state write failed')
      writes.push('state')
      state = next
      revision += 1
    },
    recordInteraction: async () => {
      if (fail.has('interaction')) throw new Error('interaction failed')
      writes.push('interaction')
    },
    appendHistory: async () => {
      if (fail.has('history')) throw new Error('history failed')
      writes.push('history')
    },
    clearMarker: async () => {
      if (fail.has('marker')) throw new Error('EACCES /secret/path')
      writes.push('marker')
    },
  }
  return { ports, writes, reads, getState: () => state, getLedger: () => ledgerText }
}

function liveRef(state: PipelineState): string {
  const binding = reviewGateBindingForState(state, 'verify', 'verify-pass', REQUESTED_AT)
  return reviewDecisionRef('demo', 'verify', 'verify-pass', selectReviewAnchor({
    phase: 'verify', event: 'verify-pass', requestedAt: REQUESTED_AT, binding,
    decisionStateDigest: reviewGateDecisionStateDigest(state), runId: 'run-1',
  }), 4).id
}

describe('executeReviewAcknowledge', () => {
  it('commits canonical state first, then ledger, interaction, history and marker', async () => {
    const f = fixture()
    const result = await executeReviewAcknowledge(f.ports)
    expect(result).toMatchObject({ ok: true, code: 'approved', changed: true, idempotent: false, phase: 'verify', event: 'verify-pass' })
    expect(f.writes).toEqual(['state', 'ledger', 'interaction', 'history', 'marker'])
    expect(f.getState().fields).toMatchObject({ review_gate_status: 'approved', review_acknowledged_via: 'terminal', review_acknowledged_at: NOW })
  })

  it('reads the idempotency ledger before judging the receipt', async () => {
    const key = 'dashboard-1'
    const ledger = `${JSON.stringify({ key, ref: 'other', expectedRevision: 1, channel: 'dashboard', payloadDigest: 'x', acknowledgedAt: NOW, code: 'approved' })}\n`
    const f = fixture({ state: pendingState({ review_gate_status: '' }), ledger, command: { channel: 'dashboard', ref: 'decision:1', expectedRevision: 4, idempotencyKey: key } })
    const result = await executeReviewAcknowledge(f.ports)
    expect(result).toMatchObject({ ok: false, code: 'idempotency-conflict' })
    expect(f.reads).not.toContain('exits')
    expect(f.writes).toEqual([])
  })

  it('replays a stored success, clears the marker and runs no other side effect', async () => {
    const f = fixture()
    expect(await executeReviewAcknowledge(f.ports)).toMatchObject({ ok: true, code: 'approved' })
    f.writes.length = 0
    const replay = await executeReviewAcknowledge(f.ports)
    expect(replay).toMatchObject({ ok: true, code: 'approved', changed: false, idempotent: true })
    expect(f.writes).toEqual(['marker'])
    expect(f.getLedger().split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('treats an already approved receipt with a new key as idempotent-replay and still clears the marker', async () => {
    const state = pendingState({ review_gate_status: 'approved', review_acknowledged_at: NOW, review_acknowledged_via: 'terminal' })
    const f = fixture({ state, command: { channel: 'dashboard', ref: liveRef(state), expectedRevision: 4, idempotencyKey: 'late-tab' } })
    const result = await executeReviewAcknowledge(f.ports)
    expect(result).toMatchObject({ ok: true, code: 'idempotent-replay', changed: false, idempotent: true })
    expect(f.writes).toEqual(['ledger', 'marker'])
  })

  it('reports marker cleanup failure as marker-warning on commit and on replay', async () => {
    const f = fixture({ fail: new Set(['marker']) })
    expect(await executeReviewAcknowledge(f.ports)).toMatchObject({ ok: true, code: 'marker-warning', deferred: ['review-marker-clear'] })
    expect(f.getState().fields.review_gate_status).toBe('approved')
    expect(await executeReviewAcknowledge(f.ports)).toMatchObject({ ok: true, code: 'marker-warning', idempotent: true })
  })

  it('keeps a committed approval successful when post-commit writes fail', async () => {
    const f = fixture({ fail: new Set(['interaction', 'history', 'ledger-append']) })
    const result = await executeReviewAcknowledge(f.ports)
    expect(result).toMatchObject({ ok: true, code: 'approved', changed: true })
    expect(result.deferred).toEqual(['idempotency-ledger', 'review-interaction', 'review-history'])
    expect(f.writes).toEqual(['state', 'marker'])
  })

  it('retries after a lost ledger append without a second approval effect', async () => {
    const terminal = fixture({ fail: new Set(['ledger-append']) })
    expect(await executeReviewAcknowledge(terminal.ports)).toMatchObject({ ok: true, code: 'approved', deferred: ['idempotency-ledger'] })
    terminal.writes.length = 0
    const approved = structuredClone(terminal.getState())
    const retry = await executeReviewAcknowledge(terminal.ports)
    expect(retry).toMatchObject({ ok: true, code: 'idempotent-replay', changed: false, idempotent: true })
    expect(terminal.writes).toEqual(['marker'])
    expect(terminal.getState()).toEqual(approved)

    const state = pendingState()
    const command: ReviewAcknowledgeCommand = { channel: 'dashboard', ref: liveRef(state), expectedRevision: 4, idempotencyKey: 'tab-1' }
    const dashboard = fixture({ state, command, fail: new Set(['ledger-append']) })
    expect(await executeReviewAcknowledge(dashboard.ports)).toMatchObject({ ok: true, code: 'approved' })
    dashboard.writes.length = 0
    // The committed revision moved, so the unrecorded key re-evaluates as a zero-write CAS conflict.
    expect(await executeReviewAcknowledge(dashboard.ports)).toMatchObject({ ok: false, code: 'revision-conflict', deferred: [] })
    expect(dashboard.writes).toEqual([])
  })

  it('propagates a canonical write failure without any later effect', async () => {
    const f = fixture({ fail: new Set(['state']) })
    await expect(executeReviewAcknowledge(f.ports)).rejects.toThrow('state write failed')
    expect(f.writes).toEqual([])
  })

  const zeroWriteCases: ReadonlyArray<readonly [string, () => ReturnType<typeof fixture>, string]> = [
    ['no receipt (missing)', () => fixture({ state: pendingState({ review_gate_phase: '', review_gate_event: '', review_gate_status: '', review_requested_at: '' }) }), 'review-approval-required'],
    ['receipt for another phase (not pending)', () => fixture({ state: pendingState({ phase: 'build' }) }), 'review-approval-required'],
    ['event no longer an exit', () => fixture({ exits: ['verify-fail'] }), 'review-approval-required'],
    ['step is not review-gated', () => fixture({ exits: null }), 'review-approval-required'],
    ['binding missing', () => fixture({ binding: null }), 'review-approval-required'],
    ['binding mismatch', () => fixture({ binding: { version: 1, phase: 'verify', event: 'verify-pass', requestedAt: REQUESTED_AT, decisionStateDigest: '0'.repeat(64), runId: 'run-1' } }), 'review-approval-required'],
    ['unknown dashboard ref', () => fixture({ command: { channel: 'dashboard', ref: 'decision:missing', expectedRevision: 4, idempotencyKey: 'k' } }), 'review-approval-required'],
    ['stale expected revision', () => fixture({ command: { channel: 'dashboard', ref: liveRef(pendingState()), expectedRevision: 3, idempotencyKey: 'k' } }), 'revision-conflict'],
    ['terminal --event mismatch', () => fixture({ command: { channel: 'terminal', requestedEvent: 'verify-fail' } }), 'invalid-command'],
  ]
  for (const [name, make, code] of zeroWriteCases) {
    it(`writes nothing when ${name}`, async () => {
      const f = make()
      const before = structuredClone(f.getState())
      const result = await executeReviewAcknowledge(f.ports)
      expect(result).toMatchObject({ ok: false, code, deferred: [] })
      expect(f.writes).toEqual([])
      expect(f.getState()).toEqual(before)
      expect(f.getLedger()).toBe('')
    })
  }

  it('re-evaluates a retried failure instead of replaying it', async () => {
    const legacyRejected = `${JSON.stringify({ key: 'k', ref: 'r', expectedRevision: 4, channel: 'dashboard', acknowledgedAt: NOW, outcome: 'rejected', code: 'revision-conflict' })}\n`
    const state = pendingState()
    const f = fixture({ ledger: legacyRejected, command: { channel: 'dashboard', ref: liveRef(state), expectedRevision: 4, idempotencyKey: 'k' } })
    expect(await executeReviewAcknowledge(f.ports)).toMatchObject({ ok: true, code: 'approved' })
  })

  it('maps results to stable CLI exit codes', () => {
    const ref = { id: 'decision:x', kind: 'review' as const, change: 'demo', anchor: '', revision: null }
    expect(reviewAcknowledgeExitCode({ ok: true, code: 'approved', changed: true, idempotent: false, ref })).toBe(0)
    expect(reviewAcknowledgeExitCode({ ok: true, code: 'marker-warning', changed: true, idempotent: false, ref })).toBe(0)
    expect(reviewAcknowledgeExitCode({ ok: false, code: 'review-approval-required', message: '' })).toBe(2)
    expect(reviewAcknowledgeExitCode({ ok: false, code: 'revision-conflict', message: '' })).toBe(3)
    expect(reviewAcknowledgeExitCode({ ok: false, code: 'idempotency-conflict', message: '' })).toBe(4)
    expect(reviewAcknowledgeExitCode({ ok: false, code: 'invalid-command', message: '' })).toBe(1)
  })

  it('stamps the declared operator on the acknowledgement history row', async () => {
    const actor = { id: 'b@x.io', name: 'B', trust: 'declared' as const }
    const rows: unknown[] = []
    const f = fixture()
    const result = await executeReviewAcknowledge({ ...f.ports, actor, appendHistory: async (entry) => { rows.push(entry) } })
    expect(result).toMatchObject({ ok: true, code: 'approved' })
    expect(rows).toEqual([expect.objectContaining({ kind: 'tool', actor })])
  })

  it('uses one history line format with the channel', () => {
    expect(reviewAcknowledgeHistoryEntry({ acknowledgedAt: NOW, phase: 'verify', event: 'verify-pass', channel: 'dashboard' }))
      .toEqual({ ts: NOW, kind: 'tool', raw: 'review:acknowledge via=dashboard phase=verify event=verify-pass' })
    expect(reviewDecisionPayloadDigest('decision:x', null, 'terminal')).toBe('terminal\0decision:x\0null')
  })
})
