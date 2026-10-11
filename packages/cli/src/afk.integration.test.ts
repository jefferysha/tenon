/**
 * afk 命令 —— 真实 e2e（GOAL C9）：零 mock，真 kernel createStateStore + 真临时 fs +
 * 真 @tenon/automation SDK。断言真实落盘的 automation_* 字段变化。
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

describe('afk 真 e2e —— automation 子系统 CLI 可达性（iteration-29 收敛复查）', () => {
  let h: Harness
  beforeEach(async () => { h = await freshHarness() })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  test('enqueue 真落盘 automation=queued（backend 轨），status 真读回泳道', async () => {
    await h.run(['init', 'a1', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['afk', 'enqueue', 'a1'])).toBe(0)
    // 真落盘：automation 字段变 queued
    expect(await h.read('a1')).toMatch(/^automation: queued$/m)
    // status 真读回泳道
    expect(await h.run(['afk', 'status', '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as { lanes: Record<string, string[]> }
    expect(payload.lanes.queued).toContain('a1')
  })

  test('enqueue PM 轨真入队：显式请求仍由同一 AFK 授权链保护', async () => {
    await h.run(['init', 'pm1', '--track', 'pm', '--preset', 'full'])
    expect(await h.run(['afk', 'enqueue', 'pm1'])).toBe(0)
    expect(await h.read('pm1')).toMatch(/^automation: queued$/m)
  })

  test('lite 任务 enqueue 被拒并说明该轨道不可进入 AFK：退出码 3，状态零改写', async () => {
    expect(await h.run(['init', 'lt1', '--track', 'lite', '--preset', 'full'])).toBe(0)
    const before = await h.read('lt1')

    expect(await h.run(['afk', 'enqueue', 'lt1'])).toBe(3)

    expect(h.err.join('\n')).toContain('该轨道不可进入 AFK')
    expect(await h.read('lt1')).toBe(before)
    expect(await h.read('lt1')).not.toMatch(/^automation: queued$/m)
  })

  test('lite 任务 enqueue --json：未入队，并给出机器可判定的原因', async () => {
    expect(await h.run(['init', 'lt2', '--track', 'lite', '--preset', 'full'])).toBe(0)

    expect(await h.run(['afk', 'enqueue', 'lt2', '--json'])).toBe(3)

    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ change: 'lt2', queued: false, reason: 'track-not-afk-eligible' })
  })

  test('可进 AFK 的 backend 任务已在队时再次 enqueue 仍然成功，不会被说成轨道不可进入 AFK', async () => {
    expect(await h.run(['init', 'bq1', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['afk', 'enqueue', 'bq1'])).toBe(0)
    h.err.length = 0

    expect(await h.run(['afk', 'enqueue', 'bq1'])).toBe(0)
    expect(h.err.join('\n')).not.toContain('该轨道不可进入 AFK')
  })

  test('scan 真扫就绪队列（build+queued+deps 满足才就绪）', async () => {
    await h.run(['init', 'b1', '--track', 'backend', '--preset', 'full'])
    await h.run(['afk', 'enqueue', 'b1']) // queued 但相位 open，非 build → 不就绪
    expect(await h.run(['afk', 'scan', '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toEqual({ ready: [] })
  })

  // run 的真容器执行路径（#29-wire）在 afk-run.integration.test.ts 覆盖（需 git 仓 + docker 镜像，
  // 本文件 harness 无 git，故这里只测未 enqueue 时的空队列诚实报告分支）。
  test('run：就绪队列空（未 enqueue）→ 诚实报告，exit 0，不触碰 docker', async () => {
    await h.run(['init', 'c1', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['afk', 'run'])).toBe(0)
    expect(h.out.join('\n')).toContain('就绪队列空')
  })

  test('未知子命令 exit 1', async () => {
    expect(await h.run(['afk', 'bogus'])).toBe(1)
  })

  test('enqueue 真记 automation_queued_at 时间戳', async () => {
    await h.run(['init', 'd1', '--track', 'frontend', '--preset', 'full'])
    await h.run(['afk', 'enqueue', 'd1'])
    const yaml = await h.read('d1')
    expect(yaml).toMatch(/^automation: queued$/m)
    expect(yaml).toMatch(/^automation_queued_at: 2026-07-07T00:00:00Z$/m)
  })
})
