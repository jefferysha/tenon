import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanReadyFromFs } from './scan.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

/**
 * 真 fs 扫描：真建 openspec/changes/*，真读回 automation 字段，真判 dep 满足（merged ∪ archived）。
 */
describe('scanReadyFromFs（真 fs 枚举 + 真读 automation 字段）', () => {
  let root: string
  const store = createStateStore()
  const clock = () => '2026-07-07T00:00:00Z'
  const changesDir = () => join(root, 'openspec', 'changes')

  const initQueued = async (name: string, queuedAt: string, depends: string[] = []) => {
    const dir = await store.init({
      repoRoot: root, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    await store.setMany(dir, {
      phase: 'build',
      automation: 'queued',
      automation_queued_at: queuedAt,
      depends_on: depends.length ? depends : 'null',
    })
    return dir
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'afk-scan-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('changesDir 只有 ENOENT 可视为空；ENOTDIR 必须 fail-loud', async () => {
    await expect(scanReadyFromFs(changesDir(), store)).resolves.toEqual([])

    const notDirectory = join(root, 'changes-file')
    await writeFile(notDirectory, 'not a directory\n', 'utf8')
    await expect(scanReadyFromFs(notDirectory, store)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('任一活跃 change state 读取或解析失败都 fail-loud', async () => {
    await mkdir(join(changesDir(), 'broken-state'), { recursive: true })
    const stateError = Object.assign(new Error('simulated state read/parse EIO'), { code: 'EIO' })
    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'read') return async () => { throw stateError }
        return Reflect.get(target, property, receiver)
      },
    })

    await expect(scanReadyFromFs(changesDir(), failingStore)).rejects.toBe(stateError)
  })

  it('挑出 build+queued 就绪 change，按 queued_at FIFO', async () => {
    await initQueued('later', '2026-07-07T09:00:00Z')
    await initQueued('earlier', '2026-07-07T08:00:00Z')
    // 一个 spec 相位的 change 不该入选
    const dir = await store.init({
      repoRoot: root, name: 'notbuild', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    })
    await store.setMany(dir, { phase: 'spec', automation: 'queued' })

    expect(await scanReadyFromFs(changesDir(), store)).toEqual(['earlier', 'later'])
  })

  it('archived=true 即使残留 build+queued 也不进入 reservation 候选', async () => {
    const dir = await initQueued('archived-queued', '2026-07-07T08:00:00Z')
    await store.set(dir, 'archived', 'true')

    expect(await scanReadyFromFs(changesDir(), store)).toEqual([])
  })

  it('dep automation=merged → 满足；dep 仍 queued → 不放行', async () => {
    await initQueued('dep', '2026-07-07T08:00:00Z')
    await initQueued('child', '2026-07-07T08:30:00Z', ['dep'])
    // dep 尚未 merged：child 不就绪，dep 就绪
    expect(await scanReadyFromFs(changesDir(), store)).toEqual(['dep'])
    // dep 翻 merged → child 解锁
    const depDir = join(changesDir(), 'dep')
    await store.set(depDir, 'automation', 'merged')
    expect(await scanReadyFromFs(changesDir(), store)).toEqual(['child'])
  })

  it('dep 已归档（archive/*-<dep>）→ 满足', async () => {
    await initQueued('child', '2026-07-07T08:00:00Z', ['archdep'])
    // 没有 archdep 活跃 change 也没归档 → 不就绪
    expect(await scanReadyFromFs(changesDir(), store)).toEqual([])
    // 造一个归档目录 openspec/changes/archive/2026-07-06-archdep
    await mkdir(join(changesDir(), 'archive', '2026-07-06-archdep'), { recursive: true })
    expect(await scanReadyFromFs(changesDir(), store)).toEqual(['child'])
  })

  it('archive 只有 ENOENT 可视为空；其它读取错误必须 fail-loud', async () => {
    await initQueued('child', '2026-07-07T08:00:00Z', ['archdep'])
    await writeFile(join(changesDir(), 'archive'), 'not a directory\n', 'utf8')

    await expect(scanReadyFromFs(changesDir(), store)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
