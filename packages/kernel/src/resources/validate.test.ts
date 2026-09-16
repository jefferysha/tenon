import { describe, expect, test } from 'vitest'
import { validateResourceEntry } from './validate.js'
import { RESOURCE_SCHEMA, type ResourceEntry } from './types.js'

const BASE: ResourceEntry = {
  schema: RESOURCE_SCHEMA,
  id: 'lucide',
  name: 'Lucide',
  category: 'icons',
  frameworks: ['web', 'react'],
  styling: [],
  baseline: false,
  license: { spdx: 'ISC', url: 'https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE', redistributable: true, attribution: false, commercial: 'free' },
  install: ['pnpm add lucide-react'],
  skills: [],
  links: { home: 'https://lucide.dev' },
  verified_at: '2026-09-15',
}

const entry = (patch: Partial<ResourceEntry>): ResourceEntry => ({ ...BASE, ...patch })

describe('validateResourceEntry', () => {
  test('a verified entry has no problems', () => {
    expect(validateResourceEntry(BASE, 'lucide.yaml')).toEqual([])
  })

  test('id must match the pattern and the file stem', () => {
    expect(validateResourceEntry(entry({ id: 'Lucide' }), 'Lucide.yaml')).toContain('id 必须匹配 ^[a-z0-9][a-z0-9-]{1,62}$')
    expect(validateResourceEntry(BASE, 'icons.yaml')).toContain('id 必须与文件名一致')
  })

  test('license url and links must be https', () => {
    expect(validateResourceEntry(entry({ license: { ...BASE.license, url: 'http://example.com/LICENSE' } }), 'lucide.yaml'))
      .toContain('license.url 必须是 https 链接')
    expect(validateResourceEntry(entry({ links: { home: 'ftp://lucide.dev' } }), 'lucide.yaml'))
      .toContain('links.home 必须是 https 链接')
  })

  test('at least one of home, docs, source is required', () => {
    expect(validateResourceEntry(entry({ links: { registry: 'https://lucide.dev/r' } }), 'lucide.yaml'))
      .toContain('links 至少需要 home、docs 或 source')
  })

  test('notice is required for attribution and for link-only entries', () => {
    expect(validateResourceEntry(entry({ license: { ...BASE.license, attribution: true } }), 'lucide.yaml'))
      .toContain('license.notice 必填')
    expect(validateResourceEntry(entry({ license: { ...BASE.license, redistributable: false } }), 'lucide.yaml'))
      .toContain('license.notice 必填')
    expect(validateResourceEntry(entry({ license: { ...BASE.license, redistributable: false, notice: '仅链接' } }), 'lucide.yaml'))
      .toEqual([])
  })

  test('state and styling entries need use', () => {
    expect(validateResourceEntry(entry({ id: 'zustand', category: 'state' }), 'zustand.yaml')).toContain('use 必填')
    expect(validateResourceEntry(entry({ id: 'sass', category: 'styling' }), 'sass.yaml')).toContain('use 必填')
    expect(validateResourceEntry(entry({ id: 'zustand', category: 'state', use: '小型全局状态' }), 'zustand.yaml')).toEqual([])
  })

  test('design-md entries need links.design_md', () => {
    expect(validateResourceEntry(entry({ id: 'design-md-claude', category: 'design-md' }), 'design-md-claude.yaml'))
      .toContain('links.design_md 必填')
  })

  test('verified_at must be a real date', () => {
    expect(validateResourceEntry(entry({ verified_at: '2026-9-15' }), 'lucide.yaml')).toContain('verified_at 必须是日期')
    expect(validateResourceEntry(entry({ verified_at: '2026-02-30' }), 'lucide.yaml')).toContain('verified_at 必须是日期')
  })
})
