import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureCheckpoint,
  compareCheckpoint,
  isObservedPath,
  workingFileSha,
  type CheckpointOptions,
  type StepCheckpoint,
} from './step-checkpoint.js'

const roots: string[] = []
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
}
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
function repo(): string {
  const root = tempDir('step-checkpoint-')
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), '# readme\n')
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  mkdirSync(join(root, 'openspec', 'changes', 'demo'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), '# tasks\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function entry(root: string): Promise<StepCheckpoint> {
  const capture = await captureCheckpoint(root, 'demo')
  if (capture.kind !== 'captured') throw new Error(`capture failed: ${capture.kind}`)
  return capture.checkpoint
}

describe('compareCheckpoint', () => {
  test('新增、修改、删除都记下，内容没变的不算', async () => {
    const root = repo()
    writeFileSync(join(root, 'scratch.md'), 'before\n') // 进入前就有的未跟踪改动
    const start = await entry(root)
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'design.md'), '# design\n')
    writeFileSync(join(root, 'README.md'), '# readme v2\n')
    rmSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'))
    const result = await compareCheckpoint(root, 'demo', start)
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') return
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([
      ['README.md', 'modified'],
      ['docs/design.md', 'added'],
      ['openspec/changes/demo/tasks.md', 'deleted'],
    ])
    expect(result.changes.find((c) => c.path === 'openspec/changes/demo/tasks.md')?.sha256).toBeNull()
  })

  test('被忽略的、Tenon 状态、其他任务目录与任务目录下的点文件都不观察', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'ignored.txt'), 'x')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', '.pipeline-history.jsonl'), '{}\n')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', '.breadcrumb'), 'x')
    mkdirSync(join(root, 'openspec', 'changes', 'other'), { recursive: true })
    writeFileSync(join(root, 'openspec', 'changes', 'other', 'proposal.md'), '# other\n')
    mkdirSync(join(root, '.tenon'), { recursive: true })
    writeFileSync(join(root, '.tenon', 'x.json'), '{}')
    writeFileSync(join(root, 'openspec', 'changes', 'demo', 'proposal.md'), '# mine\n')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => c.path)).toEqual(['openspec/changes/demo/proposal.md'])
  })

  test('访问内的本任务提交算产出', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'src.ts'), 'export const a = 1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'work')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['src.ts', 'added']])
  })

  test('rebase 到新上游：上游改动不算，本任务的未提交改动照算', async () => {
    const root = repo()
    git(root, 'checkout', '-q', '-b', 'task')
    // 模拟上游：main 上多一个改 README 的提交，并让 refs/remotes/origin/HEAD 指向它
    git(root, 'checkout', '-q', 'main')
    writeFileSync(join(root, 'README.md'), '# upstream\n')
    git(root, 'commit', '-q', '-am', 'upstream')
    git(root, 'update-ref', 'refs/remotes/origin/HEAD', 'main')
    git(root, 'checkout', '-q', 'task')
    const start = await entry(root)
    writeFileSync(join(root, 'mine.md'), '# mine\n')
    git(root, 'rebase', '-q', 'main')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => c.path)).toEqual(['mine.md'])
  })

  test('rebase 之后本任务自己提交的改动照算，上游提交里的文件不算', async () => {
    const root = repo()
    git(root, 'checkout', '-q', '-b', 'task')
    writeFileSync(join(root, 'early.md'), '# early\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'task before step')
    git(root, 'checkout', '-q', 'main')
    writeFileSync(join(root, 'upstream.md'), '# upstream\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'upstream')
    git(root, 'update-ref', 'refs/remotes/origin/HEAD', 'main')
    git(root, 'checkout', '-q', 'task')
    const start = await entry(root)
    writeFileSync(join(root, 'mine.md'), '# mine\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'task during step')
    git(root, 'rebase', '-q', 'main')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['mine.md', 'added']])
  })

  test('本步新增又删除、内容没变化的文件不留痕', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'tmp.md'), 'x')
    rmSync(join(root, 'tmp.md'))
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes).toEqual([])
  })

  test('进入前已有的未提交改动，本步再改一次算修改', async () => {
    const root = repo()
    writeFileSync(join(root, 'README.md'), '# v1\n')
    const start = await entry(root)
    writeFileSync(join(root, 'README.md'), '# v2\n')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['README.md', 'modified']])
  })

  test('进入时仓库还没有提交，本步第一次提交的文件算新增', async () => {
    const root = tempDir('step-checkpoint-unborn-')
    git(root, 'init', '-q', '-b', 'main')
    const start = await entry(root)
    expect(start.head).toBeNull()
    writeFileSync(join(root, 'first.md'), '# first\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'first')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['first.md', 'added']])
  })

  test('符号链接按链接目标取摘要', async () => {
    const root = repo()
    const start = await entry(root)
    symlinkSync('README.md', join(root, 'link.md'))
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes.map((c) => [c.path, c.change])).toEqual([['link.md', 'added']])
  })

  test('符号链接先未提交、后提交（内容不变）不算修改', async () => {
    const root = repo()
    symlinkSync('README.md', join(root, 'link.md'))
    const start = await entry(root)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'link')
    const result = await compareCheckpoint(root, 'demo', start)
    if (result.kind !== 'observed') throw new Error(result.kind)
    expect(result.changes).toEqual([])
  })

  test('比较时改动超过上限：truncated', async () => {
    const root = repo()
    const start = await entry(root)
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    expect((await compareCheckpoint(root, 'demo', start, { pathLimit: 1 })).kind).toBe('truncated')
  })

  test('检查点里的 HEAD 不是提交号：unavailable，不把账本文本当 git 参数', async () => {
    const root = repo()
    const forged: StepCheckpoint = { head: '--output=/tmp/pwned', files: {} }
    expect((await compareCheckpoint(root, 'demo', forged)).kind).toBe('unavailable')
  })

  test('git 子进程失败：unavailable，不抛给调用方', async () => {
    const root = repo()
    const start = await entry(root)
    const runGit: CheckpointOptions['runGit'] = async () => { throw new Error('git blew up') }
    const result = await compareCheckpoint(root, 'demo', start, { runGit })
    expect(result.kind).toBe('unavailable')
  })
})

