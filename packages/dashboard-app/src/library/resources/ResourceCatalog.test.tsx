import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { ResourceCatalog } from './ResourceCatalog'

interface Seed {
  id: string
  name: string
  category: string
  frameworks?: string[]
  styling?: string[]
  source?: 'builtin' | 'custom'
  redistributable?: boolean
  notice?: string
}

const entry = (seed: Seed) => ({
  schema: 'tenon-resource/v1',
  id: seed.id,
  name: seed.name,
  category: seed.category,
  frameworks: seed.frameworks ?? [],
  styling: seed.styling ?? [],
  baseline: false,
  license: {
    spdx: 'MIT',
    url: 'https://example.com/LICENSE',
    redistributable: seed.redistributable ?? true,
    attribution: false,
    commercial: 'free',
    ...(seed.notice === undefined ? {} : { notice: seed.notice }),
  },
  install: ['pnpm add x'],
  skills: [],
  links: { home: 'https://example.com' },
  verified_at: '2026-09-16',
  source: seed.source ?? 'builtin',
  revision: `sha256:${seed.id}`,
})

const ENTRIES = [
  entry({ id: 'lucide', name: 'Lucide', category: 'icons', frameworks: ['react', 'web'] }),
  entry({ id: 'iconify', name: 'Iconify', category: 'icons' }),
  entry({ id: 'sf-symbols', name: 'SF Symbols', category: 'icons', frameworks: ['swiftui'] }),
  entry({ id: 'shadcn-ui', name: 'shadcn/ui', category: 'component-lib', frameworks: ['react'], styling: ['tailwind'] }),
  entry({
    id: 'react-bits', name: 'React Bits', category: 'motion-components', frameworks: ['react'], styling: ['tailwind'],
    redistributable: false, notice: '不得出售或再分发组件本身',
  }),
  entry({ id: 'mine', name: '我的资源', category: 'icons', frameworks: ['react'], source: 'custom' }),
]

interface Call { url: string; init?: RequestInit }

function stubFetch(over: { entries?: unknown[]; errors?: unknown[]; onWrite?: (call: Call) => unknown } = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    const entries = over.entries ?? ENTRIES
    if (url === '/api/resources' && method === 'GET') {
      return { ok: true, json: async () => ({ schema_version: 'resource-catalog/v1', entries, errors: over.errors ?? [] }) }
    }
    const single = method === 'GET' ? /^\/api\/resources\/([^?]+)$/u.exec(url) : null
    if (single) {
      const id = decodeURIComponent(single[1] ?? '')
      const found = (entries as { id: string }[]).find((item) => item.id === id)
      if (!found) return { ok: false, status: 404, json: async () => ({ ok: false, code: 'not-found', error: '未知资源' }) }
      return { ok: true, json: async () => ({ ok: true, entry: found, yaml: `schema: tenon-resource/v1\nid: ${id}\n` }) }
    }
    const written = over.onWrite?.({ url, init })
    if (written !== undefined) return written
    return { ok: true, json: async () => ({ ok: true, entry: ENTRIES[0], id: 'lucide-copy' }) }
  }))
  return calls
}

