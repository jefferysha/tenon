import { describe, expect, it } from 'vitest'
import {
  createSelfApprovalSignal,
  SELF_APPROVAL_SIGNAL_TYPE,
} from './self-approval.js'

const hash = `sha256:${'a'.repeat(64)}`

describe('pending review self-approval security signal', () => {
  it('creates the redacted canonical wire record', () => {
    const signal = createSelfApprovalSignal({
      change: 'demo-change', phase: 'verify', event: 'verify-pass',
      requestAnchor: '2026-09-14T10:00:00Z|digest|run-1',
      channel: 'hook', processOrHostHash: hash,
      observedAt: '2026-09-14T10:01:00Z', kind: 'token-file-read',
    })
    expect(signal).toEqual({
      schema_version: 'pending-decision-security/v1',
      signal_kind: SELF_APPROVAL_SIGNAL_TYPE,
      kind: 'token-file-read', change: 'demo-change', phase: 'verify', event: 'verify-pass',
      request_anchor: '2026-09-14T10:00:00Z|digest|run-1', channel: 'hook',
      process_or_host_hash: hash, observed_at: '2026-09-14T10:01:00Z',
    })
    expect(JSON.stringify(signal)).not.toContain('dashboard-token-value')
  })

  it('rejects raw identity, unsupported kinds and invalid channels', () => {
    expect(() => createSelfApprovalSignal({
      change: 'demo', phase: 'verify', event: 'verify-pass', requestAnchor: 'anchor',
      channel: 'hook', processOrHostHash: 'pid:42', observedAt: 'now', kind: 'token-file-read',
    })).toThrow('process_or_host_hash is invalid')
    expect(() => createSelfApprovalSignal({
      change: 'demo', phase: 'verify', event: 'verify-pass', requestAnchor: 'anchor',
      channel: 'host' as never, processOrHostHash: hash, observedAt: 'now', kind: 'token-file-read',
    })).toThrow('channel is invalid')
    expect(() => createSelfApprovalSignal({
      change: 'demo', phase: 'verify', event: 'verify-pass', requestAnchor: 'anchor',
      channel: 'hook', processOrHostHash: hash, observedAt: 'now', kind: 'secret-read' as never,
    })).toThrow('kind is invalid')
  })
})
