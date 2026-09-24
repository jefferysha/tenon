import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { LibraryView } from './LibraryView'

const digest = (char: string): string => `sha256:${char.repeat(64)}`

const BUILTIN = {
  name: 'security', source: 'builtin', description: '安全评审', skills: ['tenon-verify'],
  tools: ['Read', 'Grep'], model: 'opus', hosts: ['claude-code'], digest: digest('1'),
}
const CUSTOM = {
  name: 'mine', source: 'custom', description: '我的', skills: [], tools: ['Read'], digest: digest('2'),
}

const body = (name: string): string => `---\nname: ${name}\ndescription: d\ntools: [Read]\n---\n\n## ${name}\n`

const REFERENCE = { workflow: 'default', track: null, step: 'verify', label: '验证', role: 'reviewer' }

function stubFetch(
  calls: Array<[string, string]>,
  mutation?: (method: string, url: string) => Response | null,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push([method, url])
    const custom = mutation?.(method, url) ?? null
    if (custom !== null) return custom
    if (url === '/api/agents' && method === 'GET') {
      return new Response(JSON.stringify({ ok: true, agents: [BUILTIN, CUSTOM] }), { status: 200 })
    }
    if (url.startsWith('/api/agents/') && method === 'GET') {
      const name = url.slice('/api/agents/'.length)
      const entry = name === 'security' ? BUILTIN : CUSTOM
      return new Response(JSON.stringify({
        ok: true, name: entry.name, source: entry.source, content: body(entry.name), digest: entry.digest,
        references: entry.name === 'security' ? [REFERENCE] : [],
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

async function openAgents(): Promise<void> {
  window.__TENON_DASHBOARD_TOKEN__ = 'tok'
  render(<I18nProvider><LibraryView /></I18nProvider>)
  await userEvent.click(screen.getByTestId('lib-section-agents'))
  await waitFor(() => expect(screen.getByTestId('lib-agent-security')).toBeTruthy())
}

describe('agent 库', () => {
  it('列出内建与自定义；内建只有复制，引用位置逐行列出', async () => {
    stubFetch([])
    await openAgents()
    expect(screen.getByTestId('lib-agent-mine')).toBeTruthy()
    await userEvent.click(screen.getByTestId('lib-agent-security'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-title').textContent).toBe('security'))
    expect(screen.queryByTestId('lib-agent-save')).toBeNull()
    expect(screen.queryByTestId('lib-agent-more')).toBeNull()
    // 内建只有一个视图：不渲染页签；「内建」只用锁图标表示，没有药丸。
    expect(screen.queryByTestId('lib-agent-sheets')).toBeNull()
    expect(screen.getByTestId('lib-agent-builtin')).toHaveAttribute('aria-label', '内建')
    expect(screen.getByTestId('lib-agent-copy')).toHaveTextContent('复制为自定义')
    expect(screen.queryByTestId('lib-agent-eyebrow')).toBeNull()
    expect(screen.getByTestId('lib-agent-field-skills').textContent).toContain('tenon-verify')
    expect(screen.getByTestId('lib-agent-references').textContent).toContain('default / 验证')
  })

  it('新建写 POST /api/agents，复制写 <name>-copy，自定义可保存与删除', async () => {
    const calls: Array<[string, string]> = []
    stubFetch(calls)
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-new'))
    await userEvent.type(screen.getByTestId('lib-agent-new-name'), 'fresh')
    await userEvent.click(screen.getByTestId('lib-agent-new-confirm'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'POST' && url === '/api/agents')).toBe(true))

    await userEvent.click(screen.getByTestId('lib-agent-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-copy')).toBeTruthy())
    await userEvent.click(screen.getByTestId('lib-agent-copy'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'POST' && url === '/api/agents/mine/copy')).toBe(true))

    await userEvent.click(screen.getByTestId('lib-agent-tab-edit'))
    await userEvent.type(screen.getByTestId('lib-agent-content'), 'x')
    await userEvent.click(screen.getByTestId('lib-agent-save'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'PUT' && url === '/api/agents/mine')).toBe(true))
    await userEvent.click(screen.getByTestId('lib-agent-more'))
    await userEvent.click(screen.getByTestId('lib-agent-more-delete'))
    expect(await screen.findByTestId('lib-delete-dialog')).toBeInTheDocument()
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false)
    await userEvent.click(screen.getByTestId('lib-delete-confirm'))
    await waitFor(() => expect(calls.some(([method, url]) => method === 'DELETE' && url.startsWith('/api/agents/mine?digest='))).toBe(true))
  })

  it('删除被引用的 agent：409 的引用位置显示在详情页', async () => {
    stubFetch([], (method) => (method === 'DELETE'
      ? new Response(JSON.stringify({
        ok: false, code: 'agent-referenced', error: 'agent 被工作流引用', references: [REFERENCE],
      }), { status: 409 })
      : null))
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-mine'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-more')).toBeTruthy())
    await userEvent.click(screen.getByTestId('lib-agent-more'))
    await userEvent.click(screen.getByTestId('lib-agent-more-delete'))
    await userEvent.click(await screen.findByTestId('lib-delete-confirm'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-error').textContent).toContain('被工作流引用'))
    expect(screen.getByTestId('lib-agent-references').textContent).toContain('验证')
  })

  it('保存失败时显示 server 的原文', async () => {
    stubFetch([], (method) => (method === 'PUT'
      ? new Response(JSON.stringify({ ok: false, error: "agent 'mine' 的 frontmatter 缺 description" }), { status: 400 })
      : null))
    await openAgents()
    await userEvent.click(screen.getByTestId('lib-agent-mine'))
    await userEvent.click(screen.getByTestId('lib-agent-tab-edit'))
    await userEvent.type(screen.getByTestId('lib-agent-content'), 'x')
    await userEvent.click(screen.getByTestId('lib-agent-save'))
    await waitFor(() => expect(screen.getByTestId('lib-agent-error').textContent).toContain('缺 description'))
  })

  it('列表按执行者 / 评审者分两段：能写文件的是执行者', async () => {
    stubFetch([], (method, url) => (method === 'GET' && url === '/api/agents'
      ? new Response(JSON.stringify({ ok: true, agents: [BUILTIN, CUSTOM, { ...CUSTOM, name: 'maker', tools: ['Read', 'Write', 'Edit'] }] }), { status: 200 })
      : null))
    await openAgents()
    const executors = screen.getByTestId('lib-agents-executor')
    const reviewers = screen.getByTestId('lib-agents-reviewer')
    expect(executors).toHaveTextContent('执行者')
    expect(executors.querySelector('[data-testid="lib-agent-maker"]')).not.toBeNull()
    expect(reviewers).toHaveTextContent('评审者')
    expect(reviewers.querySelector('[data-testid="lib-agent-security"]')).not.toBeNull()
    expect(reviewers.querySelector('[data-testid="lib-agent-mine"]')).not.toBeNull()
    // 内建行只有锁图标，不再另写「内建」药丸；自定义行不带标记。
    expect(screen.getByTestId('lib-agent-builtin-security')).toBeInTheDocument()
    expect(screen.queryByTestId('lib-agent-builtin-mine')).toBeNull()
    expect(screen.getByTestId('lib-agent-security').textContent).not.toContain('内建')
  })

  it('读取中显示骨架与「–」计数，不显示「没有智能体」和新建按钮', async () => {
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
    expect(screen.queryByTestId('lib-agent-new')).toBeNull()
    expect(screen.getByTestId('lib-section-agents')).toHaveTextContent('–')
    release()
    expect(await screen.findByTestId('lib-agent-empty')).toBeInTheDocument()
    expect(screen.getByTestId('lib-agent-new')).toBeInTheDocument()
    expect(screen.getByTestId('lib-section-agents')).toHaveTextContent('0')
  })
})
