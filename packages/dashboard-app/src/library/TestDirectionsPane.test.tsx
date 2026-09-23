import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { LibraryView } from './LibraryView'

const BUILTIN = {
  id: 'unit', label: '单测', source: 'builtin', yaml: 'id: unit\ncommand: npm test\nlabel: 单测\n',
  definition: { id: 'unit', label: '单测', command: 'npm test', timeout_s: 900 },
}
const CUSTOM = {
  id: 'mine', label: '我的', source: 'custom', yaml: 'id: mine\ncommand: npm run mine\nlabel: 我的\n',
  definition: { id: 'mine', label: '我的', command: 'npm run mine', timeout_s: 600 },
}

function stubFetch(calls: Array<[string, string]>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push([method, url])
    if (url === '/api/test-directions') {
      return new Response(JSON.stringify({ ok: true, directions: [BUILTIN, CUSTOM] }), { status: 200 })
    }
    if (url.startsWith('/api/test-directions/')) {
      return new Response(JSON.stringify({ ok: true, direction: CUSTOM }), { status: 200 })
    }
    if (url.startsWith('/api/instruction-templates')) {
      return new Response(JSON.stringify({ ok: true, templates: [], sync: { state: 'unchanged' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, templates: [] }), { status: 200 })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

async function openDirections(): Promise<void> {
  window.__TENON_DASHBOARD_TOKEN__ = 'tok'
  render(<I18nProvider><LibraryView /></I18nProvider>)
  await userEvent.click(screen.getByTestId('lib-section-directions'))
  await waitFor(() => expect(screen.getByTestId('lib-dir-unit')).toBeTruthy())
}

describe('TestDirectionsPane', () => {
  it('列出内建与自定义；内建 YAML 只读且没有保存与删除', async () => {
    stubFetch([])
    await openDirections()
    expect(screen.getByTestId('lib-dir-mine')).toBeTruthy()
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    const editor = screen.getByTestId('lib-dir-yaml')
    expect(editor).toHaveAttribute('readonly')
    expect(screen.queryByTestId('lib-dir-save')).toBeNull()
    expect(screen.queryByTestId('lib-dir-delete-unit')).toBeNull()
    expect(screen.getByTestId('lib-dir-detail').textContent).toContain('npm test')
  })

  it('复制内建写成 <id>-copy；自定义可保存与删除', async () => {
    const calls: Array<[string, string]> = []
    stubFetch(calls)
    await openDirections()
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    await userEvent.click(screen.getByTestId('lib-dir-copy-unit'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url.endsWith('/unit-copy'))).toBe(true))

    await userEvent.click(screen.getByTestId('lib-dir-mine'))
    await userEvent.click(screen.getByTestId('lib-dir-save'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url.endsWith('/mine'))).toBe(true))
    await userEvent.click(screen.getByTestId('lib-dir-delete-mine'))
    expect(await screen.findByTestId('lib-delete-dialog')).toBeInTheDocument()
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false)
    await userEvent.click(screen.getByTestId('lib-delete-confirm'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'DELETE' && url.endsWith('/mine'))).toBe(true))
  })

  it('保存失败时显示 server 的原文', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/test-directions' && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ ok: true, directions: [BUILTIN, CUSTOM] }), { status: 200 })
      }
      if (url.startsWith('/api/test-directions/')) {
        return new Response(JSON.stringify({ ok: false, error: "test direction 解析错误：方向 'mine' 缺 label" }), { status: 400 })
      }
      return new Response(JSON.stringify({ ok: true, templates: [] }), { status: 200 })
    })
    await openDirections()
    await userEvent.click(screen.getByTestId('lib-dir-mine'))
    await userEvent.click(screen.getByTestId('lib-dir-save'))
    await waitFor(() => expect(screen.getByTestId('lib-dir-error').textContent).toContain("方向 'mine' 缺 label"))
  })
})
