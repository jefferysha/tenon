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
  it('列出内建与自定义；内建只有属性表与折叠的只读 YAML，没有保存与删除', async () => {
    stubFetch([])
    await openDirections()
    expect(screen.getByTestId('lib-dir-mine')).toBeTruthy()
    // 未选中时的空态说的是测试方向，不是模板；只有标题一行。
    expect(screen.getByTestId('lib-dir-empty')).toHaveTextContent(/^选择测试方向$/u)
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    const yaml = screen.getByTestId('lib-dir-yaml')
    expect(yaml.tagName).toBe('PRE')
    expect(screen.getByTestId('lib-dir-yaml-details')).not.toHaveAttribute('open')
    expect(screen.queryByTestId('lib-dir-save')).toBeNull()
    expect(screen.queryByTestId('lib-dir-more')).toBeNull()
    expect(screen.getByTestId('lib-dir-field-command').textContent).toContain('npm test')
    // 名称只显示 label；标识进属性表与悬停提示；「内建」只用锁图标。
    expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^单测$/u)
    expect(screen.getByTestId('lib-dir-title')).toHaveAttribute('title', 'unit')
    expect(screen.getByTestId('lib-dir-field-id')).toHaveTextContent('unit')
    expect(screen.getByTestId('lib-dir-builtin')).toHaveAttribute('aria-label', '内建')
    expect(screen.getByTestId(`lib-dir-copy-unit`)).toHaveTextContent('复制为自定义')
  })

  it('列表行只显示名称，标识在悬停提示里', async () => {
    stubFetch([])
    await openDirections()
    expect(screen.getByTestId('lib-dir-unit').textContent).toBe('单测')
    expect(screen.getByTestId('lib-dir-unit')).toHaveAttribute('title', 'unit')
    expect(screen.getByTestId('lib-dir-builtin-unit')).toBeInTheDocument()
    expect(screen.queryByTestId('lib-dir-builtin-mine')).toBeNull()
  })

  it('自定义方向未修改时保存禁用', async () => {
    stubFetch([])
    await openDirections()
    await userEvent.click(screen.getByTestId('lib-dir-mine'))
    expect(screen.getByTestId('lib-dir-save')).toBeDisabled()
    await userEvent.type(screen.getByTestId('lib-dir-yaml'), '#')
    expect(screen.getByTestId('lib-dir-save')).toBeEnabled()
  })

  it('复制内建写成 <id>-copy；自定义可保存与删除', async () => {
    const calls: Array<[string, string]> = []
    stubFetch(calls)
    await openDirections()
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    await userEvent.click(screen.getByTestId('lib-dir-copy-unit'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url.endsWith('/unit-copy'))).toBe(true))

    await userEvent.click(screen.getByTestId('lib-dir-mine'))
    await userEvent.type(screen.getByTestId('lib-dir-yaml'), '#')
    await userEvent.click(screen.getByTestId('lib-dir-save'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url.endsWith('/mine'))).toBe(true))
    await userEvent.click(screen.getByTestId('lib-dir-more'))
    await userEvent.click(screen.getByTestId('lib-dir-more-delete'))
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
    await userEvent.type(screen.getByTestId('lib-dir-yaml'), '#')
    await userEvent.click(screen.getByTestId('lib-dir-save'))
    await waitFor(() => expect(screen.getByTestId('lib-dir-error').textContent).toContain("方向 'mine' 缺 label"))
  })
})
