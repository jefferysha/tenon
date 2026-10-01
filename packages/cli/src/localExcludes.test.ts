import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ensureLocalExcludes, HOST_AGENT_EXCLUDES, TEST_OUTPUT_EXCLUDES } from './localExcludes.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-excludes-'))
  roots.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function untracked(dir: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter((line) => line !== '').map((line) => line.slice(3)).sort()
}

function put(dir: string, path: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), 'x\n')
}

describe('ensureLocalExcludes（真机验收 F14 / P2：生成的宿主 agent 与 test-results 在 git status 里不该出现）', () => {
  test('生成物加进 .git/info/exclude 后不再显示为未跟踪；项目根 .gitignore 不被改动；源码照常显示', async () => {
    const dir = repo()
    put(dir, '.claude/agents/tenon-builder.md')
    put(dir, '.claude/agents/my-own.md')
    put(dir, 'test-results/unit.xml')
    put(dir, 'packages/web/playwright-report/index.html')
    put(dir, 'src/a.js')
    expect(untracked(dir)).toEqual(expect.arrayContaining(['.claude/agents/tenon-builder.md', 'test-results/unit.xml']))

    expect(await ensureLocalExcludes(dir, [...HOST_AGENT_EXCLUDES, ...TEST_OUTPUT_EXCLUDES])).toBe('added')
    expect(untracked(dir)).toEqual(['.claude/agents/my-own.md', 'src/a.js'])
    expect(() => readFileSync(join(dir, '.gitignore'), 'utf8')).toThrow()
  })

  test('幂等：再调一次什么都不加；补新规则只追加缺的，保留原有内容', async () => {
    const dir = repo()
    const file = join(dir, '.git', 'info', 'exclude')
    const before = readFileSync(file, 'utf8')
    expect(await ensureLocalExcludes(dir, HOST_AGENT_EXCLUDES)).toBe('added')
    expect(await ensureLocalExcludes(dir, HOST_AGENT_EXCLUDES)).toBe('present')
    expect(await ensureLocalExcludes(dir, [...HOST_AGENT_EXCLUDES, 'test-results/'])).toBe('added')
    const after = readFileSync(file, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.split('\n').filter((line) => line === 'test-results/')).toHaveLength(1)
    expect(after.split('\n').filter((line) => line.startsWith('# Tenon'))).toHaveLength(1)
  })

  test('git worktree 里写到共用的 info/exclude；不是 git 仓时跳过，不建任何文件', async () => {
    const main = repo()
    execFileSync('git', ['-c', 'user.email=t@x.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main })
    const linked = join(main, '..', `${main.split('/').pop()}-wt`)
    roots.push(linked)
    execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'wt'], { cwd: main })
    expect(await ensureLocalExcludes(linked, ['test-results/'])).toBe('added')
    put(linked, 'test-results/a.xml')
    expect(untracked(linked)).toEqual([])
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('test-results/')

    const plain = mkdtempSync(join(tmpdir(), 'tenon-not-a-repo-'))
    roots.push(plain)
    expect(await ensureLocalExcludes(plain, ['test-results/'])).toBe('skipped')
  })
})
