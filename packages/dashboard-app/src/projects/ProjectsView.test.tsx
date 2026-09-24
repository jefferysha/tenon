import type { ReactElement } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Flip } from 'gsap/Flip'
import { I18nProvider } from '../i18n'
import { SLIDING_INDICATOR_CLS } from '../shared/useSlidingIndicator'
import { TooltipProvider } from '@/components/ui/tooltip'
import { diffFileLabel } from './DiffDrawer'
import { ProjectsView } from './ProjectsView'

const PROJECTS = [{ root: '/repo', name: 'repo', count: 1, ok: true }]
const CLIENTS_KEY = 'tenon-dashboard-clients:/repo'

const PROJECT_HOSTS = [
  { id: 'claude', levels: 'joined', target: 'CLAUDE.md' },
  { id: 'codex', levels: 'joined', target: 'AGENTS.md' },
  { id: 'gemini', levels: 'joined', target: 'GEMINI.md' },
  { id: 'copilot', levels: 'user-wins', target: 'AGENTS.md' },
  { id: 'cursor', levels: 'project-only', target: 'AGENTS.md' },
  { id: 'zed', levels: 'project-wins', target: 'AGENTS.md', effective_file: 'AGENTS.md' },
  { id: 'cline', levels: 'joined', target: 'AGENTS.md' },
  { id: 'aider', levels: 'needs-config', target: null },
]

const USER_PATHS: Record<string, string> = {
  claude: '/home/me/.claude/CLAUDE.md',
  codex: '/home/me/.codex/AGENTS.md',
  gemini: '/home/me/.gemini/GEMINI.md',
  zed: '/home/me/.config/zed/AGENTS.md',
  cline: '/home/me/.agents/AGENTS.md',
}
const USER_HOSTS = PROJECT_HOSTS.map((host) => ({ id: host.id, levels: host.levels, target: host.id in USER_PATHS ? host.id : null }))

const target = (id: string, over: Record<string, unknown> = {}) => ({
  id, path: `/repo/${id}`, exists: true, digest: `sha256:${id}`, text: '# 旧\n', managed: [], bytes: 6, error: null, ...over,
})
const missing = (id: string) => target(id, { exists: false, digest: 'absent', text: '', bytes: 0 })
const userTarget = (id: string, over: Record<string, unknown> = {}) =>
  target(id, { path: USER_PATHS[id], text: `# 用户 ${id}\n`, digest: `sha256:user-${id}`, ...over })

interface Call { url: string; init?: RequestInit }

