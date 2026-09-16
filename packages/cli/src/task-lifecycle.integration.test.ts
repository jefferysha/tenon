/**
 * `tenon task delete|archive|unarchive` and `tenon list --archived` end to end: real temporary project,
 * real `init`, real git repository, real kernel application. Deletion is destructive, so the refusal exit
 * codes are asserted together with the state staying intact.
 */
import { execFileSync } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const SLUG = 'tester-at-tenon.test'

let h: Harness

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: h.cwd, encoding: 'utf8' })
}

function initGit(): void {
  git('init', '-q')
  git('config', 'user.email', 'tenon-tests@example.invalid')
  git('config', 'user.name', 'Tenon tests')
  git('add', '-A')
  git('commit', '-qm', 'seed')
}

async function init(name: string): Promise<void> {
  expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function lastJson(): unknown {
  return JSON.parse(h.out[h.out.length - 1] ?? 'null')
}

beforeEach(async () => {
  h = await freshHarness()
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

describe('tenon task delete', () => {
  test('removes the task from the working tree only and reports 未提交删除', async () => {
    await init('feat')
    await init('other')
    initGit()
    const head = git('rev-list', '--count', 'HEAD').trim()

    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(h.err.join('\n')).toContain('[DELETE] feat')
    expect(h.err.join('\n')).toContain('未提交删除 1')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)

    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).not.toContain('feat')
    expect(JSON.stringify(lastJson())).toContain('other')

    const status = git('status', '--porcelain')
    expect(status).toMatch(/^ D openspec\/changes\/feat\//mu)
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(head)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  test('emits the machine shape with --json', async () => {
    await init('feat')
    expect(await h.run(['task', 'delete', 'feat', '--yes', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({ change: 'feat', uncommitted_deletions: null })
    expect((lastJson() as { removed: string[] }).removed).toContain('openspec/changes/feat')
  })

  test('exits 2 for an unacknowledged confirmation and 0 once confirmed, leaving state intact until then', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'review_gate_status', 'pending')
    const before = await h.read('feat')
    expect(await h.run(['task', 'delete', 'feat'])).toBe(2)
    expect(h.err.join('\n')).toContain('评审待确认')
    expect(h.err.join('\n')).toContain('--yes')
    expect(await h.read('feat')).toBe(before)
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)
  })

  test('exits 3 while AFK is running, even with --yes', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'automation', 'running')
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(3)
    expect(h.err.join('\n')).toContain('AFK 运行中')
    expect(h.err.join('\n')).toContain('tenon afk cancel feat')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(true)
  })

  test('exits 1 for a bad name and a missing task', async () => {
    await init('feat')
    expect(await h.run(['task', 'delete', 'archive', '--yes'])).toBe(1)
    expect(h.err.join('\n')).toContain('change-name 非法')
    expect(await h.run(['task', 'delete', 'nope', '--yes'])).toBe(1)
    expect(h.err.join('\n')).toContain('任务不存在: nope')
  })

  test('clears the current user selection of the deleted task', async () => {
    await init('feat')
    expect(await h.run(['session', 'activate', 'feat'])).toBe(0)
    const pointer = join(h.cwd, '.tenon', 'users', SLUG, 'local', 'active-change')
    expect(await readFile(pointer, 'utf8')).toBe('feat\n')
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(await exists(pointer)).toBe(false)
  })
})

describe('tenon task archive / unarchive', () => {
  test('hides the task for this user, records the phase, and restores it', async () => {
    await init('feat')
    await h.seedPhase('feat', 'build')
    const before = await h.read('feat')

    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)
    expect(h.err.join('\n')).toContain('[ARCHIVE] feat phase=build')
    expect(await h.read('feat')).toBe(before)

    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).not.toContain('feat')
    expect(await h.run(['list', '--archived', '--json'])).toBe(0)
    expect(lastJson()).toEqual({
      changes: [{ name: 'feat', phase: 'build', archived_at: expect.any(String), actor: 'Tester' }],
    })
    expect(await h.run(['list', '--archived'])).toBe(0)
    expect(h.out.join('\n')).toContain('NAME')
    expect(h.out.join('\n')).toContain('feat')

    expect(await h.run(['task', 'unarchive', 'feat'])).toBe(0)
    expect(h.err.join('\n')).toContain('[UNARCHIVE] feat')
    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).toContain('feat')
    expect(await h.read('feat')).toBe(before)
  })

  test('is idempotent and machine-readable', async () => {
    await init('feat')
    expect(await h.run(['task', 'archive', 'feat', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({ change: 'feat', changed: true, phase: 'open' })
    expect(await h.run(['task', 'archive', 'feat', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({ change: 'feat', changed: false })
    expect(await h.run(['task', 'unarchive', 'feat', '--json'])).toBe(0)
    expect(lastJson()).toEqual({ change: 'feat', changed: true })
    expect(await h.run(['task', 'unarchive', 'feat', '--json'])).toBe(0)
    expect(lastJson()).toEqual({ change: 'feat', changed: false })
  })

  test('refuses 归档 while AFK is queued', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'automation', 'queued')
    expect(await h.run(['task', 'archive', 'feat', '--yes'])).toBe(3)
    expect(h.err.join('\n')).toContain('AFK 排队')
    expect(h.err.join('\n')).toContain('tenon cas feat automation queued off')
  })

  test('hides the task only for the user who archived it', async () => {
    await init('feat')
    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)
    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).not.toContain('feat')

    const other = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
    expect(await h.run(['list', '--json'], { env: other })).toBe(0)
    expect(JSON.stringify(lastJson())).toContain('feat')
    expect(await h.run(['list', '--archived', '--json'], { env: other })).toBe(0)
    expect(lastJson()).toEqual({ changes: [] })
  })

  test('exits 1 on a malformed archive store without overwriting it', async () => {
    await init('feat')
    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)
    const store = join(h.cwd, '.tenon', 'users', SLUG, 'local', 'archived.json')
    await writeFile(store, 'not json', 'utf8')
    expect(await h.run(['task', 'unarchive', 'feat'])).toBe(1)
    expect(h.err.join('\n')).toContain('归档记录损坏')
    expect(await readFile(store, 'utf8')).toBe('not json')
    expect(await h.run(['list', '--archived'])).toBe(1)
  })

  test('reports an unknown task sub-command with the new verbs', async () => {
    expect(await h.run(['task', 'nope', 'feat'])).toBe(1)
    expect(h.err.join('\n')).toContain('delete archive unarchive')
  })
})