describe('captureCheckpoint', () => {
  test('记下 HEAD 与相对 HEAD 有改动的文件摘要', async () => {
    const root = repo()
    writeFileSync(join(root, 'scratch.md'), 'before\n')
    rmSync(join(root, 'README.md'))
    const start = await entry(root)
    expect(start.head).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(Object.keys(start.files).sort()).toEqual(['README.md', 'scratch.md'])
    expect(start.files['README.md']).toBeNull()
    expect(start.files['scratch.md']).toMatch(/^[0-9a-f]{64}$/u)
  })

  test('不是 git 仓库：unavailable', async () => {
    const root = tempDir('step-checkpoint-nogit-')
    expect((await captureCheckpoint(root, 'demo')).kind).toBe('unavailable')
  })

  test('项目根不是 git 工作区根目录（嵌套在子目录里）：unavailable', async () => {
    const root = repo()
    const sub = join(root, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    const result = await captureCheckpoint(sub, 'demo')
    expect(result.kind).toBe('unavailable')
  })

  test('改动超过上限：truncated', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    expect((await captureCheckpoint(root, 'demo', { pathLimit: 1 })).kind).toBe('truncated')
  })

  test('git 输出超出缓冲上限：truncated', async () => {
    const root = repo()
    const runGit: CheckpointOptions['runGit'] = async (args) => {
      if (args.includes('status')) throw Object.assign(new Error('too much'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      return args[0] === 'rev-parse' && args.includes('--show-prefix') ? 'true\n\n' : 'a'.repeat(40) + '\n'
    }
    expect((await captureCheckpoint(root, 'demo', { runGit })).kind).toBe('truncated')
  })

  test('git 子进程失败：unavailable 并带原因', async () => {
    const root = repo()
    const runGit: CheckpointOptions['runGit'] = async () => { throw new Error('boom') }
    const result = await captureCheckpoint(root, 'demo', { runGit })
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.reason).toContain('boom')
  })

  test('仓库配置里的 fsmonitor 命令不会被执行', async () => {
    const root = repo()
    const marker = join(root, '..', `${root.split('/').pop() ?? 'repo'}-fsmonitor-ran`)
    roots.push(marker)
    const hook = join(tempDir('step-checkpoint-hook-'), 'fsmonitor.sh')
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 })
    git(root, 'config', 'core.fsmonitor', hook)
    expect((await captureCheckpoint(root, 'demo')).kind).toBe('captured')
    expect(existsSync(marker)).toBe(false)
  })

  test('几百个改动文件也能全部取到摘要（分批并行，顺序与路径对应）', async () => {
    const root = repo()
    const names = Array.from({ length: 300 }, (_, index) => `bulk/f${String(index).padStart(3, '0')}.md`)
    mkdirSync(join(root, 'bulk'))
    for (const [index, name] of names.entries()) writeFileSync(join(root, name), `content ${index}`)
    const start = await entry(root)
    expect(Object.keys(start.files)).toEqual(names)
    expect(new Set(Object.values(start.files)).size).toBe(300)
  })

  test('路径里带换行的文件不观察（无法安全地交给 git 的逐行接口）', async () => {
    const root = repo()
    writeFileSync(join(root, 'bad\nname.md'), 'x')
    const start = await entry(root)
    expect(Object.keys(start.files)).toEqual([])
  })
})

