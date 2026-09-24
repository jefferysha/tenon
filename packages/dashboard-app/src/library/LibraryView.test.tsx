import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { LibraryView } from './LibraryView'
import { LIST_ROW } from './libraryChrome'
import { LIST_SELECTED } from '../shared/uiRecipes'

const GO_TEXT = '---\nid: go\ncategory: backend\ntitle: Go\n---\n## 后端（Go）\n'
const MINE_TEXT = '---\nid: mine\ncategory: backend\ntitle: 我的后端\n---\n## 后端（我的后端）\n'

const summary = (source: string, id: string, title: string, errors: string[] = []) =>
  ({ source, category: 'backend', id, title, frameworks: [], digest: `sha256:${id}`, errors })

interface Calls { url: string; init?: RequestInit }

const customDoc = (id: string, digest: string, title = id) => ({
  ok: true, source: 'custom', category: 'backend', id, text: MINE_TEXT, digest,
  block: { title, frameworks: [], directory: null, directory_label: null, catalog: [], catalog_ref: null, variables: [] },
  errors: [],
})

function stubFetch(over: { templates?: unknown[]; onWrite?: (call: Calls) => unknown } = {}) {
  const calls: Calls[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    // 每次 GET 重新取一遍：用例用 getter 表达「写入之后列表变了」。
    const templates = over.templates ?? [summary('builtin', 'go', 'Go'), summary('custom', 'mine', '我的后端')]
    if (url === '/api/instruction-templates' && method === 'GET') {
      return { ok: true, json: async () => ({ ok: true, sync: { id: 'instruction-templates', state: 'unchanged' }, templates }) }
    }
    if (url.startsWith('/api/instruction-templates/builtin/backend/go') && method === 'GET') {
      return { ok: true, json: async () => ({ ok: true, source: 'builtin', category: 'backend', id: 'go', text: GO_TEXT, digest: 'sha256:go', block: { title: 'Go', frameworks: [], directory: 'backend/', directory_label: '后端', catalog: [], catalog_ref: null, variables: [{ key: 'app', default: 'app' }] }, errors: [] }) }
    }
    const custom = method === 'GET' ? /\/api\/instruction-templates\/custom\/backend\/([^?]+)/.exec(url) : null
    if (custom) {
      const id = decodeURIComponent(custom[1] ?? '')
      return { ok: true, json: async () => (id === 'mine' ? customDoc('mine', 'sha256:mine', '我的后端') : customDoc(id, `sha256:${id}`)) }
    }
    const written = over.onWrite?.({ url, init })
    if (written !== undefined) return written
    return { ok: true, json: async () => ({ ok: true, digest: 'sha256:new' }) }
  }))
  return calls
}

