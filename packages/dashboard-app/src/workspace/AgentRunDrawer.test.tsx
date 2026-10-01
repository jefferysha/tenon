import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import type { AgentRunView } from '../types'
import { AgentRunDrawer, hostRunPending } from './AgentRunDrawer'

const ROOT = '/Users/me/code/repo'
const CANDIDATE = `sha256:${'1a2b3c4d'.repeat(8)}`

function reviewer(over: Partial<AgentRunView> = {}): AgentRunView {
  return {
    agent: 'architecture', role: 'reviewer', required: true, blockAt: 'high', dependsOn: [], readsTests: [],
    state: 'idle', result: null, findings: 0, blocking: 0, runId: null, reportPath: null, actor: null, finishedAt: null,
    requiredHost: 'codex', host: null, hostSource: null, wrongHost: false, candidate: null,
    ...over,
  }
}

function mount(agent: AgentRunView, over: { runnable?: boolean; change?: string } = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <AgentRunDrawer root={ROOT} change={over.change ?? 'add-login'} runnable={over.runnable ?? true} agent={agent} onClose={() => {}} />
      </TooltipProvider>
    </I18nProvider>,
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('hostRunPending · 要求的宿主上还没有有效运行', () => {
  it('没有宿主要求：恒为 false（执行者与不限宿主的评审者）', () => {
    expect(hostRunPending(reviewer({ requiredHost: null }))).toBe(false)
    expect(hostRunPending(reviewer({ requiredHost: undefined, state: 'idle' }))).toBe(false)
  })

  it('从没运行 / 过期（宿主不符，或代码变了）/ 正在别的宿主上跑：true', () => {
    expect(hostRunPending(reviewer({ state: 'idle' }))).toBe(true)
    expect(hostRunPending(reviewer({ state: 'stale', wrongHost: true, host: 'claude' }))).toBe(true)
    expect(hostRunPending(reviewer({ state: 'stale', host: 'codex' }))).toBe(true)
    expect(hostRunPending(reviewer({ state: 'running', host: 'claude' }))).toBe(true)
    expect(hostRunPending(reviewer({ state: 'running', host: null }))).toBe(true)
  })

  it('已有有效结论，或正在要求的宿主上跑：false', () => {
    expect(hostRunPending(reviewer({ state: 'done', result: 'pass', host: 'codex' }))).toBe(false)
    expect(hostRunPending(reviewer({ state: 'running', host: 'codex' }))).toBe(false)
  })
})

describe('AgentRunDrawer · 宿主一行与启动命令', () => {
  it('要求了宿主、还没运行：登记的宿主是「—」，旁边是要求的宿主名 + 小「要求」标记（不是药丸）', () => {
    mount(reviewer())
    const host = screen.getByTestId('agent-run-host')
    expect(within(host).getByTestId('agent-run-host-recorded')).toHaveTextContent('—')
    const required = within(host).getByTestId('agent-run-host-required')
    expect(required).toHaveTextContent('codex')
    expect(within(required).getByTestId('agent-run-host-required-mark')).toHaveTextContent('要求')
    expect(required).toHaveAttribute('title', expect.stringContaining('codex'))
    expect(host).toHaveTextContent('宿主— · codex要求')
    expect(within(host).queryByTestId('agent-run-host-mismatch')).toBeNull()
    const mark = within(required).getByTestId('agent-run-host-required-mark')
    expect(mark.className).not.toMatch(/rounded|\bbg-|\bborder\b/u)
    expect(screen.getByTestId('agent-run-binding').textContent).not.toMatch(/[。.]$/u)
  })

  it('还没运行：旁边是可复制的 `tenon agent prompt <change> <agent>`（先 cd 到项目，同下一步面板的命令块）', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount(reviewer())
    const row = screen.getByTestId('agent-run-command-row')
    expect(within(row).getByRole('rowheader')).toHaveTextContent('命令')
    const text = screen.getByTestId('agent-run-command-text')
    expect(text.textContent).toBe(`cd ${ROOT} && tenon agent prompt add-login architecture`)
    expect(text).toHaveAttribute('title', `cd ${ROOT} && tenon agent prompt add-login architecture`)
    expect(text.className).toContain('whitespace-nowrap')
    expect(text.className).toContain('truncate')
    // 与宿主一行相邻：宿主行之后紧跟命令行。
    const rows = within(screen.getByTestId('agent-run-binding')).getAllByRole('row')
    expect(rows.map((item) => item.getAttribute('data-testid'))).toEqual(['agent-run-host', 'agent-run-command-row'])
    await userEvent.click(screen.getByTestId('agent-run-command-copy'))
    expect(writeText).toHaveBeenCalledWith(`cd ${ROOT} && tenon agent prompt add-login architecture`)
  })

  it('命令里的路径与名字按 shell 转义', () => {
    mount(reviewer({ agent: 'arch itecture' }), { change: "it's-a-change" })
    expect(screen.getByTestId('agent-run-command-text').textContent).toBe(`cd ${ROOT} && tenon agent prompt 'it'\\''s-a-change' 'arch itecture'`)
  })

  it('宿主不符：保留红点 + 「宿主不符」，登记的宿主与要求的宿主各自可见，命令仍在', () => {
    mount(reviewer({ state: 'stale', host: 'claude', hostSource: 'detected', wrongHost: true, candidate: CANDIDATE }))
    const host = screen.getByTestId('agent-run-host')
    expect(within(host).getByTestId('agent-run-host-recorded')).toHaveTextContent('claude')
    const mismatch = within(host).getByTestId('agent-run-host-mismatch')
    expect(mismatch).toHaveAttribute('data-tone', 'blocked')
    expect(mismatch).toHaveTextContent('宿主不符')
    expect(mismatch).toHaveAttribute('title', 'codex')
    expect(within(host).getByTestId('agent-run-host-required')).toHaveTextContent('codex要求')
    expect(screen.getByTestId('agent-run-command-text').textContent).toContain('tenon agent prompt add-login architecture')
  })

  it('要求的宿主上已有有效运行：只显示一次宿主名（带「要求」标记），命令消失', () => {
    mount(reviewer({
      state: 'done', result: 'pass', host: 'codex', hostSource: 'detected', candidate: CANDIDATE, runId: 'r1', actor: { id: 'a@x.io', name: 'Ann' }, finishedAt: '2026-09-20T02:00:00Z',
    }))
    const host = screen.getByTestId('agent-run-host')
    expect(host).toHaveTextContent('宿主codex要求')
    expect(within(host).getAllByText(/codex/u)).toHaveLength(1)
    expect(within(host).queryByTestId('agent-run-host-recorded')).toBeNull()
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
  })

  it('正在要求的宿主上运行：不给命令；正在别的宿主上跑：给', () => {
    const { unmount } = mount(reviewer({ state: 'running', host: 'codex', hostSource: 'detected' }))
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
    unmount()
    mount(reviewer({ state: 'running', host: 'claude', hostSource: 'detected' }))
    expect(screen.getByTestId('agent-run-command-row')).toBeInTheDocument()
  })

  it('不是任务的当前步骤（或已归档）：只展示宿主要求，不给命令——那条命令此刻跑不了', () => {
    mount(reviewer(), { runnable: false })
    expect(within(screen.getByTestId('agent-run-host')).getByTestId('agent-run-host-required')).toHaveTextContent('codex要求')
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
  })

  it('没有宿主要求的评审者：没有「要求」标记，也没有命令', () => {
    mount(reviewer({ requiredHost: null, host: 'claude', hostSource: 'detected', state: 'idle' }))
    expect(screen.queryByTestId('agent-run-host-required')).toBeNull()
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
    expect(screen.getByTestId('agent-run-host')).toHaveTextContent('宿主claude')
  })

  it('英文界面：标记是 required、命令行表头是 Command；命令本身不翻译', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    mount(reviewer())
    expect(screen.getByTestId('agent-run-host')).toHaveTextContent('Host— · codexrequired')
    expect(within(screen.getByTestId('agent-run-command-row')).getByRole('rowheader')).toHaveTextContent('Command')
    expect(screen.getByTestId('agent-run-command-text').textContent).toBe(`cd ${ROOT} && tenon agent prompt add-login architecture`)
  })

  it('Dashboard 不运行它：复制之外没有任何请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true })
    mount(reviewer())
    await userEvent.click(screen.getByTestId('agent-run-command-copy'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
