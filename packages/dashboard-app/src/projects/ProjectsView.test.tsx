import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { diffFileLabel } from './DiffDrawer'
import { ProjectsView } from './ProjectsView'

const PROJECTS = [{ root: '/repo', name: 'repo', count: 1, ok: true }]

const HOSTS = [
  { id: 'claude', levels: 'joined', target: 'CLAUDE.md' },
  { id: 'codex', levels: 'joined', target: 'AGENTS.md' },
  { id: 'gemini', levels: 'joined', target: 'GEMINI.md' },
  { id: 'copilot', levels: 'user-wins', target: 'AGENTS.md' },
  { id: 'cursor', levels: 'project-only', target: 'AGENTS.md' },
  { id: 'zed', levels: 'project-wins', target: 'AGENTS.md', effective_file: 'AGENTS.md' },
  { id: 'aider', levels: 'needs-config', target: null },
]

const target = (id: string, over: Record<string, unknown> = {}) => ({
  id, path: `/repo/${id}`, exists: true, digest: `sha256:${id}`, text: '# 旧\n', managed: [], bytes: 6, error: null, ...over,
})

interface Call { url: string; init?: RequestInit }

function stubFetch(over: { targets?: () => unknown[]; onWrite?: (call: Call) => unknown } = {}) {
  const calls: Call[] = []
  const targets = over.targets ?? (() => [target('AGENTS.md'), target('CLAUDE.md', { exists: false, digest: 'absent', text: '', bytes: 0 }), target('GEMINI.md', { exists: false, digest: 'absent', text: '', bytes: 0 })])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/instructions?') && method === 'GET') {
      return { ok: true, json: async () => ({ ok: true, level: 'project', root: '/repo', hosts: HOSTS, targets: targets() }) }
    }
    if (url === '/api/instructions/preview') {
      const body = JSON.parse(String(init?.body)) as { text: string; targets: string[] }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          files: body.targets.map((id) => ({ id, path: `/repo/${id}`, base_digest: id === 'AGENTS.md' ? 'sha256:AGENTS.md' : 'absent', current: id === 'AGENTS.md' ? '# 旧\n' : null, next: body.text })),
        }),
      }
    }
    const written = over.onWrite?.({ url, init })
    if (written !== undefined) return written
    if (url === '/api/instructions/apply') {
      const body = JSON.parse(String(init?.body)) as { targets: { id: string }[] }
      return { ok: true, json: async () => ({ ok: true, files: body.targets.map((item) => ({ id: item.id, digest: 'sha256:new' })) }) }
    }
    return { ok: true, json: async () => ({ ok: true, result: 'removed' }) }
  }))
  return calls
}