describe('已归档任务拒绝推进', () => {
  test('transition / advance / review request / document record / artifact register 全部 exit 1 并提示取消归档', async () => {
    await init('feat')
    const before = await h.read('feat')
    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)

    for (const argv of [
      ['transition', 'feat', 'open-complete'],
      ['advance', 'feat'],
      ['review', 'request', 'feat'],
      ['document', 'record', 'feat', 'proposal', 'openspec/changes/feat/proposal.md', '--producer', 'tenon-open'],
      ['artifact', 'register', 'feat', 'design_doc', 'docs/x.md', '--producer', 'tenon-explore'],
    ]) {
      expect(await h.run(argv)).toBe(1)
      expect(h.err.join('\n')).toContain("任务 'feat' 已归档")
      expect(h.err.join('\n')).toContain('tenon task unarchive feat')
    }
    expect(await h.read('feat')).toBe(before)
  })

  test('取消归档后不再被归档拒绝；另一个用户始终不受归档影响', async () => {
    await init('feat')
    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)
    expect(await h.run(['transition', 'feat', 'open-complete'])).toBe(1)
    expect(h.err.join('\n')).toContain('已归档')

    // Another identity keeps reading, owning and advancing the task; its transition can only fail on
    // the ordinary workflow guard, never on this user's archive.
    const other = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
    expect(await h.run(['get', 'feat', 'phase'], { env: other })).toBe(0)
    expect(h.out.join('')).toBe('open')
    expect(await h.run(['owner', 'take', 'feat'], { env: other })).toBe(0)
    await h.run(['transition', 'feat', 'open-complete'], { env: other })
    expect(h.err.join('\n')).not.toContain('已归档')

    expect(await h.run(['task', 'unarchive', 'feat'])).toBe(0)
    await h.run(['transition', 'feat', 'open-complete'])
    expect(h.err.join('\n')).not.toContain('已归档')
    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).toContain('feat')
  })

  test('归档不阻断修复路径 get / set / cas', async () => {
    await init('feat')
    expect(await h.run(['task', 'archive', 'feat'])).toBe(0)
    expect(await h.run(['get', 'feat', 'phase'])).toBe(0)
    expect(await h.run(['set', 'feat', 'branch', 'feat/x'])).toBe(0)
    expect(await h.run(['cas', 'feat', 'branch', 'feat/x', 'feat/y'])).toBe(0)
    expect(await h.run(['get', 'feat', 'branch'])).toBe(0)
    expect(h.out.join('')).toBe('feat/y')
  })
})
