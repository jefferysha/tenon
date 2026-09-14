import { describe, expect, it } from 'vitest'
import { strategyForDecisionMode } from './mode.js'

describe('decision mode contract', () => {
  it('maps HITL and AFK to the three internal strategies', () => {
    expect(strategyForDecisionMode('hitl')).toBe('interactive')
    expect(strategyForDecisionMode('hitl', true)).toBe('recommended-defaults')
    expect(strategyForDecisionMode('afk')).toBe('afk')
  })
})
