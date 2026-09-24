import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WbStepDef, WbWorkflowDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { WorkflowView } from './WorkflowView'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

function stage(id: string, label: string, next: string | null): WbStepDef {
  return { id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: next === null ? [] : [{ event: `${id}-complete`, to: next }] }
}

const FLOW: WbWorkflowDef = {
  name: 'flow',
  steps: [],
  tracks: {
    alpha: { label: '甲', steps: [stage('a1', '一', 'a2'), stage('a2', '二', null)] },
    beta: { label: '乙', steps: [stage('b1', '起', 'b2'), stage('b2', '承', 'b3'), stage('b3', '转', null)] },
  },
}

function stubApi(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/workflows?root=') return new Response(JSON.stringify({ names: ['flow'], default: { source: 'builtin' } }), { status: 200 })
    if (url === '/api/workflows/flow?root=') return new Response(JSON.stringify(FLOW), { status: 200 })
    if (url === '/api/agents') return new Response(JSON.stringify({ agents: [] }), { status: 200 })
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), { status: 404 })
  }))
}

beforeEach(() => {
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'test-token'
  stubApi()
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

describe('WorkflowView · URL 记住工作流 / 轨道 / 阶段', () => {
  it('深链 ?wf=&track=&step= 直接落到那个阶段', async () => {
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><WorkflowView root="" /></I18nProvider>)
    expect(await screen.findByTestId('wb-step-b2')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('wb-track-beta')).toHaveAttribute('aria-selected', 'true')
    expect(params().get('view')).toBe('workbench')
  })

  it('深链点名的工作流不存在：按缺省落，并把 URL 改成实际选择', async () => {
    window.history.replaceState(null, '', '/?view=workbench&wf=ghost&step=zz')
    render(<I18nProvider><WorkflowView root="" /></I18nProvider>)
    expect(await screen.findByTestId('wb-step-a1')).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(params().get('wf')).toBe('flow'))
    expect(params().get('step')).toBe('a1')
  })

  it('换轨道、选阶段都写回 URL（replace，不加历史项），外部 query 原样保留', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&debug=1')
    const length = window.history.length
    render(<I18nProvider><WorkflowView root="" /></I18nProvider>)
    await screen.findByTestId('wb-step-a1')
    await waitFor(() => expect(params().get('wf')).toBe('flow'))
    expect(params().get('track')).toBe('alpha')
    await user.click(screen.getByTestId('wb-track-beta'))
    await user.click(await screen.findByTestId('wb-step-b3'))
    await waitFor(() => expect(params().get('step')).toBe('b3'))
    expect(params().get('track')).toBe('beta')
    expect(params().get('debug')).toBe('1')
    expect(window.history.length).toBe(length)
  })
})

describe('WorkflowView · 删除阶段', () => {
  it('左栏阶段 ⋯ → 删除阶段 → 确认框（标题点名）→ 阶段消失，保存条写出改动数', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><WorkflowView root="" /></I18nProvider>)
    await user.click(await screen.findByTestId('wb-stage-menu-b2'))
    await user.click(screen.getByTestId('wb-stage-delete-b2'))
    expect(screen.getByTestId('stage-delete-dialog')).toHaveTextContent('删除「承」？')
    await user.click(screen.getByTestId('stage-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('wb-step-b2')).toBeNull())
    expect(screen.getByTestId('wb-dirty').textContent).toMatch(/^未保存 \d+ 处$/u)
  })

  it('取消确认框不删', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?view=workbench&wf=flow&track=beta&step=b2')
    render(<I18nProvider><WorkflowView root="" /></I18nProvider>)
    await user.click(await screen.findByTestId('wb-stage-menu-b2'))
    await user.click(screen.getByTestId('wb-stage-delete-b2'))
    await user.click(screen.getByTestId('stage-delete-cancel'))
    expect(screen.queryByTestId('stage-delete-dialog')).toBeNull()
    expect(screen.getByTestId('wb-step-b2')).toBeInTheDocument()
  })
})