function stubFetch(over: { targets?: () => unknown[]; userTargets?: () => unknown[]; onWrite?: (call: Call) => unknown } = {}) {
  const calls: Call[] = []
  const targets = over.targets ?? (() => [target('AGENTS.md'), missing('CLAUDE.md'), missing('GEMINI.md')])
  const userTargets = over.userTargets ?? (() => Object.keys(USER_PATHS).map((id) => userTarget(id)))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/instructions?') && method === 'GET') {
      const user = new URL(url, 'http://x').searchParams.get('root') === ''
      return {
        ok: true,
        json: async () => (user
          ? { ok: true, level: 'user', root: '', hosts: USER_HOSTS, targets: userTargets() }
          : { ok: true, level: 'project', root: '/repo', hosts: PROJECT_HOSTS, targets: targets() }),
      }
    }
    if (url === '/api/instructions/preview') {
      const body = JSON.parse(String(init?.body)) as { root: string; text: string; targets: string[] }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          files: body.targets.map((id) => ({
            id, path: body.root === '' ? USER_PATHS[id] : `/repo/${id}`, base_digest: `sha256:${id}`, current: '# 旧\n', next: body.text,
          })),
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

const wrap = (node: ReactElement) => <I18nProvider><TooltipProvider>{node}</TooltipProvider></I18nProvider>

function renderView(currentRoot = '/repo', onToast?: (message: string) => void) {
  const onSelectProject = vi.fn()
  render(wrap(<ProjectsView projects={PROJECTS} currentRoot={currentRoot} onSelectProject={onSelectProject} onToast={onToast} />))
  return onSelectProject
}

const reads = (calls: Call[], root: string): number =>
  calls.filter((call) => call.url === `/api/instructions?root=${encodeURIComponent(root)}` && (call.init?.method ?? 'GET') === 'GET').length

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('项目页 · 左列与客户端', () => {
  it('左列只有项目，没有「用户级」项', async () => {
    const user = userEvent.setup()
    stubFetch()
    const onSelectProject = renderView()
    expect(await screen.findByTestId('proj-root-repo')).toBeInTheDocument()
    expect(screen.queryByTestId('proj-user')).toBeNull()
    expect(screen.getByTestId('projects-rail')).not.toHaveTextContent('用户级')
    await user.click(screen.getByTestId('proj-root-repo'))
    expect(onSelectProject).toHaveBeenCalledWith('/repo')
  })

  it('只显示已启用的客户端：没有记录时按已存在的文件推导', async () => {
    stubFetch({ targets: () => [target('AGENTS.md'), target('CLAUDE.md'), missing('GEMINI.md')] })
    renderView()
    expect(await screen.findByTestId('proj-client-claude')).toBeInTheDocument()
    expect(screen.getByTestId('proj-client-codex')).toBeInTheDocument()
    expect(screen.queryByTestId('proj-client-gemini')).toBeNull()
    expect(screen.queryByTestId('proj-client-copilot')).toBeNull()
    expect(screen.getByTestId('proj-clients').querySelectorAll('li')).toHaveLength(2)
    // 不再有平铺全部客户端的表。
    expect(screen.queryByTestId('proj-hosts')).toBeNull()
    expect(screen.queryByTestId('proj-files')).toBeNull()
  })

  it('名称只显示一个：显示名 + 真实文件名，不出现宿主 id', async () => {
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['claude']))
    stubFetch()
    renderView()
    const row = await screen.findByTestId('proj-client-claude')
    expect(row).toHaveTextContent('Claude Code')
    expect(screen.getByTestId('proj-client-claude-file')).toHaveTextContent(/^CLAUDE\.md$/u)
    expect(row.textContent).not.toMatch(/claude/u)
    expect(row.textContent?.match(/Claude Code/gu)).toHaveLength(1)
  })

  it('添加客户端：菜单只列未启用的；需配置的置灰；选中后启用并选中，记在本机', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    await screen.findByTestId('proj-client-codex')
    await user.click(screen.getByTestId('proj-add-client'))
    const menu = await screen.findByTestId('proj-add-client-menu')
    expect(within(menu).queryByTestId('proj-add-codex')).toBeNull()
    expect(within(menu).getByTestId('proj-add-claude')).toHaveTextContent('Claude Code')
    expect(within(menu).getByTestId('proj-add-claude')).toHaveTextContent('CLAUDE.md')
    expect(within(menu).getByTestId('proj-add-aider')).toHaveAttribute('data-disabled')
    await user.click(within(menu).getByTestId('proj-add-claude'))
    const row = await screen.findByTestId('proj-client-claude')
    expect(row).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('proj-title')).toHaveTextContent('Claude Code')
    expect(JSON.parse(localStorage.getItem(CLIENTS_KEY) ?? '[]')).toEqual(['codex', 'claude'])
  })

  it('需配置的客户端：菜单里置灰、不能启用，原因在 Tooltip', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    await screen.findByTestId('proj-client-codex')
    await user.click(screen.getByTestId('proj-add-client'))
    const aider = await screen.findByTestId('proj-add-aider')
    await user.hover(within(aider).getByText('Aider'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('需在其配置里用 read: 指定文件')
    await user.click(aider)
    expect(screen.queryByTestId('proj-client-aider')).toBeNull()
    expect(localStorage.getItem(CLIENTS_KEY)).toBeNull()
  })

  it('停用客户端：⋯ → 停用，行消失，文件不动', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['claude', 'codex']))
    const calls = stubFetch()
    renderView()
    await user.click(await screen.findByTestId('proj-client-codex-more'))
    await user.click(await screen.findByTestId('proj-disable-codex'))
    await waitFor(() => expect(screen.queryByTestId('proj-client-codex')).toBeNull())
    expect(screen.getByTestId('proj-client-claude')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(CLIENTS_KEY) ?? '[]')).toEqual(['claude'])
    expect(calls.some((call) => call.init?.method === 'DELETE' || call.url === '/api/instructions/apply')).toBe(false)
  })

  it('共享同一文件的客户端合并成一行，「+n」标出其余读者', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['codex', 'zed', 'cline']))
    stubFetch()
    renderView()
    const row = await screen.findByTestId('proj-client-codex')
    expect(screen.queryByTestId('proj-client-zed')).toBeNull()
    expect(screen.queryByTestId('proj-client-cline')).toBeNull()
    const readers = within(row).getByTestId('proj-client-codex-readers')
    expect(readers).toHaveTextContent('+2')
    expect(readers).toHaveAccessibleName('读取：Codex, Zed, Cline')
    // ⋯ 里逐个停用。
    await user.click(within(row).getByTestId('proj-client-codex-more'))
    expect(await screen.findByTestId('proj-disable-zed')).toHaveTextContent('停用 Zed')
  })

  it('状态点 + 一个词：一致 / 缺失；改动后行与标题都变成不同', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['codex', 'claude']))
    stubFetch()
    renderView()
    const codex = await screen.findByTestId('proj-client-codex-status')
    expect(screen.getByTestId('proj-client-claude-status')).toHaveTextContent('缺失')
    expect(screen.getByTestId('proj-client-claude-status')).toHaveAttribute('data-tone', 'neutral')
    await user.click(screen.getByTestId('proj-client-codex-select'))
    await waitFor(() => expect(codex).toHaveTextContent('一致'))
    expect(codex).toHaveAttribute('data-tone', 'done')
    expect(screen.getByTestId('proj-status')).toHaveTextContent('一致')
    await user.type(screen.getByTestId('proj-editor'), 'x')
    expect(screen.getByTestId('proj-client-codex-status')).toHaveTextContent('不同')
    expect(screen.getByTestId('proj-status')).toHaveTextContent('不同')
    expect(screen.getByTestId('proj-status')).toHaveAttribute('data-tone', 'pending')
  })

  it('受管块数是标题旁的计数徽标', async () => {
    stubFetch({ targets: () => [target('AGENTS.md', { managed: [{ tag: 'CODEX' }, { tag: 'TENON' }] }), missing('CLAUDE.md'), missing('GEMINI.md')] })
    renderView()
    const managed = await screen.findByTestId('proj-managed')
    expect(managed).toHaveTextContent('2')
    expect(managed).toHaveAccessibleName('受管块 2')
  })
})

