import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { collectCodeSize } from './test-code-size.js'

const roots: string[] = []

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' })
}

async function freshRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-code-size-'))
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'a@x.io'])
  git(root, ['config', 'user.name', 'A'])
  await writeFile(join(root, 'base.txt'), 'one\ntwo\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('collectCodeSize', () => {
  test('已提交、未提交与未跟踪的行数都计入；largest 取单文件最大新增', async () => {
    const root = await freshRepo()
    git(root, ['checkout', '-q', '-b', 'feature'])
    await writeFile(join(root, 'base.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(root, 'added.txt'), 'a\nb\nc\nd\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'feature'])
    await writeFile(join(root, 'dirty.txt'), 'x\ny\n')
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'new.txt'), 'p\nq\nr\n')

    const metrics = await collectCodeSize(root, 'main')
    expect(metrics).toEqual({
      files_changed: 4,
      lines_added: 1 + 4 + 2 + 3,
      lines_deleted: 0,
      largest_added_lines: 4,
    })
  })

  test('base 缺省 HEAD 时只剩未跟踪文件；删除行单独计数', async () => {
    const root = await freshRepo()
    await writeFile(join(root, 'untracked.txt'), 'only\n')
    expect(await collectCodeSize(root, 'HEAD')).toEqual({
      files_changed: 1, lines_added: 1, lines_deleted: 0, largest_added_lines: 1,
    })
    await writeFile(join(root, 'base.txt'), 'one\n')
    const metrics = await collectCodeSize(root, 'HEAD')
    expect(metrics?.lines_deleted).toBe(1)
  })

  test('非 git 目录返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-code-size-plain-'))
    roots.push(root)
    expect(await collectCodeSize(root, 'HEAD')).toBeUndefined()
  })
})