function renderLibrary(onToast?: (message: string) => void) {
  render(<I18nProvider><LibraryView onToast={onToast} /></I18nProvider>)
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('库页 · 模板', () => {
  it('左列是模板与资源目录两种；列表按分类与来源过滤；内建行带来源标记', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderLibrary()
    expect(await screen.findByTestId('lib-section-templates')).toBeInTheDocument()
    expect(screen.getByTestId('lib-section-resources')).toBeInTheDocument()
    expect(screen.getByTestId('lib-tpl-builtin-backend-go')).toBeInTheDocument()
    expect(screen.getByTestId('lib-tpl-custom-backend-mine')).toBeInTheDocument()

    await user.click(screen.getByTestId('lib-source-custom'))
    expect(screen.queryByTestId('lib-tpl-builtin-backend-go')).toBeNull()
    expect(screen.getByTestId('lib-tpl-custom-backend-mine')).toBeInTheDocument()

    // 分类是单行筛选栏里的一个下拉触发器（13 个分类不再铺成一排芯片）。
    await user.click(screen.getByTestId('lib-facet-category'))
    await user.click(await screen.findByTestId('lib-filter-frontend'))
    expect(screen.getByTestId('lib-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-facets').className.split(' ')).toContain('flex-nowrap')
  })

  it('内建模板详情只有复制；变量表列出键与默认值', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderLibrary()
    await user.click(await screen.findByTestId('lib-tpl-builtin-backend-go'))
    expect(await screen.findByTestId('lib-tpl-copy')).toBeEnabled()
    // 「内建」只用标题旁的锁图标表示；没有眉题、路径行与药丸，标识在名称的悬停提示里。
    expect(screen.getByTestId('lib-tpl-builtin')).toHaveAttribute('aria-label', '内建')
    expect(screen.getByTestId('lib-tpl-title')).toHaveTextContent('Go')
    expect(screen.getByTestId('lib-tpl-title')).toHaveAttribute('title', 'backend/go')
    expect(screen.queryByTestId('lib-tpl-eyebrow')).toBeNull()
    expect(screen.queryByTestId('lib-tpl-path')).toBeNull()
    expect(screen.queryByTestId('lib-tpl-source')).toBeNull()
    expect(screen.getByTestId('lib-tpl-copy')).toHaveTextContent('复制为自定义')
    expect(screen.queryByTestId('lib-tpl-save')).toBeNull()
    expect(screen.queryByTestId('lib-tpl-more')).toBeNull()
    expect(within(screen.getByTestId('lib-tpl-var-app')).getAllByText('app').length).toBeGreaterThan(0)
    // 只有一个视图：不渲染页签；也没有底部动作条。
    expect(screen.queryByTestId('lib-tpl-sheets')).toBeNull()
    expect(screen.getByTestId('lib-tpl-detail').querySelector('footer')).toBeNull()
  })

  it('自定义模板可编辑：保存带 If-Match 摘要', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    const onToast = vi.fn()
    renderLibrary(onToast)
    await user.click(await screen.findByTestId('lib-tpl-custom-backend-mine'))
    await user.click(await screen.findByTestId('lib-tpl-tab-edit'))
    const editor = await screen.findByTestId('lib-tpl-editor')
    await user.type(editor, '- 规则\n')
    await user.click(screen.getByTestId('lib-tpl-save'))
    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === 'PUT')
      expect(put?.url).toBe('/api/instruction-templates/custom/backend/mine')
      expect((put?.init?.headers as Record<string, string>)['If-Match']).toBe('sha256:mine')
      expect((put?.init?.headers as Record<string, string>)['Content-Type']).toContain('text/markdown')
    })
    // 提示气泡说结果（已保存），不是按钮上的动作名（保存）。
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已保存'))
  })

  it('复制内建模板 → POST copy，列表刷新后含新行', async () => {
    const user = userEvent.setup()
    let copied = false
    const calls = stubFetch({
      get templates() {
        return copied
          ? [summary('builtin', 'go', 'Go'), summary('custom', 'mine', '我的后端'), summary('custom', 'go-copy', 'Go')]
          : [summary('builtin', 'go', 'Go'), summary('custom', 'mine', '我的后端')]
      },
      onWrite: ({ url }) => {
        if (!url.endsWith('/copy')) return undefined
        copied = true
        return { ok: true, json: async () => ({ ok: true, digest: 'sha256:copy' }) }
      },
    })
    renderLibrary()
    await user.click(await screen.findByTestId('lib-tpl-builtin-backend-go'))
    await user.click(await screen.findByTestId('lib-tpl-copy'))
    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/copy'))
      expect(JSON.parse(String(post?.init?.body))).toEqual({ from: { source: 'builtin', category: 'backend', id: 'go' }, id: 'go-copy' })
    })
    expect(await screen.findByTestId('lib-tpl-custom-backend-go-copy')).toBeInTheDocument()
  })

  it('删除自定义模板 → DELETE 带摘要，行消失', async () => {
    const user = userEvent.setup()
    let removed = false
    const calls = stubFetch({
      get templates() {
        return removed ? [summary('builtin', 'go', 'Go')] : [summary('builtin', 'go', 'Go'), summary('custom', 'mine', '我的后端')]
      },
      onWrite: ({ init }) => {
        if (init?.method !== 'DELETE') return undefined
        removed = true
        return { ok: true, json: async () => ({ ok: true }) }
      },
    })
    renderLibrary()
    await user.click(await screen.findByTestId('lib-tpl-custom-backend-mine'))
    await user.click(await screen.findByTestId('lib-tpl-more'))
    await user.click(screen.getByTestId('lib-tpl-more-delete'))
    // 删除先确认：取消不发请求，确认后才 DELETE。
    const dialog = await screen.findByTestId('lib-delete-dialog')
    expect(within(dialog).getByText('删除「我的后端」')).toBeInTheDocument()
    await user.click(screen.getByTestId('lib-delete-cancel'))
    expect(screen.queryByTestId('lib-delete-dialog')).toBeNull()
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
    await user.click(screen.getByTestId('lib-tpl-more'))
    await user.click(screen.getByTestId('lib-tpl-more-delete'))
    await user.click(await screen.findByTestId('lib-delete-confirm'))
    await waitFor(() => {
      const del = calls.find((call) => call.init?.method === 'DELETE')
      expect(del?.url).toBe('/api/instruction-templates/custom/backend/mine?digest=sha256%3Amine')
    })
    await waitFor(() => expect(screen.queryByTestId('lib-tpl-custom-backend-mine')).toBeNull())
  })

  it('新建模板：分类 + 标识，保存为 custom', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    const onToast = vi.fn()
    renderLibrary(onToast)
    await user.click(await screen.findByTestId('lib-tpl-new'))
    // 分类是下拉框：去掉原生外观后要有自己的箭头，不能看起来像文本框。
    expect(screen.getByTestId('lib-tpl-new-category-arrow')).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'backend')
    await user.type(screen.getByTestId('lib-tpl-new-id'), 'team-go')
    await user.click(screen.getByTestId('lib-tpl-new-confirm'))
    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === 'PUT')
      expect(put?.url).toBe('/api/instruction-templates/custom/backend/team-go')
      expect((put?.init?.headers as Record<string, string>)['If-Match']).toBe('absent')
      expect(String(put?.init?.body)).toContain('id: team-go')
    })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已新建模板 team-go'))
  })

  it('server 返回错误码时按码显示本地文案，并给出重新载入', async () => {
    const user = userEvent.setup()
    stubFetch({
      onWrite: ({ init }) => (init?.method === 'PUT'
        ? { ok: false, status: 409, json: async () => ({ ok: false, code: 'template-changed', error: 'server prose', digest: 'sha256:other' }) }
        : undefined),
    })
    renderLibrary()
    await user.click(await screen.findByTestId('lib-tpl-custom-backend-mine'))
    await user.click(await screen.findByTestId('lib-tpl-tab-edit'))
    await user.type(await screen.findByTestId('lib-tpl-editor'), 'x')
    await user.click(screen.getByTestId('lib-tpl-save'))
    const error = await screen.findByTestId('lib-tpl-error')
    expect(error).toHaveTextContent('模板已被修改')
    expect(error).not.toHaveTextContent('server prose')
    expect(screen.getByTestId('lib-tpl-reload')).toBeInTheDocument()
  })

  it('解析错误的模板：列表显示错误数，详情列出错误', async () => {
    const user = userEvent.setup()
    stubFetch({ templates: [summary('custom', 'mine', 'mine', ['2: 缺少 title'])] })
    renderLibrary()
    expect(await screen.findByTestId('lib-tpl-errors-mine')).toHaveTextContent('1')
    await user.click(screen.getByTestId('lib-tpl-custom-backend-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-tpl-preview')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('lib-tpl-preview')).toHaveTextContent('后端（我的后端）'))
    expect(screen.getByTestId('lib-tpl-preview')).not.toHaveTextContent('category: backend')
  })

  it('无 token 时写操作全部禁用', async () => {
    ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = ''
    const user = userEvent.setup()
    stubFetch()
    renderLibrary()
    expect(await screen.findByTestId('lib-tpl-new')).toBeDisabled()
    await user.click(screen.getByTestId('lib-tpl-custom-backend-mine'))
    expect(await screen.findByTestId('lib-tpl-copy')).toBeDisabled()
    expect(screen.getByTestId('lib-tpl-more')).toBeDisabled()
    expect(screen.getByTestId('lib-tpl-no-token')).toBeInTheDocument()
  })

  it('列表行只显示名称（标识在悬停提示里），内建行只带锁图标', async () => {
    stubFetch()
    renderLibrary()
    const row = await screen.findByTestId('lib-tpl-builtin-backend-go')
    expect(row.textContent).toBe('Go')
    expect(row).toHaveAttribute('title', 'backend/go')
    expect(screen.getByTestId('lib-tpl-builtin-go')).toHaveAttribute('aria-label', '内建')
    expect(screen.queryByTestId('lib-tpl-builtin-mine')).toBeNull()
  })

  it('「新建模板」在标题行，不夹在筛选芯片里', async () => {
    stubFetch()
    renderLibrary()
    const button = await screen.findByTestId('lib-tpl-new')
    expect(screen.getByTestId('library-list-action')).toContainElement(button)
    expect(screen.getByTestId('library-list-chips').contains(button)).toBe(false)
  })

  it('读取中显示骨架与「–」计数，不显示假空态、筛选芯片与新建按钮', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      await gate
      if (url === '/api/instruction-templates') {
        return { ok: true, json: async () => ({ ok: true, sync: { id: 'instruction-templates', state: 'unchanged' }, templates: [] }) }
      }
      return { ok: true, json: async () => ({ ok: true, templates: [], directions: [], agents: [] }) }
    }))
    renderLibrary()
    expect(screen.getByTestId('lib-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('lib-empty')).toBeNull()
    expect(screen.queryByTestId('lib-tpl-new')).toBeNull()
    expect(screen.queryByTestId('library-list-chips')).toBeNull()
    expect(screen.getByTestId('lib-section-templates')).toHaveTextContent('–')
    release()
    // 确认为空：显示空态与新建；没有可筛的数据就不铺分类芯片。
    expect(await screen.findByTestId('lib-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-tpl-new')).toBeInTheDocument()
    expect(screen.queryByTestId('library-list-chips')).toBeNull()
    expect(screen.getByTestId('lib-section-templates')).toHaveTextContent('0')
  })
})