function renderView(currentRoot = '/repo', onToast?: (message: string) => void) {
  const onSelectProject = vi.fn()
  render(
    <I18nProvider>
      <ProjectsView projects={PROJECTS} currentRoot={currentRoot} onSelectProject={onSelectProject} onToast={onToast} />
    </I18nProvider>,
  )
  return onSelectProject
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('项目页 · 指令文件', () => {
  it('左列有用户级与各项目；点用户级切到空 root', async () => {
    const user = userEvent.setup()
    stubFetch()
    const onSelectProject = renderView()
    expect(await screen.findByTestId('proj-user')).toBeInTheDocument()
    expect(screen.getByTestId('proj-root-repo')).toBeInTheDocument()
    await user.click(screen.getByTestId('proj-user'))
    expect(onSelectProject).toHaveBeenCalledWith('')
  })

  it('宿主行显示两级加载标签；aider 无复选框', async () => {
    stubFetch()
    renderView()
    expect(await screen.findByTestId('proj-levels-claude')).toHaveTextContent('叠加')
    expect(screen.getByTestId('proj-levels-zed')).toHaveTextContent('项目优先')
    expect(screen.getByTestId('proj-levels-copilot')).toHaveTextContent('个人优先')
    expect(screen.getByTestId('proj-levels-cursor')).toHaveTextContent('仅项目')
    expect(screen.getByTestId('proj-levels-aider')).toHaveTextContent('需配置')
    // 不可勾选的宿主放禁用复选框占位，勾选列不跳。
    expect(screen.getByTestId('proj-host-check-aider')).toBeDisabled()
    expect(screen.getByTestId('proj-host-check-aider')).not.toBeChecked()
    expect(screen.getByTestId('proj-host-check-claude')).toBeChecked()
    expect(screen.getByTestId('proj-host-check-codex')).toBeChecked()
  })

  it('应用：预览打开差异抽屉，确认后按 base_digest 写入两个文件', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    const onToast = vi.fn()
    renderView('/repo', onToast)
    const editor = await screen.findByTestId('proj-editor')
    await user.clear(editor)
    await user.type(editor, '# 新规则')
    await user.click(screen.getByTestId('proj-apply'))
    const drawer = await screen.findByTestId('proj-diff')
    expect(within(drawer).getByTestId('proj-diff-AGENTS.md')).toBeInTheDocument()
    expect(within(drawer).getByTestId('proj-diff-CLAUDE.md')).toBeInTheDocument()
    expect(drawer.querySelectorAll('[data-op="add"]').length).toBeGreaterThan(0)
    // 标题是相对项目根的文件名，完整绝对路径只在 title 与副行里。
    expect(within(drawer).getByTestId('proj-diff-name-AGENTS.md')).toHaveTextContent(/^AGENTS\.md$/u)
    expect(within(drawer).getByTestId('proj-diff-name-AGENTS.md')).toHaveAttribute('title', '/repo/AGENTS.md')
    await user.click(screen.getByTestId('proj-diff-confirm'))
    await waitFor(() => {
      const apply = calls.find((call) => call.url === '/api/instructions/apply')
      expect(JSON.parse(String(apply?.init?.body))).toMatchObject({
        root: '/repo',
        text: '# 新规则',
        targets: [{ id: 'CLAUDE.md', base_digest: 'absent' }, { id: 'AGENTS.md', base_digest: 'sha256:AGENTS.md' }],
      })
    })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已应用'))
  })

  it('应用返回 409 → 显示外部修改，并能重新载入', async () => {
    const user = userEvent.setup()
    stubFetch({
      onWrite: ({ url }) => (url === '/api/instructions/apply'
        ? { ok: false, status: 409, json: async () => ({ ok: false, code: 'instruction-file-changed', error: 'server prose', id: 'AGENTS.md', digest: 'sha256:other' }) }
        : undefined),
    })
    renderView()
    await user.type(await screen.findByTestId('proj-editor'), 'x')
    await user.click(screen.getByTestId('proj-apply'))
    await user.click(await screen.findByTestId('proj-diff-confirm'))
    expect(await screen.findByTestId('proj-external')).toBeInTheDocument()
    expect(screen.getByTestId('proj-error')).toHaveTextContent('文件已被外部修改')
    expect(screen.getByTestId('proj-error')).not.toHaveTextContent('server prose')
    expect(screen.getByTestId('proj-external-reload')).toBeInTheDocument()
  })

  it('删除：确认对话框列出目标并写受管块保留数，确认后发 DELETE', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({
      targets: () => [target('AGENTS.md', { managed: [{ tag: 'CODEX' }] }), target('CLAUDE.md')],
    })
    renderView()
    await user.click(await screen.findByTestId('proj-more'))
    await user.click(screen.getByTestId('proj-more-delete'))
    const dialog = await screen.findByTestId('proj-delete-dialog')
    expect(within(dialog).getByTestId('proj-delete-managed')).toHaveTextContent('1')
    await user.click(screen.getByTestId('proj-delete-confirm'))
    await waitFor(() => {
      const deletes = calls.filter((call) => call.init?.method === 'DELETE')
      expect(deletes.map((call) => call.url)).toEqual([
        '/api/instructions?root=%2Frepo&target=CLAUDE.md&digest=sha256%3ACLAUDE.md',
        '/api/instructions?root=%2Frepo&target=AGENTS.md&digest=sha256%3AAGENTS.md',
      ])
    })
  })

  // 复查走 window focus：与快照变化同一条 check() 路径。
  it('聚焦复查：编辑器干净时静默换成盘上内容；有草稿时只亮外部修改', async () => {
    const user = userEvent.setup()
    let text = '# 旧\n'
    stubFetch({ targets: () => [target('AGENTS.md', { text, digest: `sha256:${text}` }), target('CLAUDE.md', { exists: false, digest: 'absent', text: '' })] })
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 旧\n'))

    text = '# 别人改了\n'
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 别人改了\n'))
    expect(screen.queryByTestId('proj-external')).toBeNull()

    await user.type(screen.getByTestId('proj-editor'), '我的草稿')
    text = '# 又改了\n'
    window.dispatchEvent(new Event('focus'))
    expect(await screen.findByTestId('proj-external')).toBeInTheDocument()
    expect(screen.getByTestId('proj-editor')).toHaveValue('# 别人改了\n我的草稿')
  })

  // 回归：停在项目页、快照没变时每 ~4 秒请求一次 /api/instructions（60 秒 14 次）。
  it('停留时不重复请求；只在快照变化时复查一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = stubFetch()
    const reads = (): number => calls.filter((call) => call.url.startsWith('/api/instructions?') && (call.init?.method ?? 'GET') === 'GET').length
    const view = (revision: string) => (
      <I18nProvider>
        <ProjectsView projects={PROJECTS} currentRoot="/repo" onSelectProject={() => undefined} snapshotRevision={revision} />
      </I18nProvider>
    )
    const { rerender } = render(view('r1'))
    await screen.findByTestId('proj-editor')
    expect(reads()).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    rerender(view('r1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(reads()).toBe(1)

    rerender(view('r2'))
    await waitFor(() => expect(reads()).toBe(2))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(reads()).toBe(2)
  })

  it('无 token 时应用与删除都禁用', async () => {
    ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = ''
    stubFetch()
    renderView()
    expect(await screen.findByTestId('proj-apply')).toBeDisabled()
    expect(screen.getByTestId('proj-more')).toBeDisabled()
    expect(screen.getByTestId('proj-no-token')).toBeInTheDocument()
  })
})

