import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { LibraryView } from './LibraryView'

const digest = (char: string): string => `sha256:${char.repeat(64)}`

const BUILTIN = {
  name: 'security', source: 'builtin', role: 'reviewer', version: '1.0.0', description: '安全评审', skills: ['tenon-verify'],
  tools: ['Read', 'Grep'], model: 'opus', hosts: ['claude-code'], digest: digest('1'),
}
const CUSTOM = {
  name: 'mine', source: 'custom', role: 'reviewer', version: '0.1.0', description: '我的', skills: [], tools: ['Read'], digest: digest('2'),
}
const MAKER = { ...CUSTOM, name: 'maker', role: 'executor', tools: ['Read', 'Write'], digest: digest('4') }
const TEAM = { ...CUSTOM, name: 'team', source: 'project', version: '2.0.0', description: '团队', digest: digest('5') }

const body = (name: string): string => `---\nname: ${name}\ndescription: d\nrole: reviewer\ntools: [Read]\n---\n\n## ${name}\n`

const REFERENCE = { workflow: 'default', track: null, step: 'verify', label: '验证', role: 'reviewer' }
const RUN = {
  change: 'demo', step: 'verify', role: 'reviewer', status: 'finished', result: 'pass', findings: 2,
  started_at: '2026-09-20T01:00:00Z', finished_at: '2026-09-20T01:05:00Z',
  subagent: { host: 'claude', type: 'tenon-security', native: true },
}

type Row = Record<string, unknown>

