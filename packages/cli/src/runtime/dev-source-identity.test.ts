import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  checkTenonSourceRepo, compareDevSource, computeDevSourceIdentity, computeSkillsIndexDigest,
  computeWorktreeDigest, DEV_PAYLOAD_PATHSPECS, devSourceEquals, devVersionLabel, gitBlobId,
  resolveSourceRepo,
} from './dev-source-identity.js'
import {
  cleanupSourceRepoFixtures, gitIn as git, makeSourceRepo, trackFixtureRoot, writeFixtureFile as write,
} from './dev-source-test-support.js'

afterEach(cleanupSourceRepoFixtures)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

describe('checkTenonSourceRepo', () => {
  test('accepts a repository that meets the four criteria', () => {
    expect(checkTenonSourceRepo(makeSourceRepo())).toEqual({ ok: true })
  })

  test.each([
    ['root package.json name', (root: string) => write(root, 'package.json', JSON.stringify({ name: 'other' }))],
    ['marketplace name', (root: string) => write(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'other', plugins: [{ source: './' }] }))],
    ['marketplace plugins[0].source', (root: string) => write(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'tenon', plugins: [{ source: './sub' }] }))],
    ['skills/sources.yaml', (root: string) => rmSync(join(root, 'skills', 'sources.yaml'))],
    ['runtime/tenon-bootstrap.mjs', (root: string) => rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))],
  ])('rejects when %s is wrong or missing', (_label, damage) => {
    const root = makeSourceRepo()
    damage(root)
    const verdict = checkTenonSourceRepo(root)
    expect(verdict.ok).toBe(false)
  })
})

describe('resolveSourceRepo', () => {
  test('resolves a symlinked path to the repository realpath', () => {
    const root = makeSourceRepo()
    const link = join(trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-link-')))), 'link')
    symlinkSync(root, link)
    expect(resolveSourceRepo(link)).toEqual({ ok: true, repo: root })
  })

  test('rejects a sub directory, a missing path, an empty value, and a non-git tree', () => {
    const root = makeSourceRepo()
    expect(resolveSourceRepo(join(root, 'hooks')).ok).toBe(false)
    expect(resolveSourceRepo(join(root, 'does-not-exist')).ok).toBe(false)
    expect(resolveSourceRepo('  ').ok).toBe(false)
    const bare = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-nogit-'))))
    expect(resolveSourceRepo(bare).ok).toBe(false)
  })
})

describe('gitBlobId', () => {
  test('equals what git hash-object prints for the same bytes', () => {
    const bytes = Buffer.from('hello\nworld\n', 'utf8')
    const expected = execFileSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8', env: GIT_ENV }).trim()
    expect(gitBlobId(bytes)).toBe(expected)
  })
})

describe('computeWorktreeDigest', () => {
  test('follows the documented git recipe exactly', () => {
    const root = makeSourceRepo()
    const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...DEV_PAYLOAD_PATHSPECS])
      .split('\n').filter((line) => line !== '').sort()
    const ids = git(root, ['hash-object', '--no-filters', '--stdin-paths'], `${files.join('\n')}\n`).trim().split('\n')
    const manifest = files.map((file, index) => `${ids[index]} ${file}\n`).join('')
    const expected = git(root, ['hash-object', '--stdin'], manifest).trim()
    expect(computeWorktreeDigest(root)).toBe(expected)
  })

  test('changes when installed content changes, is added, or is deleted', () => {
    const root = makeSourceRepo()
    const base = computeWorktreeDigest(root)
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    const edited = computeWorktreeDigest(root)
    expect(edited).not.toBe(base)
    write(root, 'templates/new.md', 'new\n')
    const added = computeWorktreeDigest(root)
    expect(added).not.toBe(edited)
    rmSync(join(root, 'templates', 'new.md'))
    rmSync(join(root, 'hooks', 'gate.sh'))
    expect(computeWorktreeDigest(root)).not.toBe(base)
  })

  test('ignores ignored upstream skills and files outside the payload', () => {
    const root = makeSourceRepo()
    const base = computeWorktreeDigest(root)
    appendFileSync(join(root, 'skills', 'ignored-skill', 'SKILL.md'), 'more\n')
    appendFileSync(join(root, 'skills', 'skills.lock.json'), '\n')
    appendFileSync(join(root, 'docs', 'readme.md'), 'more docs\n')
    expect(computeWorktreeDigest(root)).toBe(base)
  })

  test('is the same before and after staging and committing the same content', () => {
    const root = makeSourceRepo()
    write(root, 'hooks/new.sh', '#!/usr/bin/env bash\n')
    const untracked = computeWorktreeDigest(root)
    git(root, ['add', 'hooks/new.sh'])
    expect(computeWorktreeDigest(root)).toBe(untracked)
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'add new hook'])
    expect(computeWorktreeDigest(root)).toBe(untracked)
  })
})

describe('computeSkillsIndexDigest', () => {
  test('is the git blob id of the raw lock bytes, and absent without a lock', () => {
    const root = makeSourceRepo()
    const expected = git(root, ['hash-object', '--no-filters', 'skills/skills.lock.json']).trim()
    expect(computeSkillsIndexDigest(root)).toBe(expected)
    rmSync(join(root, 'skills', 'skills.lock.json'))
    expect(computeSkillsIndexDigest(root)).toBe('absent')
  })
})

describe('computeDevSourceIdentity', () => {
  test('freezes realpath, HEAD commit, dirty flag and both digests', () => {
    const root = makeSourceRepo()
    const identity = computeDevSourceIdentity(root)
    expect(identity).toMatchObject({
      kind: 'dev',
      repoRealpath: root,
      commit: git(root, ['rev-parse', 'HEAD']).trim(),
      dirty: false,
    })
    expect(identity.worktreeDigest).toMatch(/^[0-9a-f]{40}$/)
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    expect(computeDevSourceIdentity(root).dirty).toBe(true)
  })

  test('a docs-only change is not dirty for the installed payload', () => {
    const root = makeSourceRepo()
    appendFileSync(join(root, 'docs', 'readme.md'), 'x\n')
    expect(computeDevSourceIdentity(root).dirty).toBe(false)
  })

  test('refuses a repository without any commit and one that is not a Tenon source repository', () => {
    expect(() => computeDevSourceIdentity(makeSourceRepo({ commit: false }))).toThrow('还没有任何提交')
    const root = makeSourceRepo()
    rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))
    expect(() => computeDevSourceIdentity(root)).toThrow('不是 Tenon 源码仓库')
  })
})

describe('compareDevSource', () => {
  const installed = {
    kind: 'dev' as const, repoRealpath: '/work/tenon', commit: 'a'.repeat(40), dirty: false,
    worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
  }

  test('commit and dirty are informational, not drift', () => {
    const live = { ...installed, commit: 'd'.repeat(40), dirty: true }
    expect(compareDevSource(installed, live)).toEqual([])
    expect(devSourceEquals(installed, live)).toBe(false)
  })

  test('reports repo, worktree and skills-index separately', () => {
    const reasons = compareDevSource(installed, {
      ...installed, repoRealpath: '/other/tenon', worktreeDigest: '1'.repeat(40), skillsIndexDigest: 'absent',
    })
    expect(reasons).toHaveLength(3)
    expect(reasons.join('\n')).toContain('/other/tenon')
  })
})

describe('devVersionLabel', () => {
  test('appends +dev and the short commit without touching the version', () => {
    expect(devVersionLabel('0.3.2', 'abcdef0123456789abcdef0123456789abcdef01')).toBe('0.3.2+dev.abcdef0')
  })
})