describe('项目页 · 布局与读取', () => {
  it('右列没有眉题；标题右侧是「预览变更」与 ⋯；页签是 编辑 / 渲染；抽屉里确认「应用」', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    await screen.findByTestId('proj-editor')
    expect(screen.queryByTestId('proj-eyebrow')).toBeNull()
    expect(screen.getByTestId('proj-title')).toHaveTextContent('repo')
    expect(screen.getByTestId('proj-apply')).toHaveTextContent('预览变更')
    expect(screen.getByTestId('proj-tab-edit')).toHaveTextContent('编辑')
    expect(screen.getByTestId('proj-tab-render')).toHaveTextContent('渲染')
    // 没有底部动作条：动作只在标题行。
    expect(screen.getByTestId('proj-detail').querySelector('footer')).toBeNull()
    await user.click(screen.getByTestId('proj-apply'))
    expect(await screen.findByTestId('proj-diff-confirm')).toHaveTextContent('应用')
  })

  it('所选文件都与正文一致时「预览变更」禁用，改动后才可用', async () => {
    const user = userEvent.setup()
    stubFetch({ targets: () => [target('AGENTS.md'), target('CLAUDE.md')] })
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 旧\n'))
    expect(screen.getByTestId('proj-apply')).toBeDisabled()
    await user.type(editor, 'x')
    expect(screen.getByTestId('proj-apply')).toBeEnabled()
    await user.type(editor, '{Backspace}')
    expect(screen.getByTestId('proj-apply')).toBeDisabled()
  })

  it('宿主表是 宿主 · 文件 · 加载方式 三列，宿主名只出现一次，加载方式不是药丸', async () => {
    stubFetch()
    renderView()
    const table = await screen.findByTestId('proj-hosts')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['选择', '宿主', '文件', '加载方式'])
    const row = screen.getByTestId('proj-host-claude')
    expect(row.textContent?.match(/claude/gu)).toHaveLength(1)
    expect(screen.getByTestId('proj-levels-claude').className).not.toContain('rounded-full')
  })

  it('读取中显示骨架而不是文字', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, level: 'project', root: '/repo', hosts: HOSTS, targets: [target('AGENTS.md')] }) }
    }))
    renderView()
    const loading = screen.getByTestId('proj-loading')
    expect(loading.textContent).toBe('')
    expect(loading.querySelectorAll('li').length).toBeGreaterThan(0)
    await act(async () => { release() })
    expect(await screen.findByTestId('proj-hosts')).toBeInTheDocument()
  })

  it('左列副行是缩短的路径', async () => {
    stubFetch()
    render(
      <I18nProvider>
        <ProjectsView
          projects={[{ root: '/Users/me/Documents/code/tenon', name: 'tenon', count: 0, ok: true }]}
          currentRoot="/Users/me/Documents/code/tenon"
          onSelectProject={() => undefined}
        />
      </I18nProvider>,
    )
    expect(await screen.findByTestId('proj-root-tenon')).toHaveTextContent('~/…/code/tenon')
    // 完整路径挂在副行的 title 上；图标是语义图标，不是首字母。
    expect(screen.getByTestId('proj-root-tenon-meta')).toHaveAttribute('title', '/Users/me/Documents/code/tenon')
    expect(screen.getByTestId('proj-root-tenon-mark').querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('proj-root-tenon-mark')).not.toHaveTextContent('T')
  })

  it('「新建项目」是左列标题行的「+」，不在底部动作条', async () => {
    stubFetch()
    render(
      <I18nProvider>
        <ProjectsView projects={[]} currentRoot="" onSelectProject={() => undefined} />
      </I18nProvider>,
    )
    const button = await screen.findByTestId('proj-new')
    expect(button).toHaveAccessibleName('新建项目')
    expect(button.className.split(/\s+/u)).toContain('size-10')
    const rail = screen.getByTestId('projects-rail')
    expect(rail.querySelector('ul')?.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  // 回归：进入项目页 /api/instructions 发两次——首读未回时快照变化或聚焦又触发一次复查。
  it('进入项目页只读一次：首读期间的聚焦、以及早于首读的快照版本都不再请求', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, level: 'project', root: '/repo', hosts: HOSTS, targets: [target('AGENTS.md')] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const old = new Date(Date.now() - 60_000).toISOString()
    const view = (revision: string) => (
      <I18nProvider>
        <ProjectsView projects={PROJECTS} currentRoot="/repo" onSelectProject={() => undefined} snapshotRevision={revision} />
      </I18nProvider>
    )
    const { rerender } = render(view('r0'))
    window.dispatchEvent(new Event('focus'))
    rerender(view('r1'))
    await act(async () => { release() })
    await screen.findByTestId('proj-editor')
    // 快照版本早于这次读：读到的已经包含那次变化。
    rerender(view(old))
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('diffFileLabel', () => {
  it('项目内文件取相对项目根的路径，用户级文件取文件名', () => {
    expect(diffFileLabel('/Users/me/very/long/workspace/repo/AGENTS.md', '/Users/me/very/long/workspace/repo')).toBe('AGENTS.md')
    expect(diffFileLabel('/repo/docs/CLAUDE.md', '/repo/')).toBe('docs/CLAUDE.md')
    expect(diffFileLabel('/Users/me/.claude/CLAUDE.md', '')).toBe('CLAUDE.md')
    expect(diffFileLabel('/elsewhere/GEMINI.md', '/repo')).toBe('GEMINI.md')
  })
})
