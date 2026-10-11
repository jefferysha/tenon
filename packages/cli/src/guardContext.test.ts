import { constants, openSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStateStore } from '@tenon/kernel'
import { makeGuardCtx, readBoundedRegularFileSync } from './guardContext.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

describe('guard context dependency archive sources', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guard-context-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('active dependency trusts only its canonical archived field, not a stale same-name archive', async () => {
    const store = createStateStore()
    const dependency = await store.init({
      repoRoot: root,
      name: 'dep',
      track: 'simple',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'tweak',
      clock: () => '2026-07-24T00:00:00Z',
    })
    await mkdir(join(root, 'openspec', 'changes', 'archive', '2026-07-01-dep'), { recursive: true })

    const context = makeGuardCtx(root)('subject')
    expect(context.dirExists?.('openspec/changes/dep')).toBe(true)
    expect(context.changeArchived?.('dep')).toBe(true)
    expect(context.activeChangeArchived?.('dep')).toBe(false)

    await store.set(dependency, 'archived', 'true')
    expect(context.activeChangeArchived?.('dep')).toBe(true)
  })

  test('damaged active canonical state fails closed even when a stale physical archive exists', async () => {
    const store = createStateStore()
    const dependency = await store.init({
      repoRoot: root,
      name: 'dep',
      track: 'simple',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'tweak',
      clock: () => '2026-07-24T00:00:00Z',
    })
    await mkdir(join(root, 'openspec', 'changes', 'archive', '2026-07-01-dep'), { recursive: true })
    await writeFile(join(dependency, '.pipeline-run', 'current.json'), '{broken', 'utf8')

    const context = makeGuardCtx(root)('subject')
    expect(context.changeArchived?.('dep')).toBe(true)
    expect(context.activeChangeArchived?.('dep')).toBe(false)
  })

  describe('physical archive name matching', () => {
    async function archived(...dirs: readonly string[]): Promise<(dep: string) => boolean | undefined> {
      for (const dir of dirs) await mkdir(join(root, 'openspec', 'changes', 'archive', dir), { recursive: true })
      const context = makeGuardCtx(root)('subject')
      return (dep) => context.changeArchived?.(dep)
    }

    test('a dependency is not ended just because another archived task name ends with it', async () => {
      const ended = await archived('2026-10-01-new-api', '2026-10-01-legacy_api')
      expect(ended('api')).toBe(false)
    })

    test('the dated archive directory of exactly that task counts', async () => {
      const ended = await archived('2026-10-01-api', '2026-10-01-new-api')
      expect(ended('api')).toBe(true)
      expect(ended('new-api')).toBe(true)
    })

    test('a same-day numeric suffix still belongs to the same dependency', async () => {
      const ended = await archived('2026-10-01-api-2')
      expect(ended('api')).toBe(true)
    })

    test('a dependency whose own name ends in digits matches itself and its suffixed archives only', async () => {
      const ended = await archived('2026-10-01-release-2', '2026-10-02-v3-4')
      expect(ended('release-2')).toBe(true)
      expect(ended('release')).toBe(true)
      expect(ended('v3-4')).toBe(true)
      expect(ended('v3')).toBe(true)
      expect(ended('v3-4-5')).toBe(false)
      expect(ended('v3-5')).toBe(false)
    })

    test('a suffixed archive of a longer name does not satisfy the shorter one', async () => {
      const ended = await archived('2026-10-01-api-gateway-2', '2026-10-01-api-v2')
      expect(ended('api')).toBe(false)
    })

    test('directories without a calendar-shaped date prefix are not task archives', async () => {
      const ended = await archived('api', 'x-api', '2026-10-1-api', '26-10-01-api', '2026-10-01_api', 'before-2026-10-01-api')
      expect(ended('api')).toBe(false)
    })

    test('regex metacharacters in a dependency name are matched literally', async () => {
      const ended = await archived('2026-10-01-abc', '2026-10-01-a.c')
      expect(ended('a.c')).toBe(true)
      expect(ended('a.b')).toBe(false)
      expect(ended('a+')).toBe(false)
      expect(ended('.*')).toBe(false)
    })

    test('a plain file with an archive-looking name does not count', async () => {
      await mkdir(join(root, 'openspec', 'changes', 'archive'), { recursive: true })
      await writeFile(join(root, 'openspec', 'changes', 'archive', '2026-10-01-api'), 'x', 'utf8')
      expect(makeGuardCtx(root)('subject').changeArchived?.('api')).toBe(false)
    })

    test('a missing archive directory means nothing has ended', () => {
      expect(makeGuardCtx(root)('subject').changeArchived?.('api')).toBe(false)
    })
  })

  test('bounded reader rejects an oversized sparse tasks file before materializing its contents', async () => {
    const tasks = join(root, 'openspec', 'changes', 'subject', 'tasks.md')
    await mkdir(join(tasks, '..'), { recursive: true })
    await writeFile(tasks, '# Tasks\n', 'utf8')
    await truncate(tasks, 1_048_578)

    const context = makeGuardCtx(root)('subject')
    expect(context.readFileBounded?.('openspec/changes/subject/tasks.md', 1_048_577))
      .toEqual({ kind: 'invalid' })
  })

  test('bounded reader accepts the exact UTF-8 byte boundary and rejects invalid UTF-8', async () => {
    const tasks = join(root, 'openspec', 'changes', 'subject', 'tasks.md')
    await mkdir(join(tasks, '..'), { recursive: true })
    await writeFile(tasks, 'abcd', 'utf8')
    const context = makeGuardCtx(root)('subject')
    expect(context.readFileBounded?.('openspec/changes/subject/tasks.md', 4))
      .toEqual({ kind: 'ok', text: 'abcd' })
    await writeFile(tasks, Buffer.from([0xc3, 0x28]))
    expect(context.readFileBounded?.('openspec/changes/subject/tasks.md', 4))
      .toEqual({ kind: 'invalid' })
  })

  test('bounded reader requests a nonblocking open before leaf identity verification', async () => {
    const tasks = join(root, 'openspec', 'changes', 'subject', 'tasks.md')
    await mkdir(join(tasks, '..'), { recursive: true })
    await writeFile(tasks, '# Tasks\n', 'utf8')
    let observedFlags = 0

    expect(readBoundedRegularFileSync(tasks, 1024, root, {
      openFile: (path, flags) => {
        observedFlags = flags
        return openSync(path, flags)
      },
    })).toEqual({ kind: 'ok', text: '# Tasks\n' })
    expect(observedFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
  })

  test('bounded reader rejects a regular leaf reached through an ancestor symlink outside the project root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tenon-bounded-reader-outside-'))
    const outsideChange = join(outside, 'changes', 'subject')
    await mkdir(outsideChange, { recursive: true })
    await writeFile(join(outsideChange, 'tasks.md'), '# Tasks\n', 'utf8')
    await symlink(outside, join(root, 'openspec'))
    try {
      const context = makeGuardCtx(root)('subject')
      expect(context.readFileBounded?.('openspec/changes/subject/tasks.md', 1024))
        .toEqual({ kind: 'invalid' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('bounded reader rejects a symlink passed as the project root anchor', async () => {
    const alias = `${root}-alias`
    const tasks = join(root, 'openspec', 'changes', 'subject', 'tasks.md')
    await mkdir(join(tasks, '..'), { recursive: true })
    await writeFile(tasks, '# Tasks\n', 'utf8')
    await symlink(root, alias)
    try {
      const context = makeGuardCtx(alias)('subject')
      expect(context.readFileBounded?.('openspec/changes/subject/tasks.md', 1024))
        .toEqual({ kind: 'invalid' })
    } finally {
      await rm(alias, { force: true })
    }
  })
})
