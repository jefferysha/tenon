import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  documentPathAllowed,
  readBoundedRegularFile,
  readOptionalBoundedRegularTextFile,
  readOptionalBoundedRegularTextFileFromAnchoredDirectory,
  resolveDocument,
} from './document-path.js'

describe('document path rules', () => {
  it('DESIGN.md 只属于 design-md；design-md 只能在 DESIGN.md（E14 / E15）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-document-path-'))
    try {
      await writeFile(join(dir, 'DESIGN.md'), '# Design\n')
      await mkdir(join(dir, 'docs'), { recursive: true })
      await writeFile(join(dir, 'docs', 'DESIGN.md'), '# Design\n')
      await expect(resolveDocument(dir, 'DESIGN.md', undefined, 'design-md')).resolves.toMatchObject({ relativePath: 'DESIGN.md' })
      await expect(resolveDocument(dir, 'docs/DESIGN.md', undefined, 'design-md'))
        .rejects.toThrow("document 'design-md' 的路径必须是 DESIGN.md")
      await expect(resolveDocument(dir, 'DESIGN.md', undefined, 'proposal'))
        .rejects.toThrow('document path 只能位于 openspec/ 或 docs/: DESIGN.md')
      await expect(resolveDocument(dir, 'DESIGN.md')).rejects.toThrow('document path 只能位于 openspec/ 或 docs/: DESIGN.md')
      expect(documentPathAllowed('design-md', 'DESIGN.md')).toBe(true)
      expect(documentPathAllowed('design-md', 'docs/DESIGN.md')).toBe(false)
      expect(documentPathAllowed('adr', 'docs/adr/demo.md')).toBe(true)
      expect(documentPathAllowed(undefined, 'README.md')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('bounded regular file identity fence', () => {
  it('rejects a same-inode same-size mutation during the read window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-bounded-file-race-'))
    const path = join(dir, 'current.json')
    const before = Buffer.from('{"value":"before"}\n')
    const after = Buffer.from('{"value":"after!"}\n')
    expect(after.byteLength).toBe(before.byteLength)
    await writeFile(path, before)
    try {
      await expect(readBoundedRegularFile(path, 1024, 'TaskPlan state file', async () => {
        await writeFile(path, after)
        return before
      })).rejects.toThrow(/读取期间变化/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid UTF-8 instead of materializing replacement characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-bounded-text-'))
    const path = join(dir, 'tasks.md')
    await writeFile(path, Buffer.from([0xc3, 0x28]))
    try {
      await expect(readOptionalBoundedRegularTextFile(path, 1024, 'TaskPlan tasks projection'))
        .rejects.toThrow(/UTF-8/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not downgrade a post-open ENOENT to an optional absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-bounded-text-disappear-'))
    const path = join(dir, 'tasks.md')
    const content = Buffer.from('# Tasks\n')
    await writeFile(path, content)
    try {
      await expect(readOptionalBoundedRegularTextFile(
        path,
        1024,
        'TaskPlan tasks projection',
        async () => {
          throw Object.assign(new Error('path disappeared after open'), { code: 'ENOENT' })
        },
      )).rejects.toThrow(/读取期间变化/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts only an explicitly identity-bound directory alias', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-bounded-anchored-parent-'))
    const outside = await mkdtemp(join(tmpdir(), 'tenon-bounded-anchored-outside-'))
    const alias = `${dir}-alias`
    const path = join(dir, 'ledger.jsonl')
    const content = '{"event":"ok"}\n'
    await writeFile(path, content)
    await writeFile(join(outside, 'ledger.jsonl'), content)
    await symlink(dir, alias, 'dir')
    const identity = await lstat(dir)
    try {
      const aliasedPath = join(alias, 'ledger.jsonl')
      await expect(readOptionalBoundedRegularTextFile(aliasedPath, 1024, 'anchored ledger'))
        .rejects.toThrow(/symlink|\u8def\u5f84\u522b\u540d/u)
      await expect(readOptionalBoundedRegularTextFileFromAnchoredDirectory(
        aliasedPath,
        1024,
        'anchored ledger',
        { dev: identity.dev, ino: identity.ino },
      )).resolves.toBe(content)
      await expect(readOptionalBoundedRegularTextFileFromAnchoredDirectory(
        aliasedPath,
        1024,
        'anchored ledger',
        { dev: identity.dev, ino: identity.ino + 1 },
      )).rejects.toThrow(/symlink|\u8def\u5f84\u522b\u540d/u)
      await expect(readOptionalBoundedRegularTextFileFromAnchoredDirectory(
        aliasedPath,
        1024,
        'anchored ledger',
        { dev: identity.dev, ino: identity.ino },
        async (handle) => {
          await rm(alias, { force: true })
          await symlink(outside, alias, 'dir')
          return handle.readFile()
        },
      )).rejects.toThrow(/\u8bfb\u53d6\u671f\u95f4\u53d8\u5316/u)
    } finally {
      await rm(alias, { force: true })
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
