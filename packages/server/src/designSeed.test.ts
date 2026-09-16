import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseResourceEntry } from '@tenon/kernel'
import { DESIGN_SEED_MAX_BYTES, fetchDesignSeed, writeDesignSeed } from './designSeed.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'tenon-design-seed-'))
  roots.push(path)
  return path
}

function entry(category: string, designMd?: string): ReturnType<typeof parseResourceEntry> {
  return parseResourceEntry([
    'schema: tenon-resource/v1',
    'id: design-md-claude',
    'name: Claude',
    `category: ${category}`,
    'frameworks: []',
    'styling: []',
    'baseline: false',
    'license:',
    '  spdx: MIT',
    '  url: https://example.com/LICENSE',
    '  redistributable: false',
    '  attribution: false',
    '  commercial: free',
    '  notice: 品牌视觉归各公司所有',
    'install: []',
    'skills: []',
    'links:',
    '  source: https://example.com/brand',
    ...(designMd === undefined ? [] : [`  design_md: ${designMd}`]),
    'verified_at: 2026-09-16',
    '',
  ].join('\n'))
}

const ok = (text: string) => async () => ({ ok: true, status: 200, text })

describe('fetchDesignSeed', () => {
  it('取回 design-md 条目的原文', async () => {
    const result = await fetchDesignSeed(entry('design-md', 'https://example.com/DESIGN.md'), ok('# Claude\n'))
    expect(result).toEqual({ ok: true, text: '# Claude\n' })
  })

  it('非 design-md 条目直接拒绝', async () => {
    const result = await fetchDesignSeed(entry('icons', 'https://example.com/DESIGN.md'), ok('# x\n'))
    expect(result).toMatchObject({ ok: false, code: 'not-design-md' })
  })

  it('缺 https 链接、非 2xx、空文件、超限都是 fetch-failed', async () => {
    expect(await fetchDesignSeed(entry('design-md'), ok('# x\n'))).toMatchObject({ ok: false, code: 'fetch-failed' })
    const notFound = await fetchDesignSeed(entry('design-md', 'https://example.com/DESIGN.md'), async () => ({ ok: false, status: 404, text: '' }))
    expect(notFound).toMatchObject({ ok: false, code: 'fetch-failed', error: 'DESIGN.md 获取失败：404' })
    expect(await fetchDesignSeed(entry('design-md', 'https://example.com/DESIGN.md'), ok(''))).toMatchObject({ ok: false, code: 'fetch-failed' })
    const huge = 'x'.repeat(DESIGN_SEED_MAX_BYTES + 1)
    expect(await fetchDesignSeed(entry('design-md', 'https://example.com/DESIGN.md'), ok(huge))).toMatchObject({ ok: false, code: 'fetch-failed' })
  })

  it('抓取抛错也是 fetch-failed', async () => {
    const result = await fetchDesignSeed(entry('design-md', 'https://example.com/DESIGN.md'), async () => { throw new Error('offline') })
    expect(result).toMatchObject({ ok: false, code: 'fetch-failed', error: 'DESIGN.md 获取失败：offline' })
  })
})

describe('writeDesignSeed', () => {
  it('写到项目根目录', () => {
    const path = root()
    expect(writeDesignSeed(path, '# Claude\n')).toEqual({ ok: true, path: 'DESIGN.md', bytes: 9 })
    expect(readFileSync(join(path, 'DESIGN.md'), 'utf8')).toBe('# Claude\n')
  })

  it('已存在时不覆盖', () => {
    const path = root()
    writeFileSync(join(path, 'DESIGN.md'), 'mine\n')
    expect(writeDesignSeed(path, '# Claude\n')).toMatchObject({ ok: false, code: 'exists' })
    expect(readFileSync(join(path, 'DESIGN.md'), 'utf8')).toBe('mine\n')
  })
})
