import { describe, expect, it } from 'vitest'
import { builtinWorkflow } from '../workflow/builtin-workflows.js'
import { compileWorkflow } from '../workflow/compile.js'
import { abandonedTerminal } from './abandoned.js'

const plan = { workflow: compileWorkflow(builtinWorkflow('simple')) }
const ABANDON = { event: 'scope-expanded', from: 'change', to: 'escalated', observedAt: '2026-10-06T00:00:00Z' }

describe('abandonedTerminal', () => {
  it('链头是放弃事件、转入的正是当前终态、冻结的工作流声明过这条边：被放弃', () => {
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: ABANDON }))
      .toEqual({ from: 'change', to: 'escalated', event: 'scope-expanded', at: '2026-10-06T00:00:00Z' })
    // 从 verify 放弃同样成立（simple 的 verify 也声明了这条边）。
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: { ...ABANDON, from: 'verify' } })?.from).toBe('verify')
  })

  it('没有链头（从未转换），或最后一次转换是别的事件：不是被放弃', () => {
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: undefined })).toBeUndefined()
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: { ...ABANDON, event: 'change-complete', to: 'verify' } })).toBeUndefined()
    // 事件是放弃事件，但转入的不是当前终态（状态之后被改了）。
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: { ...ABANDON, to: 'verify' } })).toBeUndefined()
  })

  it('正常完结（done）不是被放弃：终态相同，但链头是 verify-pass', () => {
    expect(abandonedTerminal({ phase: 'done', canonicalPhase: 'done', plan, head: { event: 'verify-pass', from: 'verify', to: 'done', observedAt: ABANDON.observedAt } })).toBeUndefined()
    expect(abandonedTerminal({ phase: 'done', canonicalPhase: 'done', plan, head: { ...ABANDON, to: 'done' } })).toBeUndefined()
  })

  it('判定用的状态与 canonical 状态的步骤不一致：不是被放弃', () => {
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'verify', plan, head: ABANDON })).toBeUndefined()
  })

  it('目标步骤不是终态（还有出边），或工作流没有声明这条边：不是被放弃', () => {
    const open = { workflow: compileWorkflow({
      name: 'loop',
      steps: [
        { id: 'a', label: 'a', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'scope-expanded', to: 'b' }, { event: 'go', to: 'b' }] },
        { id: 'b', label: 'b', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'back', to: 'a' }] },
      ],
    }) }
    expect(abandonedTerminal({ phase: 'b', canonicalPhase: 'b', plan: open, head: { event: 'scope-expanded', from: 'a', to: 'b', observedAt: ABANDON.observedAt } })).toBeUndefined()
    // 来源步骤没有声明过这条边（记录说 verify → escalated，但工作流里 done 才是 verify 的另一条出边）。
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: { ...ABANDON, from: 'done' } })).toBeUndefined()
    expect(abandonedTerminal({ phase: 'escalated', canonicalPhase: 'escalated', plan, head: { ...ABANDON, from: 'nowhere' } })).toBeUndefined()
    // 目标步骤不存在于工作流里。
    expect(abandonedTerminal({ phase: 'gone', canonicalPhase: 'gone', plan, head: { ...ABANDON, to: 'gone' } })).toBeUndefined()
  })
})
