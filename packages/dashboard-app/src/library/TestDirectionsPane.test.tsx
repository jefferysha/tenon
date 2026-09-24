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

function stubFetch(calls: Array<[string, string]>, list: readonly unknown[] = [BUILTIN, CUSTOM]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push([method, url])
    if (url === '/api/test-directions') {
      return new Response(JSON.stringify({ ok: true, directions: list }), { status: 200 })
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
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    const yaml = screen.getByTestId('lib-dir-yaml')
    expect(yaml.tagName).toBe('PRE')
    expect(screen.getByTestId('lib-dir-yaml-details')).not.toHaveAttribute('open')
    expect(screen.queryByTestId('lib-dir-save')).toBeNull()
    expect(screen.queryByTestId('lib-dir-more')).toBeNull()
    expect(screen.getByTestId('lib-dir-field-command').textContent).toContain('npm test')
    // 名称只显示 label；标识进属性表与悬停提示；内建不带标记，只有自定义才标。
    expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^单测$/u)
    expect(screen.getByTestId('lib-dir-title')).toHaveAttribute('title', 'unit')
    expect(screen.getByTestId('lib-dir-field-id')).toHaveTextContent('unit')
    expect(screen.queryByTestId('lib-dir-custom')).toBeNull()
    expect(screen.getByTestId(`lib-dir-copy-unit`)).toHaveTextContent('复制为自定义')
  })

  it('右列不留空：没选中时打开第一行；显式选中的保持选中', async () => {
    stubFetch([])
    await openDirections()
    await waitFor(() => expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^单测$/u))
    expect(screen.getByTestId('lib-dir-unit')).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByTestId('lib-dir-empty')).toBeNull()
    await userEvent.click(screen.getByTestId('lib-dir-mine'))
    await userEvent.type(screen.getByTestId('library-list-search'), '我')
    expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^我的$/u)
    expect(screen.getByTestId('lib-dir-mine')).toHaveAttribute('aria-current', 'true')
  })

  it('选中项被搜索筛掉时换成当前列表第一行', async () => {
    stubFetch([])
    await openDirections()
    await waitFor(() => expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^单测$/u))
    await userEvent.type(screen.getByTestId('library-list-search'), 'mine')
    await waitFor(() => expect(screen.getByTestId('lib-dir-title')).toHaveTextContent(/^我的$/u))
    expect(screen.getByTestId('lib-dir-mine')).toHaveAttribute('aria-current', 'true')
  })

  it('列表为空时详情保留空态：不写字，可访问名称说的是测试方向', async () => {
    stubFetch([], [])
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    render(<I18nProvider><LibraryView /></I18nProvider>)
    await userEvent.click(screen.getByTestId('lib-section-directions'))
    const empty = await screen.findByTestId('lib-dir-empty')
    await waitFor(() => expect(screen.queryByTestId('lib-dir-loading')).toBeNull())
    expect(empty).toHaveTextContent(/^$/u)
    expect(empty).toHaveAttribute('aria-label', '选择测试方向')
  })

  it('列表行只显示名称，标识在悬停提示里；只有自定义行带标记', async () => {
    stubFetch([])
    await openDirections()
    expect(screen.getByTestId('lib-dir-unit').textContent).toBe('单测')
    expect(screen.getByTestId('lib-dir-unit')).toHaveAttribute('title', 'unit')
    expect(screen.queryByTestId('lib-dir-mark-unit')).toBeNull()
    expect(screen.getByTestId('lib-dir-mark-mine')).toHaveTextContent('自定义')
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

  it('复制为自定义：标识 unit-copy、名称「单测 副本」，写入后选中副本', async () => {
    const bodies: Array<[string, string]> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (init?.method === 'PUT') bodies.push([url, String(init.body)])
      if (url === '/api/test-directions') {
        const copied = bodies.length > 0
          ? [{ ...CUSTOM, id: 'unit-copy', label: '单测 副本', yaml: 'id: "unit-copy"\ncommand: npm test\nlabel: "单测 副本"\n' }]
          : []
        return new Response(JSON.stringify({ ok: true, directions: [BUILTIN, CUSTOM, ...copied] }), { status: 200 })
      }
      if (url.startsWith('/api/test-directions/')) return new Response(JSON.stringify({ ok: true, direction: CUSTOM }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, templates: [], sync: { state: 'unchanged' } }), { status: 200 })
    })
    await openDirections()
    await userEvent.click(screen.getByTestId('lib-dir-unit'))
    await userEvent.click(screen.getByTestId('lib-dir-copy-unit'))
    await waitFor(() => expect(bodies).toEqual([['/api/test-directions/unit-copy', 'id: "unit-copy"\ncommand: npm test\nlabel: "单测 副本"\n']]))
    await waitFor(() => expect(screen.getByTestId('lib-dir-unit-copy')).toHaveAttribute('aria-current', 'true'))
    // 副本是自定义：详情直接是可编辑的 YAML。
    expect(screen.getByTestId('lib-dir-yaml').tagName).toBe('TEXTAREA')
  })

  it('与其它子库一致：有搜索与「新建方向」，新建写 new-direction', async () => {
    const calls: Array<[string, string]> = []
    stubFetch(calls)
    await openDirections()
    await userEvent.type(screen.getByTestId('library-list-search'), '我的')
    expect(screen.queryByTestId('lib-dir-unit')).toBeNull()
    expect(screen.getByTestId('lib-dir-mine')).toBeInTheDocument()
    expect(screen.getByTestId('lib-section-directions')).toHaveTextContent('2')
    await userEvent.click(screen.getByTestId('lib-dir-new'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url === '/api/test-directions/new-direction')).toBe(true))
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
