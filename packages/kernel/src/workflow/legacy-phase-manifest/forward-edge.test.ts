import { describe, expect, it } from 'vitest'
import { TRANSITION_EVENTS } from '../../flow/transition-table.js'
import { isForwardEdge } from '../implicit-completion.js'
import { legacyIsForwardEdge } from './forward-edge.js'

describe('legacyIsForwardEdge', () => {
  it('相位完成边是前进边，回退边与未知事件不是', () => {
    for (const event of ['open-complete', 'explore-complete', 'spec-complete', 'build-complete', 'verify-pass', 'ship-complete']) {
      expect(legacyIsForwardEdge(event), event).toBe(true)
    }
    for (const event of ['requirements-changed', 'verify-fail', 'nonsense', '']) {
      expect(legacyIsForwardEdge(event), event).toBe(false)
    }
  })

  it('事件表里的每个事件都有明确的前进 / 回退归类，且与 isForwardEdge 的 phase-manifest 分支一致', () => {
    for (const [event, edge] of Object.entries(TRANSITION_EVENTS)) {
      expect(isForwardEdge('phase-manifest', [], edge.from, edge.to, event), event).toBe(
        event === 'archived' && edge.from === edge.to ? true : legacyIsForwardEdge(event),
      )
    }
  })

  it('step-graph 不读事件表：同名事件按步骤序判前后', () => {
    expect(isForwardEdge('step-graph', ['a', 'b'], 'a', 'b', 'verify-fail')).toBe(true)
    expect(isForwardEdge('step-graph', ['a', 'b'], 'b', 'a', 'verify-pass')).toBe(false)
  })
})
