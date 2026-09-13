import { describe, expect, it } from 'vitest'
import { modeSwitchEvent, pendingAccessAlert, strategyForDecisionMode } from './mode.js'

describe('decision mode contract', () => {
  it('maps HITL and AFK to the three internal strategies', () => {
    expect(strategyForDecisionMode('hitl')).toBe('interactive')
    expect(strategyForDecisionMode('hitl', true)).toBe('recommended-defaults')
    expect(strategyForDecisionMode('afk')).toBe('afk')
    expect(modeSwitchEvent({ from: 'hitl', to: 'afk', occurredAt: '2026-09-13T00:00:00Z', actor: 'user' })).toMatchObject({ type: 'decision-mode-switched', strategy: 'afk' })
  })

  it('returns a redacted detection signal for pending token access', () => {
    expect(pendingAccessAlert({ pendingDecisionId: 'decision:x', channel: 'hook', operation: 'read-token', observedAt: '2026-09-13T00:00:00Z' })).toEqual({
      type: 'pending-decision-self-approval-suspected', pendingDecisionId: 'decision:x', channel: 'hook', operation: 'read-token', tokenDigest: null, observedAt: '2026-09-13T00:00:00Z', severity: 'warning',
    })
  })
})
