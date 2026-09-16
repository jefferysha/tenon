import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceApiError, deleteResource, fetchResource, fetchResources, saveResource } from './resourceClient'
import { decodeResourceEntry } from './resourceTypes'

const ENTRY = {
  schema: 'tenon-resource/v1',
  id: 'lucide',
  name: 'Lucide',
  category: 'icons',
  frameworks: ['react'],
  styling: [],
  baseline: false,
  license: { spdx: 'ISC', url: 'https://example.com/LICENSE', redistributable: true, attribution: false, commercial: 'free' },
  install: ['pnpm add lucide-react'],
  skills: [],
  links: { home: 'https://lucide.dev' },
  verified_at: '2026-09-16',
}

function stub(response: { ok: boolean; status?: number; body: unknown }): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 400), json: async () => response.body }
  }))
  return { calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('decodeResourceEntry', () => {
  it('接受完整条目', () => {
    expect(decodeResourceEntry(ENTRY)?.id).toBe('lucide')
  })

  it('缺 license.redistributable、未知分类、未知链接键一律拒绝', () => {
    const { redistributable, ...license } = ENTRY.license
    expect(decodeResourceEntry({ ...ENTRY, license })).toBeNull()
    expect(decodeResourceEntry({ ...ENTRY, category: 'widgets' })).toBeNull()
    expect(decodeResourceEntry({ ...ENTRY, links: { blog: 'https://example.com' } })).toBeNull()
    expect(decodeResourceEntry({ ...ENTRY, frameworks: ['solid'] })).toBeNull()
    expect(decodeResourceEntry({ ...ENTRY, install: [1] })).toBeNull()
  })
})

describe('资源目录客户端', () => {
  it('列表要求 schema_version，形状不对时抛错', async () => {
    stub({ ok: true, body: { schema_version: 'resource-catalog/v1', entries: [{ ...ENTRY, source: 'builtin', revision: 'sha256:a' }], errors: [] } })
    const list = await fetchResources()
    expect(list.entries[0]?.entry.id).toBe('lucide')
    stub({ ok: true, body: { entries: [], errors: [] } })
    await expect(fetchResources()).rejects.toBeInstanceOf(ResourceApiError)
  })

  it('单条读取带 yaml 原文', async () => {
    stub({ ok: true, body: { ok: true, entry: { ...ENTRY, source: 'custom', revision: 'sha256:b' }, yaml: 'schema: tenon-resource/v1\n' } })
    const document = await fetchResource('lucide')
    expect(document.source).toBe('custom')
    expect(document.yaml).toContain('schema:')
  })

  it('保存带 token 与 revision；server 的 code 与 errors 原样带上', async () => {
    const { calls } = stub({ ok: true, body: { ok: true, entry: { ...ENTRY, source: 'custom', revision: 'sha256:c' } } })
    await saveResource('mine', 'schema: tenon-resource/v1\n', 'sha256:b')
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ yaml: 'schema: tenon-resource/v1\n', revision: 'sha256:b' })
    stub({ ok: false, status: 400, body: { ok: false, code: 'invalid', error: '条目不合法', errors: ['use 必填'] } })
    await expect(saveResource('mine', 'x', undefined)).rejects.toMatchObject({ code: 'invalid', errors: ['use 必填'] })
  })

  it('删除把 revision 放在查询串里', async () => {
    const { calls } = stub({ ok: true, body: { ok: true } })
    await deleteResource('mine', 'sha256:c')
    expect(calls[0]?.url).toBe('/api/resources/mine?revision=sha256%3Ac')
    expect(calls[0]?.init?.method).toBe('DELETE')
  })
})