function stubFetch(
  calls: Array<[string, string, string]>,
  options: { readonly rows?: readonly Row[]; readonly mutation?: (method: string, url: string) => Response | null } = {},
): void {
  const rows = options.rows ?? [BUILTIN, CUSTOM]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push([method, url, typeof init?.body === 'string' ? init.body : ''])
    const custom = options.mutation?.(method, url) ?? null
    if (custom !== null) return custom
    const path = url.split('?')[0] ?? url
    if (path === '/api/agents' && method === 'GET') {
      return new Response(JSON.stringify({ ok: true, agents: rows }), { status: 200 })
    }
    if (path.startsWith('/api/agents/') && method === 'GET') {
      const name = path.slice('/api/agents/'.length)
      const entry = rows.find((row) => row.name === name && row.source !== 'custom') ?? rows.find((row) => row.name === name) ?? CUSTOM
      return new Response(JSON.stringify({
        ok: true, name: entry.name, source: entry.source, content: body(String(entry.name)), digest: entry.digest,
        references: entry.name === 'security' ? [REFERENCE] : [],
        runs: entry.name === 'security' ? [RUN] : [],
      }), { status: 200 })
    }
    if (url.startsWith('/api/agents')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
    if (url.startsWith('/api/instruction-templates')) {
      return new Response(JSON.stringify({ ok: true, templates: [], sync: { state: 'unchanged' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, templates: [], directions: [] }), { status: 200 })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

async function openAgents(root = ''): Promise<void> {
  window.__TENON_DASHBOARD_TOKEN__ = 'tok'
  render(<I18nProvider><LibraryView root={root} /></I18nProvider>)
  await userEvent.click(screen.getByTestId('lib-section-agents'))
  await waitFor(() => expect(screen.getByTestId('lib-agents')).toBeTruthy())
}

describe('智能体库（只展示与编辑正文）', () => {
  it('没有新建入口；按文件声明的身份分段；行尾是来源与版本（纯文字，不换行）', async () => {
    stubFetch([], { rows: [BUILTIN, CUSTOM, MAKER] })
    await openAgents()
    expect(screen.queryByTestId('lib-agent-new')).toBeNull()
    const executors = screen.getByTestId('lib-agents-executor')
    const reviewers = screen.getByTestId('lib-agents-reviewer')
    expect(executors).toHaveTextContent('执行者')
    expect(executors.querySelector('[data-testid="lib-agent-custom-maker"]')).not.toBeNull()
    expect(reviewers.querySelector('[data-testid="lib-agent-builtin-security"]')).not.toBeNull()
    expect(reviewers.querySelector('[data-testid="lib-agent-custom-mine"]')).not.toBeNull()
    expect(screen.getByTestId('lib-agent-source-builtin-security')).toHaveTextContent('官方')
    expect(screen.getByTestId('lib-agent-source-custom-mine')).toHaveTextContent('自定义')
    expect(screen.getByTestId('lib-agent-version-security')).toHaveTextContent('1.0.0')
    // 行尾是纯文字：不换行、不是方框芯片。
    const meta = screen.getByTestId('lib-agent-source-builtin-security').parentElement
    expect(meta?.className).toContain('whitespace-nowrap')
    expect(screen.getByTestId('lib-agent-source-builtin-security').className.split(/\s+/u).filter((name) => /^(?:border|round)/u.test(name))).toEqual([])
  })

  it('选中项目时带 root 读项目层；项目级与自定义同名时自定义置灰，详情是项目级', async () => {
    const calls: Array<[string, string, string]> = []
    stubFetch(calls, { rows: [BUILTIN, { ...TEAM, source: 'custom', shadowed_by: 'project', digest: digest('6') }, TEAM] })
    await openAgents('/work/app')
    expect(calls.some(([method, url]) => method === 'GET' && url === '/api/agents?root=%2Fwork%2Fapp')).toBe(true)
    expect(screen.getByTestId('lib-agent-source-project-team')).toHaveTextContent('项目')
    expect(screen.getByTestId('lib-agent-source-custom-team').className).toContain('line-through')
    await userEvent.click(screen.getByTestId('lib-agent-project-team'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-source')).toHaveTextContent('项目'))
    expect(screen.getByTestId('lib-agent-project-team')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('lib-agent-custom-team')).not.toHaveAttribute('aria-current')
  })

  it('官方详情：只读只有复制，字段表含身份与版本，正文渲染，引用与最近运行逐行列出', async () => {
    stubFetch([])
    await openAgents('/work/app')
    await userEvent.click(screen.getByTestId('lib-agent-builtin-security'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('security'))
    expect(screen.getByTestId('lib-agent-source')).toHaveTextContent('官方')
    expect(screen.queryByTestId('lib-agent-save')).toBeNull()
    expect(screen.queryByTestId('lib-agent-more')).toBeNull()
    expect(screen.queryByTestId('lib-agent-sheets')).toBeNull()
    expect(screen.getByTestId('lib-agent-copy')).toHaveTextContent('复制为自定义')
    expect(screen.getByTestId('lib-agent-field-role')).toHaveTextContent('评审者')
    expect(screen.getByTestId('lib-agent-field-version')).toHaveTextContent('1.0.0')
    expect(screen.getByTestId('lib-agent-field-skills').textContent).toContain('tenon-verify')
    expect(screen.getByTestId('lib-agent-preview')).toBeInTheDocument()
    expect(screen.getByTestId('lib-agent-references').textContent).toContain('default / 验证')
    const run = screen.getByTestId('lib-agent-run')
    expect(run).toHaveTextContent('demo')
    expect(run).toHaveTextContent('通过')
    expect(run).toHaveTextContent('tenon-security')
    for (const cell of run.querySelectorAll('td')) expect(cell.className).toContain('whitespace-nowrap')
  })

  it('没有任何智能体时给出可复制的 tenon agent new 命令', async () => {
    stubFetch([], { rows: [] })
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    render(<I18nProvider><LibraryView /></I18nProvider>)
    await userEvent.click(screen.getByTestId('lib-section-agents'))
    expect(await screen.findByTestId('lib-agent-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-agent-new-command-text')).toHaveTextContent('tenon agent new')
    expect(screen.getByTestId('lib-agent-new-command-copy')).toBeInTheDocument()
  })

  it('自定义可保存正文（带摘要）、复制、删除；项目级保存带 source 与 root', async () => {
    const calls: Array<[string, string, string]> = []
    stubFetch(calls, { rows: [BUILTIN, CUSTOM, TEAM] })
    await openAgents('/work/app')
    await userEvent.click(screen.getByTestId('lib-agent-custom-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('mine'))
    await userEvent.click(screen.getByTestId('lib-agent-tab-edit'))
    await userEvent.type(screen.getByTestId('lib-agent-content'), 'x')
    await userEvent.click(screen.getByTestId('lib-agent-save'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url === '/api/agents/mine')).toBe(true))
    const put = calls.find(([method, url]) => method === 'PUT' && url === '/api/agents/mine')
    expect(JSON.parse(put?.[2] ?? '{}')).toMatchObject({ digest: CUSTOM.digest })

    await userEvent.click(screen.getByTestId('lib-agent-project-team'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('team'))
    await userEvent.click(screen.getByTestId('lib-agent-tab-edit'))
    await userEvent.type(screen.getByTestId('lib-agent-content'), 'y')
    await userEvent.click(screen.getByTestId('lib-agent-save'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url === '/api/agents/team')).toBe(true))
    const projectPut = calls.find(([method, url]) => method === 'PUT' && url === '/api/agents/team')
    expect(JSON.parse(projectPut?.[2] ?? '{}')).toMatchObject({ source: 'project', root: '/work/app' })

    await userEvent.click(screen.getByTestId('lib-agent-more'))
    await userEvent.click(screen.getByTestId('lib-agent-more-delete'))
    await userEvent.click(await screen.findByTestId('lib-delete-confirm'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'DELETE'
      && url.startsWith('/api/agents/team?digest=') && url.includes('source=project'))).toBe(true))
  })

  it('删除自定义智能体也带当前项目的 root：server 据此看项目级工作流里的引用（真机验收 F1）', async () => {
    const calls: Array<[string, string, string]> = []
    stubFetch(calls, { rows: [BUILTIN, CUSTOM, TEAM] })
    await openAgents('/work/app')
    await userEvent.click(screen.getByTestId('lib-agent-custom-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('mine'))
    await userEvent.click(screen.getByTestId('lib-agent-more'))
    await userEvent.click(screen.getByTestId('lib-agent-more-delete'))
    await userEvent.click(await screen.findByTestId('lib-delete-confirm'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'DELETE'
      && url.startsWith('/api/agents/mine?digest=') && url.includes('root=%2Fwork%2Fapp') && !url.includes('source='))).toBe(true))
  })

  it('删除被引用的智能体：409 的引用位置显示在详情页', async () => {
    stubFetch([], {
      mutation: (method) => (method === 'DELETE'
        ? new Response(JSON.stringify({
          ok: false, code: 'agent-referenced', error: 'agent 被工作流引用', references: [REFERENCE],
        }), { status: 409 })
        : null),
    })
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-custom-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-more')).toBeTruthy())
    await userEvent.click(screen.getByTestId('lib-agent-more'))
    await userEvent.click(screen.getByTestId('lib-agent-more-delete'))
    await userEvent.click(await screen.findByTestId('lib-delete-confirm'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-error').textContent).toContain('被工作流引用'))
    expect(screen.getByTestId('lib-agent-references').textContent).toContain('验证')
  })

  it('保存失败时显示 server 的原文', async () => {
    stubFetch([], {
      mutation: (method) => (method === 'PUT'
        ? new Response(JSON.stringify({ ok: false, error: "agent 'mine' 的 frontmatter 缺 description" }), { status: 400 })
        : null),
    })
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-custom-mine'))
    await userEvent.click(await screen.findByTestId('lib-agent-tab-edit'))
    await userEvent.type(screen.getByTestId('lib-agent-content'), 'x')
    await userEvent.click(screen.getByTestId('lib-agent-save'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-error').textContent).toContain('缺 description'))
  })

  it('复制为自定义：名字不重名（security-copy），选中后直接进入编辑页签', async () => {
    let copied = false
    stubFetch([], {
      mutation: (method, url) => {
        if (method === 'POST' && url === '/api/agents/security/copy') {
          copied = true
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url === '/api/agents' && method === 'GET' && copied) {
          return new Response(JSON.stringify({ ok: true, agents: [BUILTIN, CUSTOM, { ...CUSTOM, name: 'security-copy' }] }), { status: 200 })
        }
        if (url === '/api/agents/security-copy' && method === 'GET') {
          return new Response(JSON.stringify({ ok: true, name: 'security-copy', source: 'custom', content: body('security-copy'), digest: digest('3'), references: [] }), { status: 200 })
        }
        return null
      },
    })
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-builtin-security'))
    await userEvent.click(await screen.findByTestId('lib-agent-copy'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-custom-security-copy')).toHaveAttribute('aria-current', 'true'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-tab-edit')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByTestId('lib-agent-content')).toBeInTheDocument()
  })

  it('右列不留空：没选中时打开列表第一行（先执行者）；搜索筛掉选中项时换第一行', async () => {
    stubFetch([], { rows: [BUILTIN, CUSTOM, MAKER] })
    await openAgents()
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('maker'))
    expect(screen.getByTestId('lib-agent-custom-maker')).toHaveAttribute('aria-current', 'true')
    await userEvent.type(screen.getByTestId('library-list-search'), '安全')
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('security'))
    expect(screen.queryByTestId('lib-agent-custom-mine')).toBeNull()
  })

  it('窗口重新获得焦点时重读列表（终端里刚登记的智能体随即出现）', async () => {
    const calls: Array<[string, string, string]> = []
    stubFetch(calls)
    await openAgents()
    const before = calls.filter(([method, url]) => method === 'GET' && url === '/api/agents').length
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(calls.filter(([method, url]) => method === 'GET' && url === '/api/agents').length).toBe(before + 1))
  })

  it('读取中显示骨架与「–」计数，不显示「没有智能体」', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      await gate
      const url = String(input)
      if (url === '/api/agents') return new Response(JSON.stringify({ ok: true, agents: [] }), { status: 200 })
      if (url.startsWith('/api/instruction-templates')) {
        return new Response(JSON.stringify({ ok: true, templates: [], sync: { state: 'unchanged' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, templates: [], directions: [] }), { status: 200 })
    })
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    render(<I18nProvider><LibraryView /></I18nProvider>)
    await userEvent.click(screen.getByTestId('lib-section-agents'))
    expect(screen.getByTestId('lib-agent-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('lib-agent-empty')).toBeNull()
    expect(screen.getByTestId('lib-section-agents')).toHaveTextContent('–')
    release()
    expect(await screen.findByTestId('lib-agent-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-agent-detail-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-section-agents')).toHaveTextContent('0')
  })
})