describe('项目页 · 作用域', () => {
  it('项目级 / 用户级切换加载对应文件；用户级文件名是真实文件名', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 旧\n'))
    expect(screen.getByTestId('proj-path')).toHaveTextContent('/repo/AGENTS.md')
    await user.click(screen.getByTestId('proj-scope-tab-user'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 用户 codex\n'))
    expect(screen.getByTestId('proj-scope-tab-user')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('proj-path')).toHaveTextContent('/home/me/.codex/AGENTS.md')
    expect(screen.getByTestId('proj-title')).toHaveTextContent('Codex')
    // 删除确认里是文件名 AGENTS.md，不是宿主 id codex。
    await user.click(screen.getByTestId('proj-more'))
    await user.click(screen.getByTestId('proj-more-delete'))
    expect(await screen.findByTestId('proj-delete-file')).toHaveTextContent(/^AGENTS\.md$/u)
    await user.click(screen.getByTestId('proj-delete-cancel'))
    await user.click(screen.getByTestId('proj-scope-tab-project'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 旧\n'))
  })

  it('用户级应用写到 root 为空、目标为客户端的文件', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    renderView()
    await screen.findByTestId('proj-editor')
    await user.click(screen.getByTestId('proj-scope-tab-user'))
    const editor = screen.getByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 用户 codex\n'))
    await user.type(editor, 'y')
    await user.click(screen.getByTestId('proj-apply'))
    const drawer = await screen.findByTestId('proj-diff')
    expect(within(drawer).getByTestId('proj-diff-name-codex')).toHaveTextContent(/^AGENTS\.md$/u)
    await user.click(screen.getByTestId('proj-diff-confirm'))
    await waitFor(() => {
      const apply = calls.find((call) => call.url === '/api/instructions/apply')
      expect(JSON.parse(String(apply?.init?.body))).toEqual({ root: '', text: '# 用户 codex\ny', targets: [{ id: 'codex', base_digest: 'sha256:codex' }] })
    })
  })

  it('合并的一组在用户级下按读者分段切换各自的文件', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['codex', 'cline', 'copilot']))
    stubFetch()
    renderView()
    await screen.findByTestId('proj-editor')
    expect(screen.queryByTestId('proj-reader-sheets')).toBeNull()
    await user.click(screen.getByTestId('proj-scope-tab-user'))
    const readers = await screen.findByTestId('proj-reader-sheets')
    // copilot 没有用户级文件，不在读者里。
    expect(within(readers).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Codex', 'Cline'])
    await user.click(screen.getByTestId('proj-reader-tab-cline'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 用户 cline\n'))
    expect(screen.getByTestId('proj-path')).toHaveTextContent('/home/me/.agents/AGENTS.md')
    expect(screen.getByTestId('proj-title')).toHaveTextContent('Cline')
  })

  it('没有用户级文件的客户端：「用户级」置灰，点了不切换', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['copilot']))
    stubFetch()
    renderView()
    const userTab = await screen.findByTestId('proj-scope-tab-user')
    await waitFor(() => expect(userTab).toHaveAttribute('aria-disabled', 'true'))
    await user.click(userTab)
    expect(screen.getByTestId('proj-scope-tab-project')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('proj-path')).toHaveTextContent('/repo/AGENTS.md')
  })

  it('切换作用域保留各自的草稿', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 旧\n'))
    await user.type(editor, '项目草稿')
    await user.click(screen.getByTestId('proj-scope-tab-user'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 用户 codex\n'))
    await user.click(screen.getByTestId('proj-scope-tab-project'))
    expect(screen.getByTestId('proj-editor')).toHaveValue('# 旧\n项目草稿')
  })
})

