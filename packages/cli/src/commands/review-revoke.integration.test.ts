import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REVIEW_GATE_BINDING_FILE, REVIEW_MARKER_PROTOCOL } from '@tenon/kernel'
import { freshHarness, realDeps, type Harness } from '../integration-harness.js'
import { cmdReview } from './review.js'

describe('真实 e2e —— review revoke（撤回已批准、未被消费的评审回执）', () => {
  let h: Harness
  const dir = (): string => join(h.cwd, 'openspec/changes/demo')
  const marker = (): string => join(h.cwd, '.pipeline-pending-review')

  beforeEach(async () => {
    h = await freshHarness()
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['check', 'demo'])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function approveExploreExit(): Promise<void> {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
  }

  test('撤回误记的批准：回到同一 event 的待确认，沿用 requestedAt 与绑定，重写评审标记并写审计行', async () => {
    await approveExploreExit()
    const bindingPath = join(dir(), REVIEW_GATE_BINDING_FILE)
    const binding = await readFile(bindingPath, 'utf8')
    const requestedAt = (JSON.parse(binding) as { requestedAt: string }).requestedAt

    expect(await h.run(['review', 'revoke', 'demo', '--reason', '串会话误确认'])).toBe(0)

    const state = await h.read('demo')
    expect(state).toMatch(/^review_gate_status: pending$/m)
    expect(state).toMatch(/^review_gate_event: explore-complete$/m)
    expect(await readFile(bindingPath, 'utf8')).toBe(binding)
    const projection = await readFile(marker(), 'utf8')
    expect(projection).toContain(`${REVIEW_MARKER_PROTOCOL}\n`)
    expect(projection).toContain('phase=explore\n')
    expect(projection).toContain('change=demo\n')
    expect(projection).toContain('event=explore-complete\n')
    expect(projection).toContain(`requested_at=${requestedAt}\n`)
    const history = await readFile(join(dir(), '.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('review.revoked phase=explore event=explore-complete')
    expect(history).toMatch(/review\.revoked [^"]*receipt=decision:[0-9a-f]{16}/u)
    expect(history).toContain('reason=串会话误确认')
    expect(history).toContain('"actor":{"id":"tester@tenon.test"')
  })

  test('撤销后门重新拦住；用户重新确认（账本里的旧批准记录不能吞掉它）后可以流转', async () => {
    await approveExploreExit()
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '串会话误确认'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: spec$/m)
  })

  test('缺少 --reason 或原因非法时拒绝，状态与标记不变', async () => {
    await approveExploreExit()
    const before = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo'])).toBe(1)
    expect(h.err.join('\n')).toContain('--reason')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '   '])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x'.repeat(201)])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'a\nb'])).toBe(1)
    expect(await h.read('demo')).toBe(before)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('回执不存在、本就待确认、或已被 transition 消费时拒绝，状态与标记不变', async () => {
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '没有回执'])).toBe(1)
    expect(h.err.join('\n')).toContain('没有评审回执')

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const pending = await h.read('demo')
    const projection = await readFile(marker(), 'utf8')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '本就待确认'])).toBe(1)
    expect(h.err.join('\n')).toContain('本就待确认')
    expect(await h.read('demo')).toBe(pending)
    expect(await readFile(marker(), 'utf8')).toBe(projection)

    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    await h.run(['check', 'demo']) // 新 step visit 的第一条命令会落 phase skill，先让它落定再比较。
    const consumed = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '已消费'])).toBe(1)
    expect(await h.read('demo')).toBe(consumed)
  })

  test('撤销后决策状态已变化：确认被拒，对同一 event 重新 request 刷新回执与绑定后可以确认', async () => {
    await approveExploreExit()
    expect(await h.run(['set', 'demo', 'scope', 'changed-after-approval.ts'])).toBe(0)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '批准后范围变了'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
  })

  test('评审标记在 Change 锁内重写：锁释放后别的会话的 acknowledge 不会被多余的 pending 标记误拦', async () => {
    await approveExploreExit()
    const deps = realDeps(h.cwd, [], [])
    let inLock = false
    const store = Object.create(deps.store) as typeof deps.store
    store.withLock = (dir, fn) => deps.store.withLock(dir, async () => {
      inLock = true
      try { return await fn() } finally { inLock = false }
    })
    const markerWrittenInLock: boolean[] = []
    const wrapped = {
      ...deps,
      store,
      writeReviewMarker: async (content: string) => {
        markerWrittenInLock.push(inLock)
        await deps.writeReviewMarker?.(content)
      },
    }
    expect(await cmdReview(wrapped, 'revoke', 'demo', { reason: '串会话误确认' })).toBe(0)
    expect(markerWrittenInLock).toEqual([true])
  })

  test('审计行写不进去时不改状态：先写审计再改状态，exit 1 且评审标记不出现', async () => {
    await approveExploreExit()
    const before = await h.read('demo')
    const deps = realDeps(h.cwd, [], [])
    const err: string[] = []
    const failing = {
      ...deps,
      io: { out: () => {}, err: (line: string) => { err.push(line) } },
      history: { append: async () => { throw new Error('disk full') } },
    } as typeof deps
    expect(await cmdReview(failing, 'revoke', 'demo', { reason: '审计失败' })).toBe(1)
    expect(err.join('\n')).toContain('disk full')
    expect(await h.read('demo')).toBe(before)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('只有任务负责人能撤销；其它参数不适用于 revoke', async () => {
    await approveExploreExit()
    const before = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '不是负责人'], { env: { TENON_USER: 'b@x.io' } })).toBe(1)
    expect(await h.read('demo')).toBe(before)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x', '--event', 'explore-complete'])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x', '--delegated'])).toBe(1)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete', '--reason', 'x'])).toBe(1)
    expect(h.err.join('\n')).toContain('--reason')
    expect(await h.read('demo')).toBe(before)
  })
})
