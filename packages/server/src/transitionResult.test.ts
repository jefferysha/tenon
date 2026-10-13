/**
 * 文档证据类拒绝的标题：与 CLI 同一套口径。观察模式（新任务）按实际原因说（输入没读完 / 步骤产出账本不可用），
 * 不借用旧契约的「OpenSpec 文档证据」；旧契约任务（没有 source）保留原标题。
 */
import { describe, expect, it } from 'vitest'
import { mapTransitionResult } from './transitionResult.js'

const BLOCKER = '本步输入 docs/specs/a.md（explore 的产出）还没读；读完后执行 tenon document read demo all'

function rejection(source?: 'unread-inputs' | 'step-output-ledger') {
  return mapTransitionResult('demo', 'spec-complete', {
    kind: 'document-evidence-failed',
    phase: 'spec',
    blockers: [BLOCKER],
    ...(source === undefined ? {} : { source }),
  })
}

describe('mapTransitionResult · document-evidence-failed', () => {
  it('输入没读完：标题是「本步输入还没读完」，阻断原文随 detail 给出', () => {
    const { code, body } = rejection('unread-inputs')
    expect(code).toBe(409)
    expect(body.error).toBe('本步输入还没读完（step=spec）')
    expect(body.detail).toEqual(['本步输入还没读完（step=spec）', BLOCKER])
    expect(body.code).toBe('document-evidence-failed')
  })

  it('步骤产出账本不可用：标题点名账本，不说成输入没读完', () => {
    const { body } = rejection('step-output-ledger')
    expect(body.error).toBe('步骤产出账本不可用（step=spec）')
    expect(body.detail).toEqual(['步骤产出账本不可用（step=spec）', BLOCKER])
  })

  it('旧契约任务（没有 source）保留 OpenSpec 文档证据标题', () => {
    expect(rejection().body.error).toBe('OpenSpec 文档证据未通过（phase=spec）')
  })
})
