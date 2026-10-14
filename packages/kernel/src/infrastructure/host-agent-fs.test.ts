import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { inspectFile, isNotFound, writeAtomic } from './host-agent-fs.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tenon-host-fs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeAtomic', () => {
  test('缺的父目录一并建出，内容写入，不留临时文件', async () => {
    const path = join(dir, 'a', 'b', 'x.md')
    await writeAtomic(path, '内容\n')
    expect(readFileSync(path, 'utf8')).toBe('内容\n')
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['x.md'])
  })

  test('覆盖已有文件', async () => {
    const path = join(dir, 'x.md')
    writeFileSync(path, '旧\n')
    await writeAtomic(path, '新\n')
    expect(readFileSync(path, 'utf8')).toBe('新\n')
  })

  test('目标位置是目录 → 抛错，临时文件被清掉', async () => {
    const path = join(dir, 'x.md')
    mkdirSync(path)
    await expect(writeAtomic(path, '新\n')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['x.md'])
  })
})

describe('inspectFile', () => {
  test('不存在 → missing', async () => {
    expect(await inspectFile(join(dir, 'none.md'))).toEqual({ kind: 'missing' })
  })

  test('普通文件 → file 与内容', async () => {
    const path = join(dir, 'x.md')
    writeFileSync(path, '内容\n')
    expect(await inspectFile(path)).toEqual({ kind: 'file', text: '内容\n' })
  })

  test('符号链接 → link，不跟随、不读链接目标', async () => {
    const target = join(dir, 'target.md')
    writeFileSync(target, '链接目标\n')
    const link = join(dir, 'link.md')
    symlinkSync(target, link)
    expect(await inspectFile(link)).toEqual({ kind: 'link' })
    expect(existsSync(target)).toBe(true)
  })

  test('悬空的符号链接 → 同样是 link', async () => {
    const link = join(dir, 'dangling.md')
    symlinkSync(join(dir, 'nowhere'), link)
    expect(await inspectFile(link)).toEqual({ kind: 'link' })
  })

  test('路径上有一段不是目录 → 抛错（不是 missing，也不吞）', async () => {
    const file = join(dir, 'plain')
    writeFileSync(file, 'x')
    await expect(inspectFile(join(file, 'child.md'))).rejects.toThrow()
  })
})

describe('isNotFound', () => {
  test('只认 ENOENT', () => {
    expect(isNotFound(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isNotFound(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false)
    expect(isNotFound('ENOENT')).toBe(false)
  })
})
