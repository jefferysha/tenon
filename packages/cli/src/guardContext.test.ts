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
