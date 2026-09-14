import { describe, expect, it } from 'vitest'
import {
  classifySelfApprovalCandidate,
  createSelfApprovalOverflowMarker,
  createSelfApprovalSignal,
  SELF_APPROVAL_OVERFLOW_TYPE,
  SELF_APPROVAL_SIGNAL_TYPE,
} from './self-approval.js'

const hash = `hmac-sha256:${'a'.repeat(64)}`
const key = `sha256:${'b'.repeat(64)}`
const location = {
  tokenPath: '/Users/demo/Library/Application Support/tenon/state/dashboard-token.json',
  tokenFileName: 'dashboard-token.json',
}

describe('pending review self-approval security signal', () => {
  it('creates the redacted canonical wire record', () => {
    const signal = createSelfApprovalSignal({
      change: 'demo-change', phase: 'verify', event: 'verify-pass',
      requestAnchor: '2026-09-14T10:00:00Z|digest|run-1',
      channel: 'terminal', observationKey: key, processOrHostHash: hash,
      observedAt: '2026-09-14T10:01:00Z', kind: 'token-file-read',
    })
    expect(signal).toEqual({
      schema_version: 'pending-decision-security/v1',
      signal_kind: SELF_APPROVAL_SIGNAL_TYPE,
      kind: 'token-file-read', change: 'demo-change', phase: 'verify', event: 'verify-pass',
      request_anchor: '2026-09-14T10:00:00Z|digest|run-1', channel: 'terminal',
      observation_key: key, process_or_host_hash: hash, observed_at: '2026-09-14T10:01:00Z',
    })
    expect(JSON.stringify(signal)).not.toContain('dashboard-token-value')
  })

  it('rejects raw identity, unsalted digests, unsupported kinds and non-contract channels', () => {
    const base = {
      change: 'demo', phase: 'verify', event: 'verify-pass', requestAnchor: 'anchor',
      channel: 'terminal' as const, observationKey: key, processOrHostHash: hash,
      observedAt: 'now', kind: 'token-file-read' as const,
    }
    expect(() => createSelfApprovalSignal({ ...base, processOrHostHash: 'pid:42' })).toThrow('process_or_host_hash is invalid')
    expect(() => createSelfApprovalSignal({ ...base, processOrHostHash: `sha256:${'a'.repeat(64)}` })).toThrow('process_or_host_hash is invalid')
    expect(() => createSelfApprovalSignal({ ...base, observationKey: 'curl -X POST' })).toThrow('observation_key is invalid')
    expect(() => createSelfApprovalSignal({ ...base, channel: 'hook' as never })).toThrow('channel is invalid')
    expect(() => createSelfApprovalSignal({ ...base, kind: 'localhost-control-write' as never })).toThrow('kind is invalid')
  })

  it('creates a bounded overflow marker without any candidate data', () => {
    expect(createSelfApprovalOverflowMarker('2026-09-14T10:02:00Z')).toEqual({
      schema_version: 'pending-decision-security/v1',
      signal_kind: SELF_APPROVAL_OVERFLOW_TYPE,
      observed_at: '2026-09-14T10:02:00Z',
    })
  })
})

describe('classifySelfApprovalCandidate', () => {
  it.each([
    ['cat "/Users/demo/Library/Application Support/tenon/state/dashboard-token.json"', ['token-file-read']],
    ['~/Library/Application\\ Support/tenon/state/dashboard-token.json', ['token-file-read']],
    ['cat $STATE/dashboard-token.json | jq -r .token', ['token-file-read']],
    ['curl -XPOST http://127.0.0.1:18765/api/change/demo/decisions', ['local-control-api-call']],
    ['curl --json \'{}\' http://localhost:18765/api/change/demo/transition', ['local-control-api-call']],
    ['curl -d @body.json http://[::1]:18765/api/anything', ['local-control-api-call']],
    ['curl localhost:18765/api/snapshot', ['local-control-api-call']],
    ['curl -XPOST "http://127.0.0.1:$PORT/api/change/demo/decisions"', ['local-control-api-call']],
    ['curl http://localhost:${PORT}/api/change/demo/transition', ['local-control-api-call']],
    [
      'curl -H "Authorization: Bearer $(jq -r .token ~/.local/state/tenon/dashboard-token.json)" http://127.0.0.1:1/api/x',
      ['token-file-read', 'local-control-api-call'],
    ],
  ])('classifies %s', (candidate, kinds) => {
    expect(classifySelfApprovalCandidate(candidate, location)).toEqual(kinds)
  })

  it.each([
    'cat /tmp/dashboard-token.json.bak',
    'cat /tmp/old-dashboard-token.json',
    'curl -X POST http://example.test/api/change/demo/decisions',
    'curl http://localhost.example.test/api/change/demo/decisions',
    'curl http://evil-localhost:80/api/x',
    'curl http://127.0.0.1:18765/health',
    'ls -la',
  ])('does not classify near misses: %s', (candidate) => {
    expect(classifySelfApprovalCandidate(candidate, location)).toEqual([])
  })
})
