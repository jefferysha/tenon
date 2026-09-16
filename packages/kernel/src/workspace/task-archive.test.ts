import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureUserLocalDir, userProjectPaths } from '../users/user-paths.js'
import type { TenonUser } from '../users/user.js'
import {
  EMPTY_TASK_ARCHIVE, TaskArchivedError,
  assertTaskNotArchived, isArchivedForUser, isTaskLifecycleName, readTaskArchive, serializeTaskArchive,
  taskArchivePath, updateTaskArchiveOf, withoutTaskArchiveEntry,
} from './task-archive.js'

const alice: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const bob: TenonUser = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }

let repo: string

async function seedChange(name: string): Promise<void> {
  await mkdir(join(repo, 'openspec', 'changes', name), { recursive: true })
}

async function writeArchive(user: TenonUser, content: string): Promise<string> {
  const paths = await ensureUserLocalDir(repo, user.slug)
  await writeFile(paths.archived, content, 'utf8')
  return paths.archived
}

function entry(phase: string): { archivedAt: string; phase: string; actor: { id: string; name: string; trust: 'declared' } } {
  return { archivedAt: '2026-09-15T12:00:00.000Z', phase, actor: { id: 'a@x.io', name: 'A', trust: 'declared' } }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-task-archive-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('serializeTaskArchive', () => {
  it('sorts Change keys and writes each on its own 4-space key line', () => {
    const text = serializeTaskArchive({ version: 1, changes: { 'zz-late': entry('build'), 'aa-early': entry('spec') } })
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.split('\n').filter((line) => /^ {4}"[A-Za-z0-9_-]+": \{$/u.test(line)))
      .toEqual(['    "aa-early": {', '    "zz-late": {'])
    expect(text.indexOf('"aa-early"')).toBeLessThan(text.indexOf('"zz-late"'))
    expect(JSON.parse(text)).toEqual({
      version: 1,
      changes: {
        'aa-early': { archived_at: '2026-09-15T12:00:00.000Z', phase: 'spec', actor: { id: 'a@x.io', name: 'A', trust: 'declared' } },
        'zz-late': { archived_at: '2026-09-15T12:00:00.000Z', phase: 'build', actor: { id: 'a@x.io', name: 'A', trust: 'declared' } },
      },
    })
  })
})

describe('isTaskLifecycleName', () => {
  it('accepts the Change grammar and refuses the OpenSpec archive directory', () => {
    expect(isTaskLifecycleName('add-login')).toBe(true)
    expect(isTaskLifecycleName('archive')).toBe(false)
    for (const bad of ['', '..', 'a/b', 'a b', 'a.b']) expect(isTaskLifecycleName(bad)).toBe(false)
  })
})

describe('readTaskArchive', () => {
  it('reads an absent store as empty', async () => {
    expect(await readTaskArchive(repo, alice)).toEqual({ kind: 'ok', archive: EMPTY_TASK_ARCHIVE })
  })

  it('reports a malformed store as corrupt with its path', async () => {
    const path = taskArchivePath(repo, alice)
    for (const bad of [
      '{',
      '[]',
      '{"version":2,"changes":{}}',
      '{"version":1}',
      '{"version":1,"changes":{},"extra":1}',
      '{"version":1,"changes":{"archive":{"archived_at":"2026-09-15T12:00:00Z","phase":"build","actor":{"id":"a@x.io","name":"A","trust":"declared"}}}}',
      '{"version":1,"changes":{"a b":{"archived_at":"2026-09-15T12:00:00Z","phase":"build","actor":{"id":"a@x.io","name":"A","trust":"declared"}}}}',
      '{"version":1,"changes":{"x":{"archived_at":"2026-09-15T12:00:00Z","phase":"build"}}}',
      '{"version":1,"changes":{"x":{"archived_at":"not-a-date","phase":"build","actor":{"id":"a@x.io","name":"A","trust":"declared"}}}}',
      '{"version":1,"changes":{"x":{"archived_at":"2026-09-15T12:00:00Z","phase":"","actor":{"id":"a@x.io","name":"A","trust":"declared"}}}}',
      '{"version":1,"changes":{"x":{"archived_at":"2026-09-15T12:00:00Z","phase":"build","actor":{"id":"a@x.io","name":"A"}}}}',
    ]) {
      await writeArchive(alice, bad)
      expect(await readTaskArchive(repo, alice)).toEqual({ kind: 'corrupt', path })
    }
  })

  it('treats a symlinked store as corrupt', async () => {
    const paths = await ensureUserLocalDir(repo, alice.slug)
    await writeFile(join(repo, 'elsewhere.json'), '{"version":1,"changes":{}}', 'utf8')
    await symlink(join(repo, 'elsewhere.json'), paths.archived)
    expect(await readTaskArchive(repo, alice)).toEqual({ kind: 'corrupt', path: paths.archived })
  })

  it('drops entries whose Change directory is gone', async () => {
    await seedChange('kept')
    await writeArchive(alice, serializeTaskArchive({ version: 1, changes: { kept: entry('build'), gone: entry('spec') } }))
    const read = await readTaskArchive(repo, alice)
    expect(read.kind === 'ok' && Object.keys(read.archive.changes)).toEqual(['kept'])
  })
})

describe('updateTaskArchiveOf', () => {
  it('writes 0600 and reports no change when the editor declines', async () => {
    await seedChange('add-login')
    const written = await updateTaskArchiveOf(repo, alice.slug, (archive) => ({
      version: 1, changes: { ...archive.changes, 'add-login': entry('build') },
    }))
    expect(written).toEqual({
      kind: 'ok', archive: { version: 1, changes: { 'add-login': entry('build') } }, changed: true, written: true,
    })
    const path = userProjectPaths(repo, alice.slug).archived
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toBe(serializeTaskArchive({ version: 1, changes: { 'add-login': entry('build') } }))
    const again = await updateTaskArchiveOf(repo, alice.slug, () => null)
    expect(again).toEqual({
      kind: 'ok', archive: { version: 1, changes: { 'add-login': entry('build') } }, changed: false, written: false,
    })
  })

  it('rewrites the store when pruning drops a deleted Change', async () => {
    await seedChange('add-login')
    await updateTaskArchiveOf(repo, alice.slug, () => ({ version: 1, changes: { 'add-login': entry('build') } }))
    await rm(join(repo, 'openspec', 'changes', 'add-login'), { recursive: true, force: true })
    const update = await updateTaskArchiveOf(repo, alice.slug, (archive) => withoutTaskArchiveEntry(archive, 'add-login'))
    expect(update).toEqual({ kind: 'ok', archive: EMPTY_TASK_ARCHIVE, changed: false, written: true })
    expect(await readFile(userProjectPaths(repo, alice.slug).archived, 'utf8')).toBe(serializeTaskArchive(EMPTY_TASK_ARCHIVE))
  })

  it('refuses a corrupt store without touching the bytes', async () => {
    const path = await writeArchive(alice, 'not json')
    expect(await updateTaskArchiveOf(repo, alice.slug, () => EMPTY_TASK_ARCHIVE)).toEqual({ kind: 'corrupt', path })
    expect(await readFile(path, 'utf8')).toBe('not json')
  })
})

describe('isArchivedForUser / assertTaskNotArchived', () => {
  it('is per user and fails open for a missing identity or a corrupt store', async () => {
    await seedChange('add-login')
    await updateTaskArchiveOf(repo, alice.slug, () => ({ version: 1, changes: { 'add-login': entry('build') } }))
    expect(await isArchivedForUser(repo, alice, 'add-login')).toBe(true)
    expect(await isArchivedForUser(repo, bob, 'add-login')).toBe(false)
    expect(await isArchivedForUser(repo, { missing: true }, 'add-login')).toBe(false)
    await expect(assertTaskNotArchived(repo, alice, 'add-login')).rejects.toBeInstanceOf(TaskArchivedError)
    await expect(assertTaskNotArchived(repo, alice, 'add-login')).rejects.toThrow('tenon task unarchive add-login')
    await expect(assertTaskNotArchived(repo, bob, 'add-login')).resolves.toBeUndefined()
    await expect(assertTaskNotArchived(repo, { missing: true }, 'add-login')).resolves.toBeUndefined()
    await writeArchive(alice, '{')
    expect(await isArchivedForUser(repo, alice, 'add-login')).toBe(false)
    await expect(assertTaskNotArchived(repo, alice, 'add-login')).resolves.toBeUndefined()
  })

  it('carries the code and Change on the error', async () => {
    const error = new TaskArchivedError('add-login')
    expect(error.code).toBe('task-archived')
    expect(error.change).toBe('add-login')
    expect(error.name).toBe('TaskArchivedError')
  })
})
