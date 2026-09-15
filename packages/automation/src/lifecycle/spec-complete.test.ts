import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { builtinTrack, createStateStore } from '@tenon/kernel'
import { enqueueAfterSpecComplete } from './spec-complete.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const CLOCK = '2026-07-24T06:30:00Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(track: string): Promise<{ root: string; dir: string; store: ReturnType<typeof createStateStore> }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-spec-complete-'))
  roots.push(root)
  await mkdir(join(root, 'openspec', 'changes'), { recursive: true })
  const store = createStateStore()
  const dir = await store.init({
    repoRoot: root,
    name: 'demo',
    track,
    reviewSeed: track === 'pm' ? 'skipped' : 'pending',
    creator: TEST_CREATOR, preset: 'full',
    clock: () => CLOCK,
  })
  await store.set(dir, 'phase', 'build')
  return { root, dir, store }
}

describe('enqueueAfterSpecComplete —— 已提交的 spec 出口自动 AFK 编排', () => {
  test('PM 的显式 auto-enqueue policy 在 spec -> build 后原子挂队，且不启动 runner', async () => {
    const { root, dir, store } = await project('pm')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: (track) => builtinTrack(track as 'pm').policyProfile,
      config: { enabled: true, defaultOptIn: true },
    }, {
      changeName: 'demo',
      event: 'spec-complete',
      from: 'spec',
      to: 'build',
    })

    expect(outcome).toEqual({ kind: 'queued' })
    const fields = (await store.read(dir)).fields
    expect(fields.automation).toBe('queued')
    expect(fields.automation_queued_at).toBe(CLOCK)
  })

  test('显式 runtime opt-out 仍能关闭 PM 的自动挂队（安全控制不靠项目文件伪开关）', async () => {
    const { root, dir, store } = await project('pm')
    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: (track) => builtinTrack(track as 'pm').policyProfile,
      config: { enabled: false },
    }, {
      changeName: 'demo',
      event: 'spec-complete',
      from: 'spec',
      to: 'build',
    })
    expect(outcome).toEqual({ kind: 'not-opted-in' })
    expect(await store.read(dir)).toMatchObject({ fields: { automation: 'off' } })
  })

  test('普通前端轨只有 manual automation capability，不会因 spec-complete 被自动挂队', async () => {
    const { root, dir, store } = await project('frontend')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: (track) => builtinTrack(track as 'frontend').policyProfile,
    }, {
      changeName: 'demo',
      event: 'spec-complete',
      from: 'spec',
      to: 'build',
    })

    expect(outcome).toEqual({ kind: 'track-disabled' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })

  test('不是已提交的 spec -> build 边时零写入，不能被任意后置调用伪造入队', async () => {
    const { root, dir, store } = await project('pm')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: (track) => builtinTrack(track as 'pm').policyProfile,
    }, {
      changeName: 'demo',
      event: 'build-complete',
      from: 'build',
      to: 'verify',
    })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })
})
