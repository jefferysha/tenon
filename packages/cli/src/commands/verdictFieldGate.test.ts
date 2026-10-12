import { describe, expect, test } from 'vitest'
import { cmdCas, cmdSet, cmdSetMany } from './fields.js'
import { refuseUnprovenVerdict } from './verdictFieldGate.js'
import { makeDeps, mockState } from '../test-support.js'

/**
 * 工作流文件读不到（被删或改名）且任务没有冻结快照：计划解析为 null。结论字段是「本步已通过」的批准，
 * 读不到本步声明的就绪证据时没有东西可核对，不能当成「无需核对」放行（失败关闭）。
 */
const GHOST = { workflow: 'ghost', phase: 'build', track: '' } as const

describe('结论字段写入闸：读不到工作流计划时失败关闭', () => {
  test.each([
    ['pre_verify_review_result', 'pass'],
    ['verify_result', 'pass'],
  ] as const)('set %s %s 被拒：不落盘，说明读不到计划与修法', async (field, value) => {
    const deps = makeDeps({ state: mockState(GHOST) })
    expect(await cmdSet(deps, 'demo', field, value)).toBe(1)
    expect(deps.store.write.calls).toHaveLength(0)
    const err = deps.errLines.join('\n')
    expect(err).toContain(`无法核对字段 '${field}'`)
    expect(err).toContain("workflow 'ghost'")
    expect(err).toContain('.pipeline/workflows/ghost.yaml')
    expect(err).toContain('tenon task terminate demo')
  })

  test('set-many 与 cas 走同一道闸', async () => {
    const many = makeDeps({ state: mockState(GHOST) })
    expect(await cmdSetMany(many, 'demo', ['pre_verify_review_result=pass'])).toBe(1)
    expect(many.store.write.calls).toHaveLength(0)
    const cas = makeDeps({ state: mockState({ ...GHOST, pre_verify_review_result: 'pending' }) })
    expect(await cmdCas(cas, 'demo', 'pre_verify_review_result', 'pending', 'pass')).toBe(1)
    expect(cas.store.write.calls).toHaveLength(0)
  })

  test('置回 pending 是撤回不是批准：读不到计划也照常允许', async () => {
    const deps = makeDeps({ state: mockState({ ...GHOST, pre_verify_review_result: 'pass' }) })
    expect(await cmdSet(deps, 'demo', 'pre_verify_review_result', 'pending'), deps.errLines.join('\n')).toBe(0)
    expect(deps.store.write.calls[0]?.[1].fields.pre_verify_review_result).toBe('pending')
  })

  test('refuseUnprovenVerdict 直接调用：返回 true 并打印拒写原因', async () => {
    const deps = makeDeps({ state: mockState(GHOST) })
    expect(await refuseUnprovenVerdict(deps, 'demo', 'pre_verify_review_result', 'pass')).toBe(true)
    expect(deps.errLines.join('\n')).toContain('读不到')
  })

  test('任务记着的 workflow 名不合法时不回显、也不拼进恢复路径，照样拒写', async () => {
    const deps = makeDeps({ state: mockState({ ...GHOST, workflow: 'ghost; rm -rf /' }) })
    expect(await refuseUnprovenVerdict(deps, 'demo', 'pre_verify_review_result', 'pass')).toBe(true)
    const err = deps.errLines.join('\n')
    expect(err).not.toContain('rm -rf')
    expect(err).not.toContain('.pipeline/workflows/')
    expect(err).toContain('tenon task terminate demo')
  })

  test('不是结论字段的写入不受影响', async () => {
    const deps = makeDeps({ state: mockState(GHOST) })
    expect(await refuseUnprovenVerdict(deps, 'demo', 'plan', 'docs/plans/p.md')).toBe(false)
    expect(deps.errLines).toEqual([])
  })
})