describe('库页 · 列表与空态外观', () => {
  it('选中行 = 中性选中底 + 左侧内嵌边，不加描边；与任务卡同一串选中类', async () => {
    stubFetch()
    renderLibrary()
    const row = await screen.findByTestId('lib-tpl-builtin-backend-go')
    await userEvent.click(row)
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'))
    for (const cls of LIST_SELECTED.split(' ')) expect(LIST_ROW).toContain(`aria-[current=true]:${cls}`)
    expect(row.className).toBe(LIST_ROW)
    expect(row.className).not.toMatch(/(?:^|\s)(?:aria-\[current=true\]:)?border(?:-|\s|$)/u)
    expect(row.className).not.toContain('accent-t')
  })

  it('行名 500、选中 600；列表里的锁平时 text-4，悬停 / 选中才 text-3', async () => {
    stubFetch()
    renderLibrary()
    const row = await screen.findByTestId('lib-tpl-builtin-backend-go')
    const name = row.querySelector('span')
    expect(name?.className).toContain('text-body')
    expect(name?.className).toContain('font-medium')
    expect(name?.className).toContain('group-aria-[current=true]:font-semibold')
    const lock = screen.getByTestId('lib-tpl-builtin-go')
    expect(lock.className).toContain('text-text-4')
    expect(lock.className).toContain('group-hover:text-text-3')
    expect(lock.className).toContain('group-aria-[current=true]:text-text-3')
  })

  it('详情空态不写字，只留空白（可访问名称仍在）', async () => {
    stubFetch()
    renderLibrary()
    const empty = await screen.findByTestId('lib-detail-empty')
    expect(empty.textContent).toBe('')
    expect(empty).toHaveAttribute('aria-label', '选择模板')
  })
})