describe('项目页 · 编辑与写入', () => {
  it('应用：预览打开差异抽屉，确认后按 base_digest 写入当前文件', async () => {
    const user = userEvent.setup()
    const calls = stubFetch()
    const onToast = vi.fn()
    renderView('/repo', onToast)
    const editor = await screen.findByTestId('proj-editor')
    await user.clear(editor)
    await user.type(editor, '# 新规则')
    await user.click(screen.getByTestId('proj-apply'))
    const drawer = await screen.findByTestId('proj-diff')
    expect(drawer.querySelectorAll('[data-op="add"]').length).toBeGreaterThan(0)
    expect(within(drawer).getByTestId('proj-diff-name-AGENTS.md')).toHaveTextContent(/^AGENTS\.md$/u)
    expect(within(drawer).getByTestId('proj-diff-name-AGENTS.md')).toHaveAttribute('title', '/repo/AGENTS.md')
    await user.click(screen.getByTestId('proj-diff-confirm'))
    await waitFor(() => {
      const apply = calls.find((call) => call.url === '/api/instructions/apply')
      expect(JSON.parse(String(apply?.init?.body))).toEqual({
        root: '/repo', text: '# 新规则', targets: [{ id: 'AGENTS.md', base_digest: 'sha256:AGENTS.md' }],
      })
    })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已应用'))
  })

  it('应用返回 409 → 显示外部修改；重新载入丢掉草稿换成盘上内容', async () => {
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
    await user.click(screen.getByTestId('proj-diff-cancel'))
    await user.click(screen.getByTestId('proj-external-reload'))
    await waitFor(() => expect(screen.getByTestId('proj-editor')).toHaveValue('# 旧\n'))
    expect(screen.queryByTestId('proj-external')).toBeNull()
  })

  it('删除：确认对话框写文件名与受管块保留数，确认后只删当前文件', async () => {
    const user = userEvent.setup()
    const calls = stubFetch({ targets: () => [target('AGENTS.md', { managed: [{ tag: 'CODEX' }] }), target('CLAUDE.md'), missing('GEMINI.md')] })
    renderView()
    await screen.findByTestId('proj-client-codex')
    await user.click(screen.getByTestId('proj-client-codex-select'))
    await user.click(screen.getByTestId('proj-more'))
    await user.click(screen.getByTestId('proj-more-delete'))
    const dialog = await screen.findByTestId('proj-delete-dialog')
    expect(within(dialog).getByTestId('proj-delete-file')).toHaveTextContent('AGENTS.md')
    expect(within(dialog).getByTestId('proj-delete-managed')).toHaveTextContent('1')
    await user.click(screen.getByTestId('proj-delete-confirm'))
    await waitFor(() => {
      const deletes = calls.filter((call) => call.init?.method === 'DELETE')
      expect(deletes.map((call) => call.url)).toEqual(['/api/instructions?root=%2Frepo&target=AGENTS.md&digest=sha256%3AAGENTS.md'])
    })
  })

  // 复查走 window focus：与快照变化同一条 check() 路径。
  it('聚焦复查：编辑器干净时静默换成盘上内容；有草稿时只亮外部修改', async () => {
    const user = userEvent.setup()
    let text = '# 旧\n'
    stubFetch({ targets: () => [target('AGENTS.md', { text, digest: `sha256:${text}` }), missing('CLAUDE.md')] })
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
  it('停留时不重复请求；只在快照变化时每个作用域复查一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = stubFetch()
    const view = (revision: string) => wrap(
      <ProjectsView projects={PROJECTS} currentRoot="/repo" onSelectProject={() => undefined} snapshotRevision={revision} />,
    )
    const { rerender } = render(view('r1'))
    await screen.findByTestId('proj-editor')
    expect([reads(calls, '/repo'), reads(calls, '')]).toEqual([1, 1])

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    rerender(view('r1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect([reads(calls, '/repo'), reads(calls, '')]).toEqual([1, 1])

    rerender(view('r2'))
    await waitFor(() => expect([reads(calls, '/repo'), reads(calls, '')]).toEqual([2, 2]))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect([reads(calls, '/repo'), reads(calls, '')]).toEqual([2, 2])
  })

  it('无 token 时应用与删除都禁用', async () => {
    ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = ''
    stubFetch()
    renderView()
    expect(await screen.findByTestId('proj-apply')).toBeDisabled()
    expect(screen.getByTestId('proj-more')).toBeDisabled()
    expect(screen.getByTestId('proj-no-token')).toBeInTheDocument()
  })

  it('与盘上一致时「预览变更」禁用，改动后才可用', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    await waitFor(() => expect(editor).toHaveValue('# 旧\n'))
    expect(screen.getByTestId('proj-apply')).toBeDisabled()
    await user.type(editor, 'x')
    expect(screen.getByTestId('proj-apply')).toBeEnabled()
    await user.type(editor, '{Backspace}')
    expect(screen.getByTestId('proj-apply')).toBeDisabled()
  })
})

describe('项目页 · 布局与读取', () => {
  it('右列没有眉题；标题右侧是「预览变更」与 ⋯；页签是 编辑 / 渲染；抽屉里确认「应用」', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    expect(screen.queryByTestId('proj-eyebrow')).toBeNull()
    expect(screen.getByTestId('proj-title')).toHaveTextContent('Codex')
    expect(screen.getByTestId('proj-apply')).toHaveTextContent('预览变更')
    expect(screen.getByTestId('proj-tab-edit')).toHaveTextContent('编辑')
    expect(screen.getByTestId('proj-tab-render')).toHaveTextContent('渲染')
    expect(screen.getByTestId('proj-detail').querySelector('footer')).toBeNull()
    await user.type(editor, 'x')
    await user.click(screen.getByTestId('proj-apply'))
    expect(await screen.findByTestId('proj-diff-confirm')).toHaveTextContent('应用')
  })

  it('读取中显示骨架而不是文字', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inner = stubFetch()
    void inner
    const stubbed = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
      await gate
      return stubbed(...args)
    }))
    renderView()
    const loading = screen.getByTestId('proj-loading')
    expect(loading.textContent).toBe('')
    expect(loading.querySelectorAll('li').length).toBeGreaterThan(0)
    await act(async () => { release() })
    expect(await screen.findByTestId('proj-clients')).toBeInTheDocument()
  })

  it('左列副行是缩短的路径', async () => {
    stubFetch()
    render(wrap(
      <ProjectsView
        projects={[{ root: '/Users/me/Documents/code/tenon', name: 'tenon', count: 0, ok: true }]}
        currentRoot="/Users/me/Documents/code/tenon"
        onSelectProject={() => undefined}
      />,
    ))
    expect(await screen.findByTestId('proj-root-tenon')).toHaveTextContent('~/…/code/tenon')
    expect(screen.getByTestId('proj-root-tenon-meta')).toHaveAttribute('title', '/Users/me/Documents/code/tenon')
    expect(screen.getByTestId('proj-root-tenon-mark').querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('proj-root-tenon-mark')).not.toHaveTextContent('T')
  })

  it('「新建项目」是左列标题行的「+」；没有项目时不读指令文件', async () => {
    const calls = stubFetch()
    render(wrap(<ProjectsView projects={[]} currentRoot="" onSelectProject={() => undefined} />))
    const button = await screen.findByTestId('proj-new')
    expect(button).toHaveAccessibleName('新建项目')
    expect(button.className.split(/\s+/u)).toContain('size-10')
    const rail = screen.getByTestId('projects-rail')
    const list = rail.querySelector('ul')
    if (list === null) throw new Error('rail list missing')
    expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.queryByTestId('proj-add-client')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  // 回归：进入项目页 /api/instructions 发两次——首读未回时快照变化或聚焦又触发一次复查。
  it('进入项目页每个作用域只读一次：首读期间的聚焦、以及早于首读的快照版本都不再请求', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls = stubFetch()
    const stubbed = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
      await gate
      return stubbed(...args)
    }))
    const old = new Date(Date.now() - 60_000).toISOString()
    const view = (revision: string) => wrap(
      <ProjectsView projects={PROJECTS} currentRoot="/repo" onSelectProject={() => undefined} snapshotRevision={revision} />,
    )
    const { rerender } = render(view('r0'))
    window.dispatchEvent(new Event('focus'))
    rerender(view('r1'))
    await act(async () => { release() })
    await screen.findByTestId('proj-editor')
    rerender(view(old))
    await act(async () => { await Promise.resolve() })
    expect([reads(calls, '/repo'), reads(calls, '')]).toEqual([1, 1])
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