describe('workingFileSha', () => {
  test('普通文件取内容摘要，不存在为 null，目录与特殊文件不观察', async () => {
    const root = tempDir('step-checkpoint-sha-')
    writeFileSync(join(root, 'a.md'), 'hello')
    mkdirSync(join(root, 'dir'))
    expect(await workingFileSha(root, 'a.md')).toMatch(/^[0-9a-f]{64}$/u)
    expect(await workingFileSha(root, 'missing.md')).toBeNull()
    expect(await workingFileSha(root, 'dir')).toBeUndefined()
  })

  test('符号链接按链接目标取摘要，不跟随到目标内容', async () => {
    const root = tempDir('step-checkpoint-sha-link-')
    writeFileSync(join(root, 'a.md'), 'hello')
    symlinkSync('a.md', join(root, 'link.md'))
    const direct = await workingFileSha(root, 'a.md')
    expect(await workingFileSha(root, 'link.md')).not.toBe(direct)
  })
})

describe('isObservedPath', () => {
  test.each([
    ['docs/x.md', true],
    ['CONTEXT.md', true],
    ['specs/001-demo/spec.md', true],
    ['openspec/changes/demo/specs/cap/spec.md', true],
    ['openspec/changes/demo/.openspec.yaml', false],
    ['openspec/changes/demo/.pipeline-run/current.json', false],
    ['openspec/changes/other/proposal.md', false],
    ['openspec/changes/archive/2026-01-01-x/proposal.md', false],
    ['openspec/.gitignore', false],
    ['.pipeline/workflows/default.yaml', false],
    ['.claude/agents/tenon-builder.md', false],
    ['.github/hooks/pre-commit', false],
    ['.github/workflows/ci.yml', true],
    ['packages/x/node_modules/y.js', false],
    ['docs/bad\nname.md', false],
    ['docs/bad�name.md', false],
    [`docs/${'x'.repeat(1030)}.md`, false],
  ])('%s → %s', (path, expected) => {
    expect(isObservedPath(path, 'demo')).toBe(expected)
  })
})
