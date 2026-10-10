/**
 * `session activate --host-session` 的绑定写入顺序与互斥（真 fs，仅在写入口注入故障）：
 *   · 先原子写入本会话绑定，成功后才移交（删其他会话对同一 Change 的绑定）；
 *   · 写失败（temp 写入或 rename）时不删任何别的会话的绑定，也不留临时文件；
 *   · 「写 + 移交」在一把锁内完成：同一 Change 被多个会话并发 activate，最终恰好一个会话绑着它。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fault = vi.hoisted(() => ({
  on: null as null | 'writeFile' | 'rename',
  /** 每次本会话绑定 rename 发生时，某个「他会话绑定」文件是否还在盘上。 */
  watch: null as null | string,
  seenAtRename: [] as boolean[],
  /** 在本会话绑定 rename 之前停一会儿，把「写之前读到的盘面」与「写入生效」之间的竞争窗口拉开。 */
  renameDelayMs: 0,
}))

const isBindingTemp = (path: unknown): boolean => {
  const text = String(path)
  return text.includes('terminal-sessions') && text.includes('.json.tmp-')
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fault.on === 'writeFile' && isBindingTemp(args[0])) throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
      return actual.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (isBindingTemp(args[0])) {
        if (fault.renameDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fault.renameDelayMs))
        if (fault.watch !== null) fault.seenAtRename.push(existsSync(fault.watch))
        if (fault.on === 'rename') throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
      }
      return actual.rename(...args)
    },
  }
})

const { freshHarness, realDeps, rm } = await import('../integration-harness.js')
const { cmdSession } = await import('./session.js')
type Harness = Awaited<ReturnType<typeof freshHarness>>

async function activate(h: Harness, sessionId: string): Promise<{ code: number; err: string }> {
  const err: string[] = []
  const code = await cmdSession(realDeps(h.cwd, [], err), 'activate', ['feat', '--host-session', sessionId])
  return { code, err: err.join('\n') }
}

async function bindings(h: Harness): Promise<string[]> {
  const dir = join(h.cwd, '.pipeline', 'terminal-sessions')
  const found: string[] = []
  for (const entry of (await readdir(dir).catch(() => [])).sort()) {
    if (!entry.endsWith('.json')) continue
    const body = JSON.parse(await readFile(join(dir, entry), 'utf8')) as { change?: string }
    if (body.change === 'feat') found.push(entry.slice(0, -'.json'.length))
  }
  return found
}

describe('session activate --host-session：绑定写入与移交', () => {
  let h: Harness
  beforeEach(async () => {
    fault.on = null
    fault.watch = null
    fault.seenAtRename = []
    fault.renameDelayMs = 0
    h = await freshHarness()
    expect(await h.run(['init', 'feat', '--track', 'backend', '--preset', 'full'])).toBe(0)
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('先写本会话绑定再移交：写 rename 发生时，旧会话的绑定还在', async () => {
    expect((await activate(h, 'session-x1')).code).toBe(0)
    fault.watch = join(h.cwd, '.pipeline', 'terminal-sessions', 'session-x1.json')
    const moved = await activate(h, 'session-y')
    expect(moved.code).toBe(0)
    expect(moved.err).toContain('[activate] 已从会话 session-x1 移交 feat')
    expect(fault.seenAtRename).toEqual([true])
    expect(await bindings(h)).toEqual(['session-y'])
  })

  test.each(['writeFile', 'rename'] as const)('%s 失败：旧会话绑定保留、新会话未绑定、不留临时文件，错误如实上报', async (stage) => {
    expect((await activate(h, 'session-x1')).code).toBe(0)
    fault.on = stage
    const failed = await activate(h, 'session-y')
    expect(failed.code).toBe(0)
    expect(failed.err).toContain('终端会话绑定未写入')
    expect(failed.err).toContain(`injected ${stage === 'writeFile' ? 'write' : 'rename'} failure`)
    expect(failed.err).not.toContain('移交')
    expect(await readdir(join(h.cwd, '.pipeline', 'terminal-sessions'))).toEqual(['session-x1.json'])
    expect(await bindings(h)).toEqual(['session-x1'])
  })

  test('同一 Change 被多个会话并发 activate：恰好一个会话绑着它', async () => {
    const ids = ['session-a', 'session-b', 'session-c', 'session-d']
    fault.renameDelayMs = 25
    const runs = await Promise.all(ids.map((id) => activate(h, id)))
    for (const run of runs) expect(run.code).toBe(0)
    const bound = await bindings(h)
    expect(bound).toHaveLength(1)
    expect(ids).toContain(bound[0])
    // 锁已释放：之后再激活一个新会话照常接手。
    fault.renameDelayMs = 0
    expect((await activate(h, 'session-e')).code).toBe(0)
    expect(await bindings(h)).toEqual(['session-e'])
  })
})