describe('项目页 · 控件外观', () => {
  it('选中行用共享的列表选中态', async () => {
    const { LIST_SELECTED } = await import('../shared/uiRecipes')
    stubFetch()
    renderView()
    const row = await screen.findByTestId('proj-client-codex')
    for (const cls of LIST_SELECTED.split(' ')) expect(row.className).toContain(cls)
    expect(screen.getByTestId('proj-client-codex-select')).toHaveAttribute('aria-current', 'true')
  })

  it('编辑 / 渲染 是分段控件：滑块随选中移动，方向键切换', async () => {
    const user = userEvent.setup()
    stubFetch()
    renderView()
    await screen.findByTestId('proj-editor')
    const list = screen.getByTestId('proj-sheets')
    expect(list.className).toContain('bg-fill')
    expect(list.className).not.toContain('border-b')
    const thumb = screen.getByTestId('proj-thumb')
    expect(thumb.className.split(' ')).toEqual(expect.arrayContaining([...SLIDING_INDICATOR_CLS.split(' '), 'bg-card', 'shadow-sm']))
    expect(thumb).toHaveAttribute('data-placed', 'true')
    expect(thumb.style.transform).toBe('')
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const from = vi.spyOn(Flip, 'from')
    screen.getByTestId('proj-tab-edit').focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByTestId('proj-tab-render')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('proj-tab-render')).toHaveFocus()
    await act(async () => { await Promise.resolve() })
    expect(from).toHaveBeenCalledTimes(1)
    expect(from.mock.calls[0]?.[1]).toMatchObject({ duration: 0.18, ease: 'power3.out' })
    expect(screen.getByTestId('proj-render')).toBeInTheDocument()
  })

  it('作用域分段：方向键跳过置灰的段', async () => {
    const user = userEvent.setup()
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(['copilot']))
    stubFetch()
    renderView()
    const project = await screen.findByTestId('proj-scope-tab-project')
    await waitFor(() => expect(screen.getByTestId('proj-scope-tab-user')).toHaveAttribute('aria-disabled', 'true'))
    project.focus()
    await user.keyboard('{ArrowRight}')
    expect(project).toHaveAttribute('aria-selected', 'true')
    expect(project).toHaveFocus()
  })

  it('编辑区无拖拽角、卡片底、等宽，高度随内容', async () => {
    stubFetch()
    renderView()
    const editor = await screen.findByTestId('proj-editor')
    for (const cls of ['resize-none', 'bg-card', 'border-border', 'rounded-md', 'font-mono', 'text-body', 'p-4']) expect(editor.className).toContain(cls)
    expect(editor.className).not.toContain('resize-y')
    await waitFor(() => expect(editor.style.height).toMatch(/px$/u))
  })

  it('详情空态不写字（可访问名称仍在）', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    renderView()
    const empty = screen.getByTestId('proj-detail-empty')
    expect(empty.textContent).toBe('')
    expect(empty).toHaveAttribute('aria-label', '添加客户端')
  })
})