const renderCatalog = (): void => {
  render(
    <I18nProvider>
      <ResourceCatalog rail={<div data-testid="rail" />} railCollapsed={false} today="2026-09-16" />
    </I18nProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('资源目录', () => {
  it('React + Tailwind + 图标三个芯片只留命中的条目，且不再发请求', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    renderCatalog()
    expect(await screen.findByTestId('res-row-lucide')).toBeInTheDocument()
    const before = calls.length
    await user.click(screen.getByTestId('res-category-icons'))
    await user.click(screen.getByTestId('res-framework-react'))
    await user.click(screen.getByTestId('res-styling-tailwind'))
    expect(screen.getByTestId('res-row-lucide')).toBeInTheDocument()
    expect(screen.getByTestId('res-row-iconify')).toBeInTheDocument()
    expect(screen.getByTestId('res-row-mine')).toBeInTheDocument()
    expect(screen.queryByTestId('res-row-sf-symbols')).toBeNull()
    expect(screen.queryByTestId('res-row-shadcn-ui')).toBeNull()
    expect(calls.length).toBe(before)
  })

  it('芯片行不换行、可横向滚动', async () => {
    stubFetch()
    renderCatalog()
    const row = await screen.findByTestId('res-facet-category')
    expect(row.className).toContain('whitespace-nowrap')
    expect(row.className).toContain('overflow-x-auto')
    expect(row).toHaveAttribute('role', 'tablist')
  })

  it('仅链接条目的详情显示许可 pill 与声明；内建条目只有复制', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderCatalog()
    await user.click(await screen.findByTestId('res-row-react-bits'))
    expect(await screen.findByTestId('res-license-pill')).toHaveTextContent('仅链接')
    expect(within(screen.getByTestId('res-notice')).getByText('不得出售或再分发组件本身')).toBeInTheDocument()
    expect(screen.getByTestId('res-copy')).toBeEnabled()
    expect(screen.queryByTestId('res-edit')).toBeNull()
    expect(screen.queryByTestId('res-delete')).toBeNull()
  })

  it('自定义条目可编辑：保存带 revision，成功后关抽屉', async () => {
    const user = userEvent.setup()
    const writes: Call[] = []
    const calls = stubFetch({
      onWrite: (call) => {
        writes.push(call)
        return { ok: true, json: async () => ({ ok: true, entry: ENTRIES[5] }) }
      },
    })
    renderCatalog()
    await user.click(await screen.findByTestId('res-row-mine'))
    await user.click(await screen.findByTestId('res-edit'))
    await user.click(await screen.findByTestId('res-save'))
    await waitFor(() => expect(screen.queryByTestId('res-yaml')).toBeNull())
    const put = writes.find((call) => call.init?.method === 'PUT')
    expect(put?.url).toBe('/api/resources/mine')
    expect(JSON.parse(String(put?.init?.body)).revision).toBe('sha256:mine')
    expect(calls.some((call) => call.url === '/api/resources' && (call.init?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('删除走确认对话框，确认后条目消失', async () => {
    const user = userEvent.setup()
    let deleted = false
    stubFetch({
      get entries() { return deleted ? ENTRIES.filter((item) => item.id !== 'mine') : ENTRIES },
      onWrite: (call) => {
        if (call.init?.method !== 'DELETE') return undefined
        deleted = true
        return { ok: true, json: async () => ({ ok: true }) }
      },
    })
    renderCatalog()
    await user.click(await screen.findByTestId('res-row-mine'))
    await user.click(await screen.findByTestId('res-delete'))
    await user.click(await screen.findByTestId('res-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('res-row-mine')).toBeNull())
  })

  it('保存冲突时给出重新载入', async () => {
    const user = userEvent.setup()
    stubFetch({
      onWrite: (call) => (call.init?.method === 'PUT'
        ? { ok: false, status: 409, json: async () => ({ ok: false, code: 'conflict', error: '资源已在磁盘上被修改，重新载入' }) }
        : undefined),
    })
    renderCatalog()
    await user.click(await screen.findByTestId('res-row-mine'))
    await user.click(await screen.findByTestId('res-edit'))
    await user.click(await screen.findByTestId('res-save'))
    expect(await screen.findByTestId('res-drawer-reload')).toBeInTheDocument()
  })

  it('解析失败的文件单独列出并标无效', async () => {
    stubFetch({ errors: [{ file: 'broken.yaml', source: 'custom', errors: ['第 1 行：缺字段 license'] }] })
    renderCatalog()
    const row = await screen.findByTestId('res-row-invalid-broken.yaml')
    expect(within(row).getByText('无效')).toBeInTheDocument()
  })
})
